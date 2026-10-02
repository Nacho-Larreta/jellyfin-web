import { getAuthorizationHeader } from '@jellyfin/sdk/lib/utils';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { appHost } from 'components/apphost';
import { playbackManager } from 'components/playback/playbackmanager';

import { type PlaybackQuiescePort, type PreparedReportDeadline } from './coordinator';
import { assertSessionEnvelope, isJellyfinItemId, type ActiveProfileSession, type PendingPlaybackStop, type PlaybackQuiesceResult } from './model';

interface Player {
    readonly isLocalPlayer: boolean;
    readonly name: string;
    readonly _castPlayer?: { readonly session?: unknown };
    isPlaying?(): boolean;
    readonly currentSrc?: unknown;
    readonly getPlaylist?: unknown;
    currentItem?(): unknown;
    getPlayerState?(): unknown;
}

interface PlaybackManagerPort {
    getProfileSwitchPlaybackStatus(player: Player | null): 'Idle' | 'Active' | 'Pending' | 'RecoveryRequired' | 'Unknown';
    getCurrentPlayer(): Player | null;
    getPlayers(): readonly Player[];
    currentItem(player: Player): unknown;
    playSessionId(player: Player): unknown;
    getPlayerState(player: Player): unknown;
    isPlaying(player: Player): boolean | undefined;
    stopForProfileSwitch(player: Player, itemId: string, playSessionId: string): Promise<unknown>;
}

interface ApiClient {
    getUrl(path: string): string;
    serverId(): string;
    serverAddress(): string;
    deviceId(): string;
    getCurrentUserId(): string | null;
    accessToken(): string | null;
}

interface PlaybackConnections {
    getApiClient(serverId: string): ApiClient | null;
    getSessionSwitchEnvelope(serverId: string): unknown;
}

interface ClientIdentity {
    appName(): string;
    appVersion(): string;
    deviceName(): string;
}

interface PlaybackReport {
    readonly ItemId: string;
    readonly PlaySessionId: string;
    readonly PositionTicks: number;
    readonly Failed: false;
    readonly NextMediaType: null;
}

interface CapturedPlayback {
    readonly session: ActiveProfileSession;
    readonly player: Player;
    readonly report: PendingPlaybackStop;
    stopped: boolean;
}

interface CaptureDecision {
    readonly outcome: 'Captured' | 'NotActive' | 'Failed';
    readonly capture?: CapturedPlayback;
}

interface PlaybackTransport {
    (url: string, authorization: string, report: PlaybackReport, timeoutMs: number): Promise<unknown>;
}

const STOP_TIMEOUT_MS = 5_000;
const REPORT_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WebPlaybackQuiescePort implements PlaybackQuiescePort {
    private readonly captures = new Map<string, CapturedPlayback>();

    constructor(
        private readonly manager: PlaybackManagerPort,
        private readonly connections: PlaybackConnections,
        private readonly identity: ClientIdentity,
        private readonly transport: PlaybackTransport = postPlaybackStop
    ) {}

    async capture(session: ActiveProfileSession, switchId: string): Promise<
        { readonly outcome: 'NotActive' | 'Failed' } |
        { readonly outcome: 'Captured'; readonly report: PendingPlaybackStop }> {
        try {
            if (!UUID.test(switchId)) return { outcome: 'Failed' };
            const decision = this.getOrCapture(session, switchId);
            if (decision.outcome === 'Captured' && decision.capture) {
                return { outcome: 'Captured', report: decision.capture.report };
            }
            return { outcome: decision.outcome === 'NotActive' ? 'NotActive' : 'Failed' };
        } catch {
            return { outcome: 'Failed' };
        }
    }

    async stopAndReport(
        session: ActiveProfileSession,
        switchId: string,
        persisted: PendingPlaybackStop,
        deadline: PreparedReportDeadline
    ): Promise<PlaybackQuiesceResult> {
        try {
            if (!this.matchesVerifiedAuthority(session, switchId, persisted)
                || !this.beforeExpiry(deadline)
                || !await this.stopCapturedPlayer(session, switchId, persisted, deadline)
                || !this.beforeExpiry(deadline)
                || !this.matchesVerifiedAuthority(session, switchId, persisted)
                || !this.matchesDurablePendingReport(session, switchId, persisted)) return { outcome: 'Failed' };
            return await this.sendCapturedReport(session, persisted);
        } catch {
            return { outcome: 'Failed' };
        }
    }

    releaseCapture(switchId: string): void {
        this.captures.delete(switchId);
    }

    private beforeExpiry(deadline: PreparedReportDeadline): boolean {
        return Number.isSafeInteger(deadline.wallMs) && Number.isFinite(deadline.monotonicMs)
            && Date.now() < deadline.wallMs && performance.now() < deadline.monotonicMs;
    }

    private matchesVerifiedAuthority(
        session: ActiveProfileSession,
        switchId: string,
        report: PendingPlaybackStop
    ): boolean {
        const client = this.connections.getApiClient(session.serverId);
        return !!client && UUID.test(switchId)
            && client.serverId() === session.serverId && client.deviceId() === session.deviceId
            && client.getCurrentUserId() === session.profileUserId
            && client.accessToken() === session.credentialRef.token
            && client.serverAddress() === report.serverAddress
            && client.getUrl(`ProfileSelectors/Current/Switches/${switchId}/PlaybackStopped`) === report.endpointUrl
            && reportKey(switchId, report.playSessionId) === report.reportKey;
    }

    private matchesDurablePendingReport(
        session: ActiveProfileSession,
        switchId: string,
        report: PendingPlaybackStop
    ): boolean {
        const envelope = this.connections.getSessionSwitchEnvelope(session.serverId);
        assertSessionEnvelope(envelope);
        const marker = envelope.marker;
        return sameSession(envelope.activeSession, session)
            && marker?.kind === 'PendingSwitch'
            && marker.phase === 'Quiescing'
            && marker.switchId === switchId
            && marker.playbackReport?.status === 'Captured'
            && sameReport(marker.playbackReport, report);
    }

    private async stopCapturedPlayer(
        session: ActiveProfileSession,
        switchId: string,
        report: PendingPlaybackStop,
        deadline: PreparedReportDeadline
    ): Promise<boolean> {
        const captured = this.captures.get(switchId);
        if (captured && (!sameSession(captured.session, session)
            || !sameReport(captured.report, report))) return false;
        const player = captured?.player ?? this.manager.getCurrentPlayer();
        const item = player ? this.manager.currentItem(player) : null;
        if (player && item != null && (!isRecord(item) || item.Id !== report.itemId
            || this.manager.playSessionId(player) !== report.playSessionId
            || !player.isLocalPlayer || !this.otherPlayersInactive(player))) return false;
        if (player && item != null && !captured?.stopped) {
            if (!this.beforeExpiry(deadline)) return false;
            await within(this.manager.stopForProfileSwitch(player, report.itemId, report.playSessionId), STOP_TIMEOUT_MS);
            if (captured) captured.stopped = true;
        }
        return this.proveNoPlayback(this.manager.getCurrentPlayer());
    }

    private async sendCapturedReport(
        session: ActiveProfileSession,
        persisted: PendingPlaybackStop
    ): Promise<PlaybackQuiesceResult> {
        const authorization = getAuthorizationHeader(
            { name: persisted.appName, version: persisted.appVersion },
            { id: session.deviceId, name: persisted.deviceName },
            session.credentialRef.token
        );
        const report: PlaybackReport = {
            ItemId: persisted.itemId,
            PlaySessionId: persisted.playSessionId,
            PositionTicks: persisted.positionTicks,
            Failed: false,
            NextMediaType: null
        };
        const result = await within(
            this.transport(persisted.endpointUrl, authorization, report, REPORT_TIMEOUT_MS),
            REPORT_TIMEOUT_MS
        );
        if (!isRecord(result) || result.ReportKey !== persisted.reportKey
            || !this.proveNoPlayback(this.manager.getCurrentPlayer())) return { outcome: 'Failed' };
        if (result.Outcome === 'Acknowledged') {
            return { outcome: 'Acknowledged', reportKey: persisted.reportKey };
        }
        return { outcome: result.Outcome === 'NotActive' ? 'NotActive' : 'Failed' };
    }

    private getOrCapture(session: ActiveProfileSession, switchId: string): CaptureDecision {
        const status = this.manager.getProfileSwitchPlaybackStatus(null);
        if (status === 'Pending' || status === 'RecoveryRequired') return { outcome: 'Failed' };
        const existing = this.captures.get(switchId);
        if (existing) {
            return sameSession(existing.session, session) ?
                { outcome: 'Captured', capture: existing } :
                { outcome: 'Failed' };
        }

        const player = this.manager.getCurrentPlayer();
        if (!player || !this.manager.currentItem(player)) {
            return { outcome: this.proveNoPlayback(player) ? 'NotActive' : 'Failed' };
        }
        if (!player.isLocalPlayer || !this.otherPlayersInactive(player)) return { outcome: 'Failed' };

        const captured = this.capturePlayback(session, switchId, player);
        if (captured) this.captures.set(switchId, captured);
        return captured ? { outcome: 'Captured', capture: captured } : { outcome: 'Failed' };
    }

    private capturePlayback(session: ActiveProfileSession, switchId: string, player: Player): CapturedPlayback | null {
        const item = this.manager.currentItem(player);
        const playSessionId = this.manager.playSessionId(player);
        const state = this.manager.getPlayerState(player);
        if (!isRecord(item) || !isJellyfinItemId(item.Id)
            || item.ServerId !== session.serverId || typeof playSessionId !== 'string'
            || !playSessionId || playSessionId.length > 255 || !isRecord(state)
            || !isRecord(state.PlayState)) return null;

        const position = state.PlayState.PositionTicks;
        if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) return null;

        const client = this.connections.getApiClient(session.serverId);
        if (!client || client.serverId() !== session.serverId || client.deviceId() !== session.deviceId
            || client.getCurrentUserId() !== session.profileUserId
            || client.accessToken() !== session.credentialRef.token) return null;

        const report: PendingPlaybackStop = Object.freeze({
            version: 1,
            status: 'Captured',
            itemId: item.Id,
            playSessionId,
            positionTicks: position,
            reportKey: reportKey(switchId, playSessionId),
            endpointUrl: client.getUrl(`ProfileSelectors/Current/Switches/${switchId}/PlaybackStopped`),
            serverAddress: client.serverAddress(),
            appName: this.identity.appName(),
            appVersion: this.identity.appVersion(),
            deviceName: this.identity.deviceName()
        });
        return { session, player, report, stopped: false };
    }

    private proveNoPlayback(current: Player | null): boolean {
        const status = this.manager.getProfileSwitchPlaybackStatus(null);
        if (status === 'Pending' || status === 'RecoveryRequired') return false;
        return (!current || this.playerInactive(current)) && this.otherPlayersInactive(current);
    }

    private otherPlayersInactive(except: Player | null): boolean {
        return this.manager.getPlayers().every(player => {
            if (player === except) return true;
            return this.playerInactive(player);
        });
    }

    private playerInactive(player: Player): boolean {
        const status = this.manager.getProfileSwitchPlaybackStatus(player);
        if (status === 'Pending' || status === 'RecoveryRequired' || status === 'Active') return false;
        if (player.isLocalPlayer && typeof player.getPlaylist === 'function') return false;
        if (player.name === 'Google Cast' && player._castPlayer?.session) return false;
        if (this.manager.currentItem(player) != null) return false;

        const state = player.getPlayerState?.();
        if (isRecord(state) && state.NowPlayingItem != null) return false;
        if (status === 'Idle') return true;

        if (typeof player.isPlaying === 'function' || typeof player.currentSrc === 'function') {
            return this.manager.isPlaying(player) === false;
        }
        return player.isLocalPlayer && typeof player.currentItem === 'function';
    }
}

function sameSession(a: ActiveProfileSession, b: ActiveProfileSession): boolean {
    return a.serverId === b.serverId && a.deviceId === b.deviceId
        && a.profileUserId === b.profileUserId && a.sessionEpoch === b.sessionEpoch
        && a.credentialRef.token === b.credentialRef.token;
}

function sameReport(a: PendingPlaybackStop, b: PendingPlaybackStop): boolean {
    return a.itemId === b.itemId && a.playSessionId === b.playSessionId
        && a.positionTicks === b.positionTicks && a.reportKey === b.reportKey
        && a.endpointUrl === b.endpointUrl && a.serverAddress === b.serverAddress
        && a.appName === b.appName && a.appVersion === b.appVersion
        && a.deviceName === b.deviceName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Playback quiesce timed out.')), milliseconds);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function reportKey(switchId: string, playSessionId: string): string {
    const bytes = new TextEncoder().encode(`${switchId.replace(/-/g, '').toLowerCase()}:${playSessionId}`);
    return bytesToHex(sha256(bytes));
}

async function postPlaybackStop(
    url: string,
    authorization: string,
    report: PlaybackReport,
    timeoutMs: number
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', url);
        request.setRequestHeader('Authorization', authorization);
        request.setRequestHeader('Content-Type', 'application/json');
        request.timeout = timeoutMs;
        request.onload = () => {
            if (request.status !== 200) {
                reject(new Error('Playback stop report was rejected.'));
                return;
            }
            try {
                resolve(JSON.parse(request.responseText) as unknown);
            } catch (error) {
                reject(error);
            }
        };
        request.onerror = () => reject(new Error('Playback stop report failed.'));
        request.ontimeout = () => reject(new Error('Playback stop report timed out.'));
        request.send(JSON.stringify(report));
    });
}

export function createWebPlaybackQuiescePort(connections: PlaybackConnections): PlaybackQuiescePort {
    return new WebPlaybackQuiescePort(playbackManager, connections, appHost);
}

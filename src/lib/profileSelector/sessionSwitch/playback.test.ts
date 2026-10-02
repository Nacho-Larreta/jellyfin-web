import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { describe, expect, it, vi } from 'vitest';

vi.mock('components/apphost', () => ({ appHost: {} }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: {} }));

import { createActiveProfileSession, type ActiveProfileSession, type PendingPlaybackStop } from './model';
import { createSessionSwitchEnvelope } from './store';
import { WebPlaybackQuiescePort } from './playback';

const switchId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const itemId = 'bbbbbbbbbbbb4bbbbbbbbbbbbbbbbbbb';
const session = createActiveProfileSession('server-old', 'device-old', 'user-old', 'token-old', 7);

function reportDeadline() {
    return { wallMs: Date.now() + 20_000, monotonicMs: performance.now() + 20_000 };
}

function key(playSessionId = 'play-old') {
    const bytes = new TextEncoder().encode(`${switchId.replace(/-/g, '')}:${playSessionId}`);
    return bytesToHex(sha256(bytes));
}

function harness() {
    const player = { name: 'Html Video Player', isLocalPlayer: true, currentSrc: () => null };
    const cast = { name: 'Google Cast', isLocalPlayer: false, isPlaying: () => false,
        getPlayerState: () => ({}), _castPlayer: { session: null as unknown } };
    let pdfItem: unknown = null;
    const pdf = { name: 'PDF Player', isLocalPlayer: true, currentItem: () => pdfItem };
    let current: typeof player | typeof cast | typeof pdf | null = player;
    let item: unknown = { Id: itemId, ServerId: 'server-old' };
    let castItem: unknown = null;
    let position = 250;
    let playing = true;
    let base = '/old-api';
    let currentUserId = 'user-old';
    let currentToken = 'token-old';
    let durableSession: ActiveProfileSession = session;
    let pendingReport: PendingPlaybackStop | null = null;
    const manager = {
        getProfileSwitchPlaybackStatus: (): 'Unknown' => 'Unknown',
        getCurrentPlayer: () => current,
        getPlayers: () => [ player, cast, pdf ],
        currentItem: (target: typeof player | typeof cast | typeof pdf) => {
            if (target === player) return item;
            return target === cast ? castItem : pdf.currentItem();
        },
        playSessionId: () => item ? 'play-old' : null,
        getPlayerState: () => ({ PlayState: { PositionTicks: position } }),
        isPlaying: (target: typeof player | typeof cast | typeof pdf) => {
            if (target === player) return playing;
            return target === cast ? false : undefined;
        },
        stopForProfileSwitch: vi.fn(async () => {
            playing = false;
            item = null;
        })
    };
    const connections = { getApiClient: vi.fn(() => ({
        getUrl: (path: string) => `http://local.test${base}/${path}`,
        serverId: () => 'server-old', serverAddress: () => `http://local.test${base}`,
        deviceId: () => 'device-old', getCurrentUserId: () => currentUserId,
        accessToken: () => currentToken
    })), getSessionSwitchEnvelope: vi.fn(() => ({
        ...createSessionSwitchEnvelope(durableSession, null),
        marker: {
            kind: 'PendingSwitch' as const, phase: 'Quiescing' as const, switchId,
            serverId: durableSession.serverId, deviceId: durableSession.deviceId,
            oldProfileUserId: durableSession.profileUserId, oldEpoch: durableSession.sessionEpoch,
            targetProfileUserId: 'user-new', coordinatorId: 'coordinator-old',
            fencingToken: 1, leaseExpiresAtMs: Date.now() + 60_000,
            updatedAtMs: Date.now(), playbackReport: pendingReport
        }
    })) };
    const identity = { appName: () => 'Jellyfin Web', appVersion: () => '1', deviceName: () => 'Browser' };
    const send: (url: string, authorization: string, report: unknown, timeoutMs: number) => Promise<unknown> = async () => ({
        ReportKey: key(), Outcome: 'Acknowledged'
    });
    const transport = vi.fn(send);
    const port = new WebPlaybackQuiescePort(manager, connections, identity, transport);
    const quiesce = async (snapshot = session) => {
        const capture = await port.capture(snapshot, switchId);
        if (capture.outcome !== 'Captured') return { outcome: capture.outcome };
        pendingReport = capture.report;
        return port.stopAndReport(snapshot, switchId, capture.report, reportDeadline());
    };
    return {
        manager, connections, identity, transport, port, quiesce, player, cast, pdf,
        setCurrent: (value: typeof current) => { current = value; },
        setItem: (value: unknown) => { item = value; },
        setCastItem: (value: unknown) => { castItem = value; },
        setPdfItem: (value: unknown) => { pdfItem = value; },
        setPosition: (value: number) => { position = value; },
        setPlaying: (value: boolean) => { playing = value; },
        setBase: (value: string) => { base = value; },
        setUser: (value: string) => { currentUserId = value; },
        setToken: (value: string) => { currentToken = value; },
        setEpoch: (value: number) => { durableSession = createActiveProfileSession('server-old', 'device-old', 'user-old', 'token-old', value); },
        setPendingReport: (value: PendingPlaybackStop) => { pendingReport = value; }
    };
}

describe('WebPlaybackQuiescePort', () => {
    it('replays the durable request after process death without recapturing absent playback', async () => {
        const h = harness();
        const capture = await h.port.capture(session, switchId);
        expect(capture.outcome).toBe('Captured');
        if (capture.outcome !== 'Captured') throw new Error('Expected captured playback.');
        const persisted = JSON.parse(JSON.stringify(capture.report)) as typeof capture.report;
        h.setPendingReport(persisted);
        h.setItem(null);
        h.setPlaying(false);
        h.setCurrent(null);
        const restarted = new WebPlaybackQuiescePort(h.manager, h.connections, h.identity, h.transport);

        expect(await restarted.stopAndReport(session, switchId, persisted, reportDeadline()))
            .toEqual({ outcome: 'Acknowledged', reportKey: key() });
        expect(h.manager.stopForProfileSwitch).not.toHaveBeenCalled();
        expect(h.transport).toHaveBeenCalledWith(
            persisted.endpointUrl,
            expect.stringContaining('Token="token-old"'),
            { ItemId: itemId, PlaySessionId: 'play-old', PositionTicks: 250, Failed: false, NextMediaType: null },
            10_000
        );
    });

    it('refuses a retained report if the verified server address changed', async () => {
        const h = harness();
        const capture = await h.port.capture(session, switchId);
        if (capture.outcome !== 'Captured') throw new Error('Expected captured playback.');
        h.setBase('/different-api');
        h.setItem(null);
        h.setPlaying(false);

        expect(await h.port.stopAndReport(session, switchId, capture.report, reportDeadline())).toEqual({ outcome: 'Failed' });
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.manager.stopForProfileSwitch).not.toHaveBeenCalled();
    });

    it('releases the in-memory old player and credential only at terminal settlement', async () => {
        const h = harness();
        expect((await h.port.capture(session, switchId)).outcome).toBe('Captured');
        h.setItem(null);
        h.setPlaying(false);
        expect((await h.port.capture(session, switchId)).outcome).toBe('Captured');

        h.port.releaseCapture(switchId);

        expect(await h.port.capture(session, switchId)).toEqual({ outcome: 'NotActive' });
    });

    it('refuses local stop when the monotonic deadline elapsed despite a future wall-clock deadline', async () => {
        const h = harness();
        const capture = await h.port.capture(session, switchId);
        if (capture.outcome !== 'Captured') throw new Error('Expected captured playback.');

        expect(await h.port.stopAndReport(session, switchId, capture.report, {
            wallMs: Date.now() + 60_000,
            monotonicMs: performance.now() - 1
        })).toEqual({ outcome: 'Failed' });
        expect(h.manager.stopForProfileSwitch).not.toHaveBeenCalled();
        expect(h.transport).not.toHaveBeenCalled();
    });
    it('captures old playback and authority before stop, then sends one classified report', async () => {
        const h = harness();
        h.manager.stopForProfileSwitch.mockImplementationOnce(async () => {
            h.setItem(null);
            h.setPosition(999);
            h.setPlaying(false);
        });

        expect(await h.quiesce()).toEqual({ outcome: 'Acknowledged', reportKey: await key() });
        expect(h.manager.stopForProfileSwitch).toHaveBeenCalledOnce();
        expect(h.transport).toHaveBeenCalledWith(
            `http://local.test/old-api/ProfileSelectors/Current/Switches/${switchId}/PlaybackStopped`,
            expect.stringContaining('DeviceId="device-old"'),
            { ItemId: itemId, PlaySessionId: 'play-old', PositionTicks: 250, Failed: false, NextMediaType: null },
            10_000
        );
        expect(h.transport.mock.calls[0][1]).toContain('Token="token-old"');
    });

    it.each([
        [ 'user', (h: ReturnType<typeof harness>) => h.setUser('user-new') ],
        [ 'token', (h: ReturnType<typeof harness>) => h.setToken('token-new') ],
        [ 'server address', (h: ReturnType<typeof harness>) => h.setBase('/new-api') ],
        [ 'durable epoch', (h: ReturnType<typeof harness>) => h.setEpoch(8) ]
    ])('does not report with old authority when %s changes during local stop', async (_change, change) => {
        const h = harness();
        h.manager.stopForProfileSwitch.mockImplementationOnce(async () => {
            h.setItem(null);
            h.setPlaying(false);
            change(h);
        });

        expect(await h.quiesce()).toEqual({ outcome: 'Failed' });
        expect(h.manager.stopForProfileSwitch).toHaveBeenCalledOnce();
        expect(h.transport).not.toHaveBeenCalled();
    });

    it('replays the exact captured payload after a lost report response, despite changed runtime state', async () => {
        const h = harness();
        h.transport.mockRejectedValueOnce(new Error('response lost'));
        expect(await h.quiesce()).toEqual({ outcome: 'Failed' });
        h.setItem({ Id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', ServerId: 'server-new' });
        h.setPosition(500);

        expect(await h.quiesce()).toEqual({ outcome: 'Failed' });
        expect(h.manager.stopForProfileSwitch).toHaveBeenCalledOnce();
        expect(h.transport).toHaveBeenCalledOnce();

        h.setItem(null);
        expect(await h.quiesce()).toEqual({ outcome: 'Acknowledged', reportKey: await key() });
        expect(h.transport.mock.calls[1]).toEqual(h.transport.mock.calls[0]);
    });

    it('rejects a changed old identity for an existing switch', async () => {
        const h = harness();
        h.transport.mockRejectedValueOnce(new Error('offline'));
        await h.quiesce();
        const changed = createActiveProfileSession('server-old', 'device-old', 'user-old', 'token-new', 8);

        expect(await h.quiesce(changed)).toEqual({ outcome: 'Failed' });
        expect(h.transport).toHaveBeenCalledOnce();
    });

    it('accepts NotActive only after proving every registered local and remote player idle', async () => {
        const h = harness();
        h.setCurrent(null);
        h.setItem(null);
        h.setPlaying(false);

        expect(await h.quiesce()).toEqual({ outcome: 'NotActive' });
        expect(h.transport).not.toHaveBeenCalled();

        h.cast._castPlayer.session = {};
        expect(await h.quiesce()).toEqual({ outcome: 'Failed' });
    });

    it('does not treat a paused non-current player with an item as inactive', async () => {
        const h = harness();
        h.setCurrent(null);
        h.setItem(null);
        h.setPlaying(false);
        h.setPdfItem({ Id: itemId, ServerId: 'server-old' });

        expect(await h.quiesce()).toEqual({ outcome: 'Failed' });
        expect(h.transport).not.toHaveBeenCalled();
    });

    it('fails closed for active Cast or remote playback', async () => {
        const h = harness();
        h.setCurrent(h.cast);
        expect(await h.quiesce()).toEqual({ outcome: 'Failed' });
        expect(h.manager.stopForProfileSwitch).not.toHaveBeenCalled();
    });

    it('fails closed for incomplete play identity, stop failure and unclassified receipt', async () => {
        const missing = harness();
        missing.setItem({ ServerId: 'server-old' });
        expect(await missing.quiesce()).toEqual({ outcome: 'Failed' });

        const stopFailed = harness();
        stopFailed.manager.stopForProfileSwitch.mockRejectedValueOnce(new Error('player error'));
        expect(await stopFailed.quiesce()).toEqual({ outcome: 'Failed' });
        expect(stopFailed.transport).not.toHaveBeenCalled();

        const unclassified = harness();
        unclassified.transport.mockResolvedValueOnce({ ReportKey: await key(), Outcome: 'Other' });
        expect(await unclassified.quiesce()).toEqual({ outcome: 'Failed' });
    });

    it('rejects an incorrect report key even when the server says Acknowledged', async () => {
        const h = harness();
        h.transport.mockResolvedValueOnce({ ReportKey: 'wrong', Outcome: 'Acknowledged' });
        expect(await h.quiesce()).toEqual({ outcome: 'Failed' });
    });

    it('preserves the server classification for a valid stop receipt', async () => {
        const inactive = harness();
        inactive.transport.mockResolvedValueOnce({ ReportKey: key(), Outcome: 'NotActive' });
        expect(await inactive.quiesce()).toEqual({ outcome: 'NotActive' });

        const failed = harness();
        failed.transport.mockResolvedValueOnce({ ReportKey: key(), Outcome: 'Failed' });
        expect(await failed.quiesce()).toEqual({ outcome: 'Failed' });
    });

    it('times out a stop and ignores its late completion', async () => {
        vi.useFakeTimers();
        try {
            const h = harness();
            let complete!: () => void;
            h.manager.stopForProfileSwitch.mockImplementationOnce(() => new Promise(resolve => {
                complete = () => {
                    h.setPlaying(false);
                    resolve(undefined);
                };
            }));
            const result = h.quiesce();
            await vi.advanceTimersByTimeAsync(5_000);
            expect(await result).toEqual({ outcome: 'Failed' });
            complete();
            await Promise.resolve();
            expect(h.transport).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not send a report when the prepare deadline passes while stopping the old player', async () => {
        vi.useFakeTimers();
        try {
            const h = harness();
            h.manager.stopForProfileSwitch.mockImplementationOnce(() => new Promise(resolve => {
                setTimeout(() => {
                    h.setPlaying(false);
                    resolve(undefined);
                }, 2_000);
            }));
            const capture = await h.port.capture(session, switchId);
            if (capture.outcome !== 'Captured') throw new Error('Expected captured playback.');
            const result = h.port.stopAndReport(session, switchId, capture.report, {
                wallMs: Date.now() + 1_000,
                monotonicMs: performance.now() + 1_000
            });

            await vi.advanceTimersByTimeAsync(2_000);

            expect(await result).toEqual({ outcome: 'Failed' });
            expect(h.manager.stopForProfileSwitch).toHaveBeenCalledOnce();
            expect(h.transport).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('treats a report timeout as failed and ignores a late acknowledgement', async () => {
        vi.useFakeTimers();
        try {
            const h = harness();
            let acknowledge!: (value: unknown) => void;
            h.transport.mockImplementationOnce(() => new Promise<unknown>(resolve => {
                acknowledge = resolve;
            }));
            const result = h.quiesce();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await result).toEqual({ outcome: 'Failed' });
            acknowledge({ ReportKey: key(), Outcome: 'Acknowledged' });
            await Promise.resolve();
            expect(h.transport).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});

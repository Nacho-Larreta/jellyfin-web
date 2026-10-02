import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { describe, expect, it, vi } from 'vitest';

vi.mock('components/apphost', () => ({ appHost: {} }));
vi.mock('components/playback/playbackmanager', () => ({ playbackManager: {} }));

import { createActiveProfileSession } from './model';
import { WebPlaybackQuiescePort } from './playback';

const switchId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const itemId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const session = createActiveProfileSession('server-old', 'device-old', 'user-old', 'token-old', 7);

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
    const connections = { getApiClient: vi.fn(() => ({ getUrl: (path: string) => `${base}/${path}` })) };
    const identity = { appName: () => 'Jellyfin Web', appVersion: () => '1', deviceName: () => 'Browser' };
    const send: (url: string, authorization: string, report: unknown, timeoutMs: number) => Promise<unknown> = async () => ({
        ReportKey: key(), Outcome: 'Acknowledged'
    });
    const transport = vi.fn(send);
    const port = new WebPlaybackQuiescePort(manager, connections, identity, transport);
    return {
        manager, connections, transport, port, player, cast, pdf,
        setCurrent: (value: typeof current) => { current = value; },
        setItem: (value: unknown) => { item = value; },
        setCastItem: (value: unknown) => { castItem = value; },
        setPdfItem: (value: unknown) => { pdfItem = value; },
        setPosition: (value: number) => { position = value; },
        setPlaying: (value: boolean) => { playing = value; },
        setBase: (value: string) => { base = value; }
    };
}

describe('WebPlaybackQuiescePort', () => {
    it('captures old playback and authority before stop, then sends one classified report', async () => {
        const h = harness();
        h.manager.stopForProfileSwitch.mockImplementationOnce(async () => {
            h.setItem(null);
            h.setPosition(999);
            h.setBase('/new-api');
            h.setPlaying(false);
        });

        expect(await h.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Acknowledged', reportKey: await key() });
        expect(h.manager.stopForProfileSwitch).toHaveBeenCalledOnce();
        expect(h.transport).toHaveBeenCalledWith(
            `/old-api/ProfileSelectors/Current/Switches/${switchId}/PlaybackStopped`,
            expect.stringContaining('DeviceId="device-old"'),
            { ItemId: itemId, PlaySessionId: 'play-old', PositionTicks: 250, Failed: false, NextMediaType: null },
            10_000
        );
        expect(h.transport.mock.calls[0][1]).toContain('Token="token-old"');
    });

    it('replays the exact captured payload after a lost report response, despite changed runtime state', async () => {
        const h = harness();
        h.transport.mockRejectedValueOnce(new Error('response lost'));
        expect(await h.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        h.setItem({ Id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', ServerId: 'server-new' });
        h.setPosition(500);
        h.setBase('/new-api');

        expect(await h.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        expect(h.manager.stopForProfileSwitch).toHaveBeenCalledOnce();
        expect(h.transport.mock.calls[1]).toEqual(h.transport.mock.calls[0]);

        h.setItem(null);
        expect(await h.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Acknowledged', reportKey: await key() });
        expect(h.transport.mock.calls[2]).toEqual(h.transport.mock.calls[0]);
    });

    it('rejects a changed old identity for an existing switch', async () => {
        const h = harness();
        h.transport.mockRejectedValueOnce(new Error('offline'));
        await h.port.stopAndReport(session, switchId);
        const changed = createActiveProfileSession('server-old', 'device-old', 'user-old', 'token-new', 8);

        expect(await h.port.stopAndReport(changed, switchId)).toEqual({ outcome: 'Failed' });
        expect(h.transport).toHaveBeenCalledOnce();
    });

    it('accepts NotActive only after proving every registered local and remote player idle', async () => {
        const h = harness();
        h.setCurrent(null);
        h.setItem(null);
        h.setPlaying(false);

        expect(await h.port.stopAndReport(session, switchId)).toEqual({ outcome: 'NotActive' });
        expect(h.transport).not.toHaveBeenCalled();

        h.cast._castPlayer.session = {};
        expect(await h.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
    });

    it('does not treat a paused non-current player with an item as inactive', async () => {
        const h = harness();
        h.setCurrent(null);
        h.setItem(null);
        h.setPlaying(false);
        h.setPdfItem({ Id: itemId, ServerId: 'server-old' });

        expect(await h.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        expect(h.transport).not.toHaveBeenCalled();
    });

    it('fails closed for active Cast or remote playback', async () => {
        const h = harness();
        h.setCurrent(h.cast);
        expect(await h.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        expect(h.manager.stopForProfileSwitch).not.toHaveBeenCalled();
    });

    it('fails closed for incomplete play identity, stop failure and unclassified receipt', async () => {
        const missing = harness();
        missing.setItem({ ServerId: 'server-old' });
        expect(await missing.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });

        const stopFailed = harness();
        stopFailed.manager.stopForProfileSwitch.mockRejectedValueOnce(new Error('player error'));
        expect(await stopFailed.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
        expect(stopFailed.transport).not.toHaveBeenCalled();

        const unclassified = harness();
        unclassified.transport.mockResolvedValueOnce({ ReportKey: await key(), Outcome: 'Other' });
        expect(await unclassified.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
    });

    it('rejects an incorrect report key even when the server says Acknowledged', async () => {
        const h = harness();
        h.transport.mockResolvedValueOnce({ ReportKey: 'wrong', Outcome: 'Acknowledged' });
        expect(await h.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
    });

    it('preserves the server classification for a valid stop receipt', async () => {
        const inactive = harness();
        inactive.transport.mockResolvedValueOnce({ ReportKey: key(), Outcome: 'NotActive' });
        expect(await inactive.port.stopAndReport(session, switchId)).toEqual({ outcome: 'NotActive' });

        const failed = harness();
        failed.transport.mockResolvedValueOnce({ ReportKey: key(), Outcome: 'Failed' });
        expect(await failed.port.stopAndReport(session, switchId)).toEqual({ outcome: 'Failed' });
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
            const result = h.port.stopAndReport(session, switchId);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(await result).toEqual({ outcome: 'Failed' });
            complete();
            await Promise.resolve();
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
            const result = h.port.stopAndReport(session, switchId);
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

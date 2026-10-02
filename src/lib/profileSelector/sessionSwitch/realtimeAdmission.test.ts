import type { ApiClient, WebSocketDeliveryContext } from 'jellyfin-apiclient';
import { describe, expect, it, vi } from 'vitest';

import {
    createActiveProfileSession,
    type SessionSwitchCompletionReceipt,
    type SessionSwitchEnvelope
} from './model';
import { WebSocketSessionAdmission } from './realtimeAdmission';
import { createSessionSwitchEnvelope } from './store';

const serverId = 'server-1';
const deviceId = 'device-1';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

function createHarness(probe = vi.fn(async () => ({ Id: 'user-a', ServerId: serverId }))) {
    let userId = 'user-a';
    let token = 'token-a';
    let revision = 1;
    let selectorEnabled: boolean | undefined = true;
    let envelope: SessionSwitchEnvelope | null = createSessionSwitchEnvelope(
        createActiveProfileSession(serverId, deviceId, userId, token, 1)
    );
    let admissionOpen = true;
    let current = true;
    let provider: (() => WebSocketDeliveryContext | null) | null = null;
    const envelopeListeners = new Set<() => void>();
    const admissionListeners = new Set<() => void>();
    const client = {
        accessToken: () => token,
        appName: () => 'Web',
        appVersion: () => '1',
        closeWebSocket: vi.fn(),
        deviceId: () => deviceId,
        deviceName: () => 'Browser',
        ensureWebSocket: vi.fn(() => provider?.()?.isCurrent()),
        getCurrentUserId: () => userId,
        serverId: () => serverId,
        setWebSocketSessionProvider: vi.fn(next => {
            provider = next;
        })
    } as unknown as ApiClient;
    const authority = () => ({
        serverId, userId, accessToken: token, selectorEnabled,
        authorityRevision: revision, envelope
    });
    const connections = {
        currentApiClient: () => current ? client : null,
        getApiClient: () => current ? client : null,
        readFreshSessionAuthority: () => authority(),
        subscribeSessionSwitchEnvelope: (_serverId: string, listener: () => void) => {
            envelopeListeners.add(listener);
            return () => envelopeListeners.delete(listener);
        }
    };
    const application = {
        captureBoundSessionRead: () => {
            if (!admissionOpen || envelope?.marker || selectorEnabled === undefined) return null;
            const captured = authority();
            const binding = captured.envelope?.activeSession ?? createActiveProfileSession(
                serverId, deviceId, userId, token, 0
            );
            return {
                binding,
                assertCurrent: () => {
                    if (!admissionOpen || !current || authority().authorityRevision !== captured.authorityRevision
                        || authority().envelope?.marker || userId !== captured.userId || token !== captured.accessToken) {
                        throw new Error('stale');
                    }
                }
            };
        },
        subscribeSessionAdmission: (_serverId: string, listener: () => void) => {
            admissionListeners.add(listener);
            return () => admissionListeners.delete(listener);
        }
    };
    const controller = new WebSocketSessionAdmission(
        connections,
        application as ConstructorParameters<typeof WebSocketSessionAdmission>[1],
        probe
    );
    const notifyEnvelope = () => envelopeListeners.forEach(listener => {
        listener();
    });
    const notifyAdmission = () => admissionListeners.forEach(listener => {
        listener();
    });
    const marker = (): SessionSwitchEnvelope => ({
        ...envelope!,
        revision: envelope!.revision + 1,
        marker: {
            kind: 'PendingSwitch', phase: 'Preparing', playbackReport: null, switchId: 'switch-1',
            serverId, deviceId, oldProfileUserId: 'user-a', oldEpoch: 1,
            targetProfileUserId: 'user-b', coordinatorId: 'coordinator-1',
            fencingToken: 1, leaseExpiresAtMs: 1000, updatedAtMs: 0
        }
    });
    return {
        client,
        controller,
        getProvider: () => provider,
        notifyAdmission,
        notifyEnvelope,
        mark: () => {
            envelope = marker();
            admissionOpen = false;
            revision++;
            notifyEnvelope();
            notifyAdmission();
        },
        resolveTarget: (receipt = true) => {
            userId = 'user-b';
            token = 'token-b';
            envelope = {
                ...envelope!, revision: envelope!.revision + 1,
                activeSession: createActiveProfileSession(serverId, deviceId, userId, token, 2),
                marker: null,
                lastCompletion: receipt ? {
                    switchId: 'switch-1', serverId, profileUserId: userId, sessionEpoch: 2
                } : null
            };
            revision++;
            notifyEnvelope();
        },
        setCompletion: (receipt: SessionSwitchCompletionReceipt | null) => {
            envelope = {
                ...envelope!, revision: envelope!.revision + 1, lastCompletion: receipt
            };
            revision++;
            notifyEnvelope();
        },
        restoreOld: () => {
            userId = 'user-a';
            token = 'token-a';
            envelope = {
                ...envelope!, revision: envelope!.revision + 1,
                activeSession: createActiveProfileSession(serverId, deviceId, userId, token, 1),
                marker: null, lastCompletion: null
            };
            revision++;
            notifyEnvelope();
        },
        reopen: () => {
            admissionOpen = true;
            notifyAdmission();
        },
        setSelector: (enabled: boolean | undefined) => {
            selectorEnabled = enabled;
            envelope = null;
            revision++;
            notifyEnvelope();
        },
        signIn: (nextUserId: string, nextToken: string) => {
            userId = nextUserId;
            token = nextToken;
            selectorEnabled = false;
            envelope = null;
            revision++;
            notifyEnvelope();
            controller.signedIn();
        },
        setCurrent: (value: boolean) => {
            current = value;
            controller.inspect();
        }
    };
}

describe('WebSocketSessionAdmission', () => {
    const targetReceipt: SessionSwitchCompletionReceipt = {
        switchId: 'switch-1', serverId, profileUserId: 'user-b', sessionEpoch: 2
    };

    it('denies marker delivery and verifies target only after terminal authority and admission', async () => {
        const probe = vi.fn(async (_client, port) => ({
            Id: port.binding.profileUserId, ServerId: serverId
        }));
        const harness = createHarness(probe);
        harness.controller.register(harness.client);
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(1));
        const oldGuard = harness.getProvider()!();
        expect(oldGuard?.isCurrent()).toBe(true);

        harness.mark();
        expect(oldGuard?.isCurrent()).toBe(false);
        expect(harness.client.closeWebSocket).toHaveBeenCalledTimes(1);
        expect(harness.getProvider()!()).toBeNull();
        harness.resolveTarget();
        expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(1);
        harness.reopen();
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(2));
        expect(harness.getProvider()!()?.isCurrent()).toBe(true);
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('accepts restored old identity without a target receipt while keeping the old guard dead', async () => {
        const harness = createHarness();
        harness.controller.register(harness.client);
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(1));
        const oldGuard = harness.getProvider()!();
        harness.mark();
        harness.restoreOld();
        harness.reopen();
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(2));
        expect(oldGuard?.isCurrent()).toBe(false);
        expect(harness.getProvider()!()?.isCurrent()).toBe(true);
    });

    it('rejects missing target completion and stale pending Users/Me after a marker', async () => {
        const first = deferred<{ Id: string; ServerId: string }>();
        const probe = vi.fn()
            .mockReturnValueOnce(first.promise)
            .mockResolvedValue({ Id: 'user-b', ServerId: serverId });
        const harness = createHarness(probe);
        harness.controller.register(harness.client);
        harness.mark();
        first.resolve({ Id: 'user-a', ServerId: serverId });
        await first.promise;
        harness.resolveTarget(false);
        harness.reopen();
        expect(harness.client.ensureWebSocket).not.toHaveBeenCalled();
        expect(harness.getProvider()!()).toBeNull();
    });

    it('does not let a delayed ordinary sign-in bypass a missing target receipt', async () => {
        const probe = vi.fn(async (_client, port) => ({
            Id: port.binding.profileUserId, ServerId: serverId
        }));
        const harness = createHarness(probe);
        harness.controller.register(harness.client);
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledOnce());

        harness.mark();
        harness.resolveTarget(false);
        harness.reopen();
        harness.controller.signedIn();

        expect(probe).toHaveBeenCalledTimes(1);
        expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(1);
        expect(harness.getProvider()!()).toBeNull();
    });

    it.each([
        ['foreign switch', { ...targetReceipt, switchId: 'switch-elsewhere' }],
        ['foreign server', { ...targetReceipt, serverId: 'server-elsewhere' }],
        ['foreign user', { ...targetReceipt, profileUserId: 'user-elsewhere' }],
        ['stale epoch', { ...targetReceipt, sessionEpoch: 1 }]
    ])('does not treat a persisted %s receipt as target readiness', async (_label, receipt) => {
        const probe = vi.fn(async (_client, port) => ({
            Id: port.binding.profileUserId, ServerId: serverId
        }));
        const harness = createHarness(probe);
        harness.controller.register(harness.client);
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledOnce());

        harness.mark();
        harness.controller.inspect();
        harness.resolveTarget(false);
        harness.reopen();
        harness.setCompletion(receipt);
        harness.controller.inspect();

        expect(harness.getProvider()!()).toBeNull();
        expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('keeps the target grant across repeated inspection without a durable change', async () => {
        const probe = vi.fn(async (_client, port) => ({
            Id: port.binding.profileUserId, ServerId: serverId
        }));
        const harness = createHarness(probe);
        harness.controller.register(harness.client);
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledOnce());
        harness.mark();
        harness.resolveTarget(false);
        harness.reopen();
        expect(harness.getProvider()!()).toBeNull();

        harness.setCompletion(targetReceipt);
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(2));
        const currentGuard = harness.getProvider()!();
        harness.controller.inspect();
        harness.controller.inspect();

        expect(currentGuard?.isCurrent()).toBe(true);
        expect(harness.getProvider()!()).toBe(currentGuard);
        expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(2);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(harness.client.closeWebSocket).toHaveBeenCalledTimes(1);
    });

    it('requires an explicit selector-disabled state for ordinary cold login', async () => {
        const harness = createHarness();
        harness.setSelector(undefined);
        harness.controller.register(harness.client);
        expect(harness.getProvider()!()).toBeNull();
        harness.setSelector(false);
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledOnce());
        harness.setCurrent(false);
        expect(harness.getProvider()!()).toBeNull();
    });

    it('accepts an ordinary new login after revoking the previous session', async () => {
        const probe = vi.fn(async (_client, port) => ({
            Id: port.binding.profileUserId, ServerId: serverId
        }));
        const harness = createHarness(probe);
        harness.controller.register(harness.client);
        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledOnce());
        const oldGuard = harness.getProvider()!();

        harness.signIn('user-b', 'token-b');

        await vi.waitFor(() => expect(harness.client.ensureWebSocket).toHaveBeenCalledTimes(2));
        expect(oldGuard?.isCurrent()).toBe(false);
        expect(harness.getProvider()!()?.isCurrent()).toBe(true);
    });
});

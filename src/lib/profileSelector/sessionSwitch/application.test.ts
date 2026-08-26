import { describe, expect, it, vi } from 'vitest';

import { type ProfileSwitchApiPort } from './api';
import { WebSessionSwitchApplication } from './application';
import {
    ConcurrentSessionWriteError,
    SessionStorageCorruptionError,
    SessionSwitchRecoveryRequiredError,
    SessionSwitchUnsupportedEngineError,
    createActiveProfileSession,
    createOwnerRecoverySession,
    type SessionSwitchEnvelope
} from './model';
import { cloneEnvelope, createSessionSwitchEnvelope } from './store';

function createApiClient(selector: Record<string, unknown>, userId = 'owner-user', token = 'owner-token') {
    let currentUserId = userId;
    let currentToken = token;
    return {
        accessToken: () => currentToken,
        ajax: vi.fn(),
        getCurrentUser: vi.fn(async () => ({ Id: currentUserId, ServerId: 'server-1' })),
        getCurrentUserId: () => currentUserId,
        getJSON: vi.fn().mockResolvedValue(selector),
        getUrl: (path: string) => `/api/${path}`,
        serverId: () => 'server-1',
        install(user: string, accessToken: string) {
            currentUserId = user;
            currentToken = accessToken;
        }
    };
}

function createConnections(initial: SessionSwitchEnvelope | null, apiClient: ReturnType<typeof createApiClient>) {
    let envelope = initial === null ? null : cloneEnvelope(initial);
    const listeners = new Set<(value: unknown) => void>();
    const connections = {
        clearSessionSwitchEnvelope: vi.fn(async () => {
            envelope = null;
            listeners.forEach(listener => {
                listener(null);
            });
        }),
        clearResolvedSessionSwitchEnvelope: vi.fn(async (_serverId, expectedRevision) => {
            if (envelope === null
                || envelope.revision !== expectedRevision
                || envelope.marker !== null) {
                throw new ConcurrentSessionWriteError(envelope?.revision ?? 0);
            }
            envelope = null;
            listeners.forEach(listener => {
                listener(null);
            });
        }),
        clearInstalledSession: vi.fn(),
        discardStagedSession: vi.fn(),
        getApiClient: vi.fn(() => apiClient),
        getInstalledSessionUser: vi.fn(() => apiClient.getCurrentUser()),
        getSessionDeviceId: () => 'device-1',
        getSessionSwitchEnvelope: vi.fn(() => envelope === null ? null : cloneEnvelope(envelope)),
        installSessionAuthentication: vi.fn(session => {
            apiClient.install(session.profileUserId, session.credentialRef.token);
        }),
        publishSessionSwitchCompletion: vi.fn(async () => undefined),
        reconnectInstalledSession: vi.fn(),
        replaceSessionSwitchEnvelope: vi.fn(async (_serverId, expectedRevision, next) => {
            const actualRevision = envelope?.revision ?? 0;
            if (actualRevision !== expectedRevision) {
                throw new ConcurrentSessionWriteError(actualRevision);
            }
            envelope = cloneEnvelope(next);
            listeners.forEach(listener => {
                listener(cloneEnvelope(next));
            });
        }),
        resetInstalledSession: vi.fn(),
        setProfileSelectorAvailability: vi.fn().mockResolvedValue(null),
        subscribeSessionSwitchEnvelope: vi.fn((_serverId, listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }),
        forceEnvelope: (next: SessionSwitchEnvelope | null) => {
            envelope = next === null ? null : cloneEnvelope(next);
        },
        readEnvelope: () => envelope === null ? null : cloneEnvelope(envelope)
    };
    return connections;
}

const enabledOwnerSelector = {
    IsEnabled: true,
    IsCurrentUserOwner: true,
    OwnerUserId: 'owner-user',
    Profiles: []
};

const enabledSecondarySelector = {
    IsEnabled: true,
    IsCurrentUserOwner: false,
    OwnerUserId: 'owner-user',
    Profiles: []
};

describe('WebSessionSwitchApplication bootstrap', () => {
    it('creates the first atomic owner envelope before binding runtime', async () => {
        const apiClient = createApiClient(enabledOwnerSelector);
        const connections = createConnections(null, apiClient);
        const coordinatorIds = vi.fn(() => 'coordinator-1');
        const application = new WebSessionSwitchApplication(connections, {
            createCoordinatorId: coordinatorIds
        });

        const result = await application.bootstrapAuthenticatedSession(apiClient);
        const envelope = connections.readEnvelope();

        expect(result.activeSession).toEqual(expect.objectContaining({
            profileUserId: 'owner-user',
            sessionEpoch: 0
        }));
        expect(envelope).toEqual(expect.objectContaining({
            revision: 1,
            marker: null,
            recoverySession: expect.objectContaining({ ownerUserId: 'owner-user' })
        }));
        expect(connections.replaceSessionSwitchEnvelope).toHaveBeenCalledBefore(
            connections.installSessionAuthentication
        );
        expect(connections.reconnectInstalledSession).toHaveBeenCalledOnce();

        await application.bootstrapAuthenticatedSession(apiClient);
        expect(coordinatorIds).toHaveBeenCalledOnce();
        expect(connections.reconnectInstalledSession).toHaveBeenCalledOnce();
    });

    it.each([ 'manual', 'quick-connect' ])(
        'establishes explicit active and recovery authority before %s owner login completes',
        async () => {
            const apiClient = createApiClient(enabledOwnerSelector);
            const connections = createConnections(null, apiClient);
            const application = new WebSessionSwitchApplication(connections, {
                createCoordinatorId: () => 'coordinator-1'
            });

            await application.bootstrapAuthenticatedSession(apiClient, {
                Id: 'owner-user',
                ServerId: 'server-1'
            });

            expect(connections.readEnvelope()).toEqual(expect.objectContaining({
                activeSession: expect.objectContaining({ profileUserId: 'owner-user' }),
                recoverySession: expect.objectContaining({ ownerUserId: 'owner-user' })
            }));
            expect(connections.installSessionAuthentication).toHaveBeenCalledAfter(
                connections.replaceSessionSwitchEnvelope
            );
        }
    );

    it('creates an active-only envelope for manual secondary login', async () => {
        const apiClient = createApiClient(enabledSecondarySelector, 'secondary-user', 'secondary-token');
        const connections = createConnections(null, apiClient);
        const application = new WebSessionSwitchApplication(connections, {
            createCoordinatorId: () => 'coordinator-1'
        });

        await application.bootstrapAuthenticatedSession(apiClient);

        expect(connections.readEnvelope()?.recoverySession).toBeNull();
        expect(connections.readEnvelope()?.activeSession.profileUserId).toBe('secondary-user');
    });

    it('recovers a marker won by another context during first-envelope CAS', async () => {
        const apiClient = createApiClient(enabledSecondarySelector, 'old-user', 'old-token');
        const base = createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7)
        );
        const winner: SessionSwitchEnvelope = {
            ...base,
            revision: 2,
            marker: {
                kind: 'PendingSwitch',
                phase: 'Preparing',
                switchId: 'switch-winner',
                serverId: 'server-1',
                deviceId: 'device-1',
                oldProfileUserId: 'old-user',
                oldEpoch: 7,
                targetProfileUserId: 'target-user',
                coordinatorId: 'other-context',
                fencingToken: 1,
                leaseExpiresAtMs: 1,
                updatedAtMs: 1
            }
        };
        const connections = createConnections(null, apiClient);
        connections.replaceSessionSwitchEnvelope.mockImplementationOnce(async () => {
            connections.forceEnvelope(winner);
            throw new ConcurrentSessionWriteError(2);
        });
        const abort = vi.fn().mockResolvedValue({
            switchId: 'switch-winner',
            targetProfileUserId: 'target-user',
            state: 'Aborted',
            authentication: null
        });
        const application = new WebSessionSwitchApplication(connections, {
            createApi: () => ({ abort, commit: vi.fn(), prepare: vi.fn(), status: vi.fn() }),
            createCoordinatorId: () => 'coordinator-1'
        });

        await application.bootstrapAuthenticatedSession(apiClient);

        expect(abort).toHaveBeenCalledWith('switch-winner');
        expect(connections.readEnvelope()?.marker).toBeNull();
    });

    it('clears selector metadata while preserving ordinary authenticated binding when disabled', async () => {
        const apiClient = createApiClient({ IsEnabled: false });
        const initial = createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'owner-user', 'owner-token', 3),
            createOwnerRecoverySession('server-1', 'device-1', 'owner-user', 'owner-token')
        );
        const connections = createConnections({ ...initial, revision: 4 }, apiClient);
        const application = new WebSessionSwitchApplication(connections);

        const result = await application.bootstrapAuthenticatedSession(apiClient);

        expect(result.activeSession).toBeNull();
        expect(connections.setProfileSelectorAvailability).toHaveBeenCalledWith('server-1', false);
        expect(connections.clearResolvedSessionSwitchEnvelope).toHaveBeenCalledWith('server-1', 4);
        expect(apiClient.getCurrentUserId()).toBe('owner-user');
        expect(apiClient.accessToken()).toBe('owner-token');
    });

    it('resolves a pre-commit restart marker before selector-disabled cleanup', async () => {
        const apiClient = createApiClient({ IsEnabled: false }, 'old-user', 'old-token');
        const base = createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7),
            createOwnerRecoverySession('server-1', 'device-1', 'owner-user', 'owner-token')
        );
        const initial: SessionSwitchEnvelope = {
            ...base,
            revision: 2,
            marker: {
                kind: 'PendingSwitch',
                phase: 'Preparing',
                switchId: 'switch-1',
                serverId: 'server-1',
                deviceId: 'device-1',
                oldProfileUserId: 'old-user',
                oldEpoch: 7,
                targetProfileUserId: 'target-user',
                coordinatorId: 'coordinator-1',
                fencingToken: 1,
                leaseExpiresAtMs: 1_000,
                updatedAtMs: 10
            }
        };
        const connections = createConnections(initial, apiClient);
        const abort = vi.fn().mockResolvedValue({
            switchId: 'switch-1',
            targetProfileUserId: 'target-user',
            state: 'Aborted',
            authentication: null
        });
        const application = new WebSessionSwitchApplication(connections, {
            createApi: () => ({
                abort,
                commit: vi.fn(),
                prepare: vi.fn(),
                status: vi.fn()
            }),
            createCoordinatorId: () => 'coordinator-1'
        });

        await application.bootstrapAuthenticatedSession(apiClient);

        expect(abort).toHaveBeenCalledWith('switch-1');
        expect(connections.clearResolvedSessionSwitchEnvelope).toHaveBeenCalledAfter(
            connections.replaceSessionSwitchEnvelope
        );
        expect(connections.readEnvelope()).toBeNull();
    });

    it('recovers a marker that races selector-disabled conditional cleanup', async () => {
        const apiClient = createApiClient({ IsEnabled: false }, 'old-user', 'old-token');
        const base = createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7)
        );
        const connections = createConnections({ ...base, revision: 4 }, apiClient);
        const raced: SessionSwitchEnvelope = {
            ...base,
            revision: 5,
            marker: {
                kind: 'PendingSwitch',
                phase: 'Preparing',
                switchId: 'raced-switch',
                serverId: 'server-1',
                deviceId: 'device-1',
                oldProfileUserId: 'old-user',
                oldEpoch: 7,
                targetProfileUserId: 'target-user',
                coordinatorId: 'other-context',
                fencingToken: 1,
                leaseExpiresAtMs: 1,
                updatedAtMs: 1
            }
        };
        connections.clearResolvedSessionSwitchEnvelope.mockImplementationOnce(async () => {
            connections.forceEnvelope(raced);
            throw new ConcurrentSessionWriteError(5);
        });
        const abort = vi.fn().mockResolvedValue({
            switchId: 'raced-switch',
            targetProfileUserId: 'target-user',
            state: 'Aborted',
            authentication: null
        });
        const application = new WebSessionSwitchApplication(connections, {
            createApi: () => ({ abort, commit: vi.fn(), prepare: vi.fn(), status: vi.fn() }),
            createCoordinatorId: () => 'coordinator-1'
        });

        await application.bootstrapAuthenticatedSession(apiClient);

        expect(abort).toHaveBeenCalledWith('raced-switch');
        expect(connections.clearResolvedSessionSwitchEnvelope).toHaveBeenCalledTimes(2);
        expect(connections.readEnvelope()).toBeNull();
    });

    it('fails closed when selector-disabled cleanup loses both conditional attempts', async () => {
        const apiClient = createApiClient({ IsEnabled: false }, 'old-user', 'old-token');
        const initial = createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7)
        );
        const connections = createConnections({ ...initial, revision: 4 }, apiClient);
        connections.clearResolvedSessionSwitchEnvelope.mockImplementation(async () => {
            const current = connections.readEnvelope();
            connections.forceEnvelope({
                ...current!,
                revision: current!.revision + 1
            });
            throw new ConcurrentSessionWriteError(current!.revision + 1);
        });
        const application = new WebSessionSwitchApplication(connections);

        await expect(application.bootstrapAuthenticatedSession(apiClient))
            .rejects.toBeInstanceOf(SessionSwitchRecoveryRequiredError);

        expect(connections.clearResolvedSessionSwitchEnvelope).toHaveBeenCalledTimes(2);
        expect(connections.readEnvelope()).not.toBeNull();
    });

    it('fails closed when the durable envelope cannot be decoded', async () => {
        const apiClient = createApiClient(enabledOwnerSelector);
        const connections = createConnections(null, apiClient);
        connections.getSessionSwitchEnvelope.mockImplementation(() => {
            throw new SessionStorageCorruptionError();
        });
        const application = new WebSessionSwitchApplication(connections);

        await expect(application.prepareProtectedRoute(apiClient))
            .rejects.toBeInstanceOf(SessionStorageCorruptionError);
        expect(connections.installSessionAuthentication).not.toHaveBeenCalled();
    });

    it('preserves the explicit unsupported-engine failure before any envelope sink', async () => {
        const apiClient = createApiClient(enabledOwnerSelector);
        const connections = createConnections(null, apiClient);
        connections.setProfileSelectorAvailability.mockRejectedValueOnce(
            new SessionSwitchUnsupportedEngineError()
        );
        const application = new WebSessionSwitchApplication(connections);

        await expect(application.prepareProtectedRoute(apiClient))
            .rejects.toBeInstanceOf(SessionSwitchUnsupportedEngineError);
        expect(connections.replaceSessionSwitchEnvelope).not.toHaveBeenCalled();
        expect(connections.installSessionAuthentication).not.toHaveBeenCalled();
    });

    it('resolves CommitUnknown on cold restart before exposing the target identity', async () => {
        const apiClient = createApiClient(enabledSecondarySelector, 'old-user', 'old-token');
        const base = createSessionSwitchEnvelope(
            createActiveProfileSession('server-1', 'device-1', 'old-user', 'old-token', 7),
            createOwnerRecoverySession('server-1', 'device-1', 'owner-user', 'owner-token')
        );
        const initial: SessionSwitchEnvelope = {
            ...base,
            revision: 4,
            marker: {
                kind: 'PendingSwitch',
                phase: 'CommitUnknown',
                switchId: 'switch-1',
                serverId: 'server-1',
                deviceId: 'device-1',
                oldProfileUserId: 'old-user',
                oldEpoch: 7,
                targetProfileUserId: 'target-user',
                coordinatorId: 'coordinator-1',
                fencingToken: 1,
                leaseExpiresAtMs: 1_000,
                updatedAtMs: 10
            }
        };
        const connections = createConnections(initial, apiClient);
        const api: ProfileSwitchApiPort = {
            abort: vi.fn(),
            commit: vi.fn(),
            prepare: vi.fn(),
            status: vi.fn().mockResolvedValue({
                switchId: 'switch-1',
                targetProfileUserId: 'target-user',
                state: 'Committed',
                authentication: { accessToken: 'target-token', userId: 'target-user' }
            })
        };
        const application = new WebSessionSwitchApplication(connections, {
            createApi: () => api,
            createCoordinatorId: () => 'coordinator-1'
        });

        const result = await application.prepareProtectedRoute(apiClient);

        expect(api.status).toHaveBeenCalledWith('switch-1');
        expect(result.activeSession).toEqual(expect.objectContaining({
            profileUserId: 'target-user',
            sessionEpoch: 8
        }));
        expect(connections.readEnvelope()).toEqual(expect.objectContaining({
            marker: null,
            lastCompletion: expect.objectContaining({ switchId: 'switch-1' })
        }));
        expect(connections.publishSessionSwitchCompletion).toHaveBeenCalledOnce();
    });
});

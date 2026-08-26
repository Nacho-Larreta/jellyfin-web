import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    applyAuthenticationResult: vi.fn(),
    clearUnlockedProfileUserId: vi.fn(),
    prepareProtectedRoute: vi.fn(),
    activateProfile: vi.fn()
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        applyAuthenticationResult: mocks.applyAuthenticationResult
    }
}));

vi.mock('./sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: () => ({
        prepareProtectedRoute: mocks.prepareProtectedRoute
    })
}));

vi.mock('./api', () => ({
    activateProfile: mocks.activateProfile
}));

vi.mock('./session', () => ({
    clearUnlockedProfileUserId: mocks.clearUnlockedProfileUserId,
    getUnlockedProfileUserId: vi.fn(() => null)
}));

import { resolveProfileSelectorRoute } from './navigation';

function createApiClient(userId = 'owner-user') {
    return {
        accessToken: () => 'active-token',
        getCurrentUserId: () => userId,
        serverId: () => 'server-1'
    };
}

describe('profile selector protected route guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('propagates unknown or corrupt bootstrap state instead of opening the target route', async () => {
        const recoveryError = new Error('recovery required');
        mocks.prepareProtectedRoute.mockRejectedValueOnce(recoveryError);

        await expect(resolveProfileSelectorRoute(createApiClient(), '/home'))
            .rejects.toBe(recoveryError);
        expect(mocks.activateProfile).not.toHaveBeenCalled();
    });

    it('opens the requested route only after selector-disabled cleanup completes', async () => {
        mocks.prepareProtectedRoute.mockResolvedValueOnce({
            selector: { IsEnabled: false },
            activeSession: null
        });

        await expect(resolveProfileSelectorRoute(createApiClient(), '/home')).resolves.toBe('/home');
        expect(mocks.prepareProtectedRoute).toHaveBeenCalledOnce();
        expect(mocks.clearUnlockedProfileUserId).toHaveBeenCalledWith('server-1');
    });

    it('routes an enabled unresolved profile to the selector after bootstrap succeeds', async () => {
        mocks.prepareProtectedRoute.mockResolvedValueOnce({
            selector: {
                IsEnabled: true,
                Profiles: [{ ProfileUserId: 'secondary-user', IsActive: false, IsVisible: true }]
            }
        });

        await expect(resolveProfileSelectorRoute(createApiClient(), '/home'))
            .resolves.toBe('/profileselector?url=%2Fhome');
    });
});

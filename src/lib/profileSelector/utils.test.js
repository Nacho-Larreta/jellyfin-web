import { describe, expect, it } from 'vitest';

import {
    getActiveProfile,
    getAutoActivationCandidate,
    getCurrentDeviceProfile,
    isProfileSelectionRequired,
    normalizeProfileSelectorState
} from './utils';

describe('Profile selector utils', () => {
    it('should normalize selector state defaults', () => {
        const selector = normalizeProfileSelectorState();

        expect(selector.IsEnabled).toBe(false);
        expect(selector.Profiles).toEqual([]);
        expect(selector.CurrentDeviceProfileUserId).toBeNull();
    });

    it('should resolve the current device profile from device state', () => {
        const selector = {
            IsEnabled: true,
            CurrentDeviceProfileUserId: 'mia',
            Profiles: [
                { ProfileUserId: 'lucas', Name: 'Lucas' },
                { ProfileUserId: 'mia', Name: 'Mia' }
            ]
        };

        expect(getCurrentDeviceProfile(selector)?.ProfileUserId).toBe('mia');
    });

    it('should resolve the active profile from profile cards', () => {
        const selector = {
            Profiles: [
                { ProfileUserId: 'lucas', IsActive: false },
                { ProfileUserId: 'mia', IsActive: true }
            ]
        };

        expect(getActiveProfile(selector)?.ProfileUserId).toBe('mia');
    });

    it('should auto activate the last device profile when it does not require a pin', () => {
        const selector = {
            IsEnabled: true,
            CurrentDeviceProfileUserId: 'mia',
            CurrentDeviceProfileRequiresPin: false,
            Profiles: [
                { ProfileUserId: 'mia', Name: 'Mia', IsVisible: true, IsDisabled: false }
            ]
        };

        expect(getAutoActivationCandidate(selector, 'lucas', null)?.ProfileUserId).toBe('mia');
    });

    it('should auto activate a single profile when auto-select is enabled and the profile has no pin', () => {
        const selector = {
            IsEnabled: true,
            AutoSelectSingleProfile: true,
            Profiles: [
                { ProfileUserId: 'sofi', RequiresPin: false, IsVisible: true, IsDisabled: false }
            ]
        };

        expect(getAutoActivationCandidate(selector, 'owner', null)?.ProfileUserId).toBe('sofi');
    });

    it('should require profile selection when there is no active profile', () => {
        const selector = {
            IsEnabled: true,
            Profiles: [
                { ProfileUserId: 'lucas', IsActive: false, IsVisible: true }
            ]
        };

        expect(isProfileSelectionRequired(selector, 'lucas', null)).toBe(true);
    });

    it('should require profile selection again when the active profile uses a pin and is not unlocked in the current runtime', () => {
        const selector = {
            IsEnabled: true,
            Profiles: [
                { ProfileUserId: 'lucas', IsActive: true, RequiresPin: true, IsVisible: true }
            ]
        };

        expect(isProfileSelectionRequired(selector, 'lucas', null)).toBe(true);
        expect(isProfileSelectionRequired(selector, 'lucas', 'lucas')).toBe(false);
    });
});

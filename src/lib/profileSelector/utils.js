export const PROFILE_SELECTOR_PATH = '/profileselector';
export const PROFILE_SELECTOR_MANAGE_PATH = '/profileselector/manage';

export function normalizeProfileSelectorState(state = {}) {
    return {
        IsEnabled: false,
        ProfileSelectorId: null,
        OwnerUserId: null,
        OwnerUserName: null,
        AutoSelectSingleProfile: false,
        CanManageProfiles: false,
        IsCurrentUserOwner: false,
        CurrentDeviceProfileUserId: null,
        CurrentDeviceProfileRequiresPin: false,
        Profiles: [],
        ...state
    };
}

export function normalizeProfileSelectorMember(profile = {}) {
    return {
        ProfileUserId: null,
        Name: null,
        PrimaryImageTag: null,
        DisplayOrder: 0,
        IsVisible: true,
        RequiresPin: false,
        IsDisabled: false,
        IsAdministrator: false,
        IsOwner: false,
        HasParentalRestrictions: false,
        IsActive: false,
        LastLoginDate: null,
        LastActivityDate: null,
        ...profile
    };
}

export function getProfileSelectorRoute(redirectUrl) {
    if (!redirectUrl) {
        return PROFILE_SELECTOR_PATH;
    }

    return `${PROFILE_SELECTOR_PATH}?url=${encodeURIComponent(redirectUrl)}`;
}

export function getManageProfileSelectorRoute() {
    return PROFILE_SELECTOR_MANAGE_PATH;
}

export function getVisibleProfiles(selector) {
    return (normalizeProfileSelectorState(selector).Profiles || [])
        .map(normalizeProfileSelectorMember)
        .filter(profile => profile.IsVisible !== false)
        .sort((left, right) => {
            if (left.IsOwner !== right.IsOwner) {
                return left.IsOwner ? -1 : 1;
            }

            return left.DisplayOrder - right.DisplayOrder;
        });
}

export function getSelectableProfiles(selector) {
    return getVisibleProfiles(selector).filter(profile => !profile.IsDisabled);
}

export function getActiveProfile(selector) {
    return getVisibleProfiles(selector).find(profile => profile.IsActive) || null;
}

export function getCurrentDeviceProfile(selector) {
    const normalizedSelector = normalizeProfileSelectorState(selector);
    if (!normalizedSelector.CurrentDeviceProfileUserId) {
        return null;
    }

    return getSelectableProfiles(normalizedSelector)
        .find(profile => profile.ProfileUserId === normalizedSelector.CurrentDeviceProfileUserId) || null;
}

export function getAutoActivationCandidate(selector, currentUserId, unlockedProfileUserId) {
    const normalizedSelector = normalizeProfileSelectorState(selector);
    if (!normalizedSelector.IsEnabled) {
        return null;
    }

    const profiles = getSelectableProfiles(selector);
    if (profiles.length === 0) {
        return null;
    }

    const currentDeviceProfile = getCurrentDeviceProfile(normalizedSelector);
    if (currentDeviceProfile && !normalizedSelector.CurrentDeviceProfileRequiresPin) {
        return currentDeviceProfile;
    }

    if (normalizedSelector.AutoSelectSingleProfile && profiles.length === 1 && !profiles[0].RequiresPin) {
        return profiles[0];
    }

    const activeProfile = getActiveProfile(normalizedSelector);
    if (activeProfile && activeProfile.ProfileUserId === currentUserId) {
        if (!activeProfile.RequiresPin || unlockedProfileUserId === currentUserId) {
            return activeProfile;
        }
    }

    return null;
}

export function isProfileSelectionRequired(state, currentUserId, unlockedProfileUserId) {
    const normalizedState = normalizeProfileSelectorState(state);

    if (!normalizedState.IsEnabled) {
        return false;
    }

    const activeProfile = getActiveProfile(normalizedState);
    if (!activeProfile) {
        return true;
    }

    if (!currentUserId || activeProfile.ProfileUserId !== currentUserId) {
        return true;
    }

    if (activeProfile.RequiresPin) {
        return unlockedProfileUserId !== currentUserId;
    }

    return false;
}

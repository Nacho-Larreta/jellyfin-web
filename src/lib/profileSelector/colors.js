export const PROFILE_SELECTOR_AVATAR_GRADIENTS = [
    'linear-gradient(135deg, #d51f28 0%, #8f1017 100%)',
    'linear-gradient(135deg, #4cb7f5 0%, #176c9f 100%)',
    'linear-gradient(135deg, #9d4edd 0%, #4f1d75 100%)',
    'linear-gradient(135deg, #f7b733 0%, #d56d15 100%)',
    'linear-gradient(135deg, #00b894 0%, #00695f 100%)'
];

export function getProfileAvatarColorIndex(index) {
    return (index % PROFILE_SELECTOR_AVATAR_GRADIENTS.length) + 1;
}

export function getProfileAvatarColorClass(index) {
    return `profileSelectorCardAvatarColor${getProfileAvatarColorIndex(index)}`;
}

export function getProfileAvatarGradient(index) {
    return PROFILE_SELECTOR_AVATAR_GRADIENTS[index % PROFILE_SELECTOR_AVATAR_GRADIENTS.length];
}

export function getProfileAvatarGradientForUser(selector, userId) {
    if (!selector?.Profiles?.length || !userId) {
        return null;
    }

    const visibleProfiles = selector.Profiles
        .filter(profile => profile?.IsVisible !== false)
        .sort((left, right) => {
            if (!!left.IsOwner !== !!right.IsOwner) {
                return left.IsOwner ? -1 : 1;
            }

            return (left.DisplayOrder || 0) - (right.DisplayOrder || 0);
        });
    const profileIndex = visibleProfiles.findIndex(profile => profile.ProfileUserId === userId);

    if (profileIndex < 0) {
        return null;
    }

    return getProfileAvatarGradient(profileIndex);
}

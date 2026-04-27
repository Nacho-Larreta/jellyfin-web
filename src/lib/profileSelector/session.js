const UNLOCKED_PROFILE_STORAGE_KEY_PREFIX = 'jellyfin_profile_selector_unlocked_';

function getUnlockedProfileStorageKey(serverId) {
    return `${UNLOCKED_PROFILE_STORAGE_KEY_PREFIX}${serverId || 'unknown'}`;
}

export function getUnlockedProfileUserId(serverId) {
    if (!serverId || typeof window === 'undefined' || !window.sessionStorage) {
        return null;
    }

    return window.sessionStorage.getItem(getUnlockedProfileStorageKey(serverId));
}

export function setUnlockedProfileUserId(serverId, profileUserId) {
    if (!serverId || !profileUserId || typeof window === 'undefined' || !window.sessionStorage) {
        return;
    }

    window.sessionStorage.setItem(getUnlockedProfileStorageKey(serverId), profileUserId);
}

export function clearUnlockedProfileUserId(serverId) {
    if (!serverId || typeof window === 'undefined' || !window.sessionStorage) {
        return;
    }

    window.sessionStorage.removeItem(getUnlockedProfileStorageKey(serverId));
}

export function clearAllUnlockedProfileUserIds() {
    if (typeof window === 'undefined' || !window.sessionStorage) {
        return;
    }

    for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
        const key = window.sessionStorage.key(index);
        if (key?.startsWith(UNLOCKED_PROFILE_STORAGE_KEY_PREFIX)) {
            window.sessionStorage.removeItem(key);
        }
    }
}

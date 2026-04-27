import { normalizeProfileSelectorState } from './utils';

export async function getCurrentProfileSelector(apiClient) {
    try {
        const selector = await apiClient.getJSON(apiClient.getUrl('ProfileSelectors/Current'), true);
        return normalizeProfileSelectorState(selector);
    } catch (response) {
        if (response?.status === 404) {
            return null;
        }

        throw response;
    }
}

export async function getOwnerProfileSelector(apiClient, ownerUserId) {
    try {
        const selector = await apiClient.getJSON(apiClient.getUrl(`Users/${ownerUserId}/ProfileSelector`), true);
        return normalizeProfileSelectorState(selector);
    } catch (response) {
        if (response?.status === 404) {
            return null;
        }

        throw response;
    }
}

export async function getSecondaryProfileUserIds(apiClient) {
    try {
        return await apiClient.getJSON(apiClient.getUrl('ProfileSelectors/SecondaryProfileUserIds'), true);
    } catch (response) {
        if (response?.status === 404) {
            return [];
        }

        throw response;
    }
}

export async function activateProfile(apiClient, profileUserId, pin) {
    const response = await apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl(`ProfileSelectors/Current/Profiles/${profileUserId}/Activate`),
        contentType: 'application/json',
        data: JSON.stringify(pin ? { Pin: pin } : {})
    });

    return response.json();
}

export async function createProfileBackingUser(apiClient, name, password) {
    const response = await apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl('Users/New'),
        contentType: 'application/json',
        data: JSON.stringify({
            Name: name,
            Password: password
        })
    });

    return response.json();
}

export async function updateProfileSelector(apiClient, ownerUserId, payload) {
    const response = await apiClient.ajax({
        type: 'PUT',
        url: apiClient.getUrl(`Users/${ownerUserId}/ProfileSelector`),
        contentType: 'application/json',
        data: JSON.stringify(payload)
    });

    return response.json();
}

export async function setProfilePin(apiClient, ownerUserId, profileUserId, pin) {
    await apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl(`Users/${ownerUserId}/ProfileSelector/Profiles/${profileUserId}/Pin`),
        contentType: 'application/json',
        data: JSON.stringify({ Pin: pin })
    });
}

export async function clearProfilePin(apiClient, ownerUserId, profileUserId, pin) {
    const request = {
        type: 'DELETE',
        url: apiClient.getUrl(`Users/${ownerUserId}/ProfileSelector/Profiles/${profileUserId}/Pin`)
    };

    if (pin) {
        request.contentType = 'application/json';
        request.data = JSON.stringify({ Pin: pin });
    }

    await apiClient.ajax(request);
}

export async function parseProfileSelectorError(response) {
    const defaultError = {
        status: response?.status || 500,
        code: null,
        detail: null
    };

    if (!response?.json) {
        return defaultError;
    }

    try {
        const problem = await response.json();
        return {
            status: response.status,
            code: problem?.code || problem?.title || null,
            detail: problem?.detail || null
        };
    } catch {
        return defaultError;
    }
}

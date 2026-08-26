import { ServerConnections } from 'lib/jellyfin-apiclient';

import { activateProfile } from './api';
import { getWebSessionSwitchApplication } from './sessionSwitch/application';
import { clearUnlockedProfileUserId, getUnlockedProfileUserId } from './session';
import { getAutoActivationCandidate, getProfileSelectorRoute, isProfileSelectionRequired } from './utils';

async function autoActivateProfile(apiClient, candidate) {
    const activationResult = await activateProfile(apiClient, candidate.ProfileUserId);
    await ServerConnections.applyAuthenticationResult(apiClient.serverId(), activationResult.AuthenticationResult);
    clearUnlockedProfileUserId(apiClient.serverId());
}

export async function resolveProfileSelectorRoute(apiClient, targetUrl = '/home') {
    const { selector } = await getWebSessionSwitchApplication(ServerConnections)
        .prepareProtectedRoute(apiClient);
    if (!selector?.IsEnabled) {
        clearUnlockedProfileUserId(apiClient.serverId());
        return targetUrl;
    }

    const unlockedProfileUserId = getUnlockedProfileUserId(apiClient.serverId());
    const autoActivationCandidate = getAutoActivationCandidate(selector, apiClient.getCurrentUserId(), unlockedProfileUserId);

    if (autoActivationCandidate && autoActivationCandidate.ProfileUserId !== apiClient.getCurrentUserId()) {
        await autoActivateProfile(apiClient, autoActivationCandidate);
        return targetUrl;
    }

    if (isProfileSelectionRequired(selector, apiClient.getCurrentUserId(), unlockedProfileUserId)) {
        return getProfileSelectorRoute(targetUrl);
    }

    return targetUrl;
}

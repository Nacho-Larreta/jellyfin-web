import { playbackManager } from 'components/playback/playbackmanager';
import viewContainer from 'components/viewContainer';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from 'utils/events';
import { queryClient } from 'utils/query/queryClient';

import { activateProfile } from './api';
import { clearUnlockedProfileUserId, setUnlockedProfileUserId } from './session';

function waitForPlaybackReport(timeoutMs = 1500) {
    return new Promise(resolve => {
        const onReportPlayback = () => {
            Events.off(playbackManager, 'reportplayback', onReportPlayback);
            clearTimeout(timeout);
            resolve();
        };

        const timeout = setTimeout(() => {
            Events.off(playbackManager, 'reportplayback', onReportPlayback);
            resolve();
        }, timeoutMs);

        Events.on(playbackManager, 'reportplayback', onReportPlayback);
    });
}

export async function stopPlaybackBeforeProfileSwitch() {
    const player = playbackManager.getCurrentPlayer();
    if (!player) {
        return;
    }

    try {
        const currentItem = playbackManager.currentItem(player);
        if (!currentItem) {
            return;
        }

        const reportPromise = waitForPlaybackReport();
        await playbackManager.stop(player);
        await reportPromise;
    } catch (err) {
        console.warn('[ProfileSelector] unable to stop active playback before profile switch', err);
    }
}

export async function prepareClientForProfileSwitch() {
    queryClient.clear();
    viewContainer.reset();

    await new Promise(resolve => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(resolve);
        });
    });
}

export async function activateProfileSession(apiClient, profile, pin) {
    await stopPlaybackBeforeProfileSwitch();
    const activationResult = await activateProfile(apiClient, profile.ProfileUserId, pin);

    if (profile.RequiresPin) {
        setUnlockedProfileUserId(apiClient.serverId(), profile.ProfileUserId);
    } else {
        clearUnlockedProfileUserId(apiClient.serverId());
    }

    await ServerConnections.applyAuthenticationResult(apiClient.serverId(), activationResult.AuthenticationResult);
    await prepareClientForProfileSwitch();

    return activationResult;
}

export function reloadIntoProfileTarget(targetUrl) {
    const normalizedTargetUrl = targetUrl.startsWith('/') ? targetUrl : `/${targetUrl}`;
    window.location.hash = normalizedTargetUrl;
    window.location.reload();
}

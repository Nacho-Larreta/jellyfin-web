import { playbackManager } from 'components/playback/playbackmanager';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from 'utils/events.ts';
import {
    clearAutocastPreference,
    createCastActivationOwner,
    readAutocastPreference,
    writeAutocastPreference
} from 'components/playback/castActivationAuthority';

export async function enable(enabled) {
    console.debug('[autocast] %s cast player', enabled ? 'enabling' : 'disabling');
    if (enabled) {
        const currentPlayerInfo = playbackManager.getPlayerInfo();
        const owner = playbackManager.getCurrentPlayer()?.getConnectionOwner?.();
        if (!currentPlayerInfo?.id || !owner?.current()) return false;
        const result = await writeAutocastPreference(owner, currentPlayerInfo.id);
        const stillSelected = owner.current()
            && playbackManager.getCurrentPlayer()?.getConnectionOwner?.() === owner
            && playbackManager.getPlayerInfo()?.id === currentPlayerInfo.id;
        if (!stillSelected && result.token) await clearAutocastPreference(owner, result.token);
        return result.status === 'written' && stillSelected;
    } else {
        const owner = createCastActivationOwner();
        const cleared = await clearAutocastPreference(owner);
        owner?.retire();
        return cleared;
    }
}

export async function isEnabled() {
    const owner = createCastActivationOwner();
    const result = await readAutocastPreference(owner);
    const currentPlayerInfo = playbackManager.getPlayerInfo();
    owner?.retire();
    return result.status === 'read' ? Boolean(result.value?.playerId && currentPlayerInfo?.id === result.value.playerId) : null;
}

async function onOpen() {
    const owner = createCastActivationOwner(this);
    const selectionRevision = playbackManager.getCastSelectionRevision();
    if (!playbackManager.canRestoreOwnedCast(owner, selectionRevision)) {
        owner?.retire();
        return;
    }
    const result = await readAutocastPreference(owner);
    if (!playbackManager.canRestoreOwnedCast(owner, selectionRevision)) {
        owner?.retire();
        return;
    }
    const playerId = result.status === 'read' ? result.value?.playerId : null;
    if (!playerId) {
        owner?.retire();
        return;
    }

    playbackManager.getTargets().then(targets => {
        if (!playbackManager.canRestoreOwnedCast(owner, selectionRevision)) {
            owner.retire();
            return;
        }
        const player = targets.find(target => target.id === playerId && target.playerName === 'Google Cast');
        if (player) void playbackManager.tryRestoreActivePlayer(player.playerName, player, owner, selectionRevision);
        else owner.retire();
    }).catch(() => owner.retire());
}

export function initialize() {
    console.debug('[autoCast] initializing connection listener');
    ServerConnections.getApiClients().forEach(apiClient => {
        Events.off(apiClient, 'websocketopen', onOpen);
        Events.on(apiClient, 'websocketopen', onOpen);
    });

    Events.on(ServerConnections, 'apiclientcreated', (e, apiClient) => {
        Events.off(apiClient, 'websocketopen', onOpen);
        Events.on(apiClient, 'websocketopen', onOpen);
    });
}

import type { ApiClient } from 'jellyfin-apiclient';

import type { FreshSessionAuthority } from 'lib/profileSelector/sessionSwitch/boundRequests';
import type { SessionSwitchCompletionReceipt } from 'lib/profileSelector/sessionSwitch/model';

export interface PublishedAuthority {
    readonly client: ApiClient;
    readonly serverId: string;
    readonly userId: string;
    readonly token: string;
    readonly epoch: number;
    readonly revision: number;
    readonly selectorEnabled: boolean;
}

export function verifiedAuthority(
    client: ApiClient,
    fresh: FreshSessionAuthority | null,
    currentClient: ApiClient | null | undefined,
    registeredClient: ApiClient | null | undefined
): PublishedAuthority | null {
    if (!fresh || currentClient !== client || registeredClient !== client
        || fresh.serverId !== client.serverId()
        || !fresh.userId || !fresh.accessToken
        || client.getCurrentUserId() !== fresh.userId
        || client.accessToken() !== fresh.accessToken
        || !Number.isSafeInteger(fresh.authorityRevision)
        || fresh.authorityRevision < 0) return null;

    let epoch = 0;
    if (fresh.selectorEnabled === true) {
        const active = fresh.envelope?.activeSession;
        if (!active || fresh.envelope?.marker !== null
            || active.serverId !== fresh.serverId
            || active.deviceId !== client.deviceId()
            || active.profileUserId !== fresh.userId
            || active.credentialRef.token !== fresh.accessToken) return null;
        epoch = active.sessionEpoch;
    } else if (fresh.selectorEnabled !== false || fresh.envelope !== null) {
        return null;
    }

    return {
        client,
        serverId: fresh.serverId,
        userId: fresh.userId,
        token: fresh.accessToken,
        epoch,
        revision: fresh.authorityRevision,
        selectorEnabled: fresh.selectorEnabled
    };
}

export function samePublication(left: PublishedAuthority, right: PublishedAuthority): boolean {
    return left.client === right.client
        && left.serverId === right.serverId
        && left.userId === right.userId
        && left.token === right.token
        && left.epoch === right.epoch
        && left.revision === right.revision
        && left.selectorEnabled === right.selectorEnabled;
}

export function sameRestoredSession(left: PublishedAuthority, right: PublishedAuthority): boolean {
    return left.serverId === right.serverId
        && left.userId === right.userId
        && left.token === right.token
        && left.epoch === right.epoch
        && left.selectorEnabled === right.selectorEnabled;
}

export function capturePendingOldAuthority(
    client: ApiClient,
    fresh: FreshSessionAuthority,
    registeredClient: ApiClient | null | undefined
): PublishedAuthority | null {
    const marker = fresh.envelope?.marker;
    const token = client.accessToken();
    if (fresh.selectorEnabled !== true || !marker || marker.kind === 'QuarantinedSession'
        || registeredClient !== client || !token
        || marker.serverId !== fresh.serverId || marker.deviceId !== client.deviceId()
        || client.serverId() !== fresh.serverId
        || client.getCurrentUserId() !== marker.oldProfileUserId
        || !Number.isSafeInteger(fresh.authorityRevision)
        || fresh.authorityRevision < 0) return null;

    if (marker.kind === 'PendingSwitch'
        && (fresh.envelope?.activeSession.profileUserId !== marker.oldProfileUserId
            || fresh.envelope.activeSession.sessionEpoch !== marker.oldEpoch
            || fresh.envelope.activeSession.credentialRef.token !== token)) return null;

    return {
        client,
        serverId: fresh.serverId,
        userId: marker.oldProfileUserId,
        token,
        epoch: marker.oldEpoch,
        revision: fresh.authorityRevision,
        selectorEnabled: true
    };
}

export function matchesCompletion(
    fresh: FreshSessionAuthority,
    switchId: string,
    candidate: PublishedAuthority
): boolean {
    const completion: SessionSwitchCompletionReceipt | null | undefined = fresh.envelope?.lastCompletion;
    return fresh.selectorEnabled === true
        && fresh.envelope?.marker === null
        && completion?.switchId === switchId
        && completion.serverId === candidate.serverId
        && completion.profileUserId === candidate.userId
        && completion.sessionEpoch === candidate.epoch;
}

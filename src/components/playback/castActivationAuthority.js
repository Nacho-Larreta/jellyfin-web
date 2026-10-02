import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import Events from 'utils/events.ts';
import {
    checkCastReceipt,
    claimRestoredCastReceipt,
    clearCastPreference,
    confirmCastReceipt,
    readCastPreference,
    reserveCastReceipt,
    revokeOwnedCastReceipt,
    revokeCastReceipt,
    writeCastPreference
} from './castReceiptStore';

const AUTHORITY_EVENTS = ['localusersignedin', 'localusersignedout', 'sessionswitchcompleted'];
const receiptByOwner = new WeakMap();
const preferenceByOwner = new WeakMap();

export function createCastActivationOwner(client = ServerConnections.currentApiClient?.()) {
    if (!client?.serverId?.()) return null;
    const serverId = client.serverId();
    let application;
    let port;
    let authority;
    let owner;
    let retired = false;
    const listeners = new Set();
    let unsubscribeEnvelope;
    let unsubscribeAdmission;

    const retire = () => {
        if (retired) return;
        retired = true;
        unsubscribeEnvelope?.();
        unsubscribeAdmission?.();
        for (const event of AUTHORITY_EVENTS) Events.off(ServerConnections, event, inspect);
        for (const listener of listeners) listener();
        listeners.clear();
    };
    const current = () => {
        if (retired || !port) return false;
        try {
            port.assertCurrent();
            return true;
        } catch {
            const preferenceToken = preferenceByOwner.get(owner);
            if (preferenceToken) void clearCastPreference(owner, preferenceToken);
            const receiptToken = receiptByOwner.get(owner);
            if (receiptToken) void revokeCastReceipt(receiptToken);
            retire();
            return false;
        }
    };
    const inspect = () => {
        current();
    };

    try {
        application = getWebSessionSwitchApplication(ServerConnections);
        unsubscribeEnvelope = ServerConnections.subscribeSessionSwitchEnvelope(serverId, inspect);
        unsubscribeAdmission = application.subscribeSessionAdmission(serverId, inspect);
        for (const event of AUTHORITY_EVENTS) Events.on(ServerConnections, event, inspect);
        port = application.captureBoundSessionRead(client);
        authority = ServerConnections.readFreshSessionAuthority(serverId);
        if (!port || !authority || !current()) {
            retire();
            return null;
        }
        owner = Object.freeze({
            serverId,
            profileUserId: port.binding.profileUserId,
            deviceId: port.binding.deviceId,
            sessionEpoch: port.binding.sessionEpoch,
            authorityRevision: authority.authorityRevision,
            credential: Object.freeze({
                userId: port.binding.profileUserId,
                deviceId: port.binding.deviceId,
                accessToken: port.binding.credentialRef.token,
                serverId,
                serverVersion: client.serverVersion(),
                serverAddress: receiverAddress(client, port.basePath)
            }),
            current,
            retire,
            onInvalidated(listener) {
                if (!current()) listener();
                else listeners.add(listener);
                return () => listeners.delete(listener);
            }
        });
        if (!owner.credential.serverAddress
            || port.identity.authorityGeneration.split(':')[0] !== String(authority.authorityRevision)
            || !owner.current()) {
            owner.retire();
            return null;
        }
        return owner;
    } catch {
        retire();
        return null;
    }
}

function receiverAddress(client, basePath) {
    const url = new URL(basePath);
    if (url.hostname !== 'localhost' && !url.hostname.startsWith('127.') && url.hostname !== '[::1]') return basePath;
    const localAddress = client.serverInfo()?.LocalAddress;
    if (typeof localAddress !== 'string') return null;
    try {
        const reachable = new URL(localAddress);
        if (!['http:', 'https:'].includes(reachable.protocol) || reachable.username || reachable.password || reachable.search || reachable.hash) return null;
        return reachable.href.replace(/\/$/, '');
    } catch {
        return null;
    }
}

export async function readAutocastPreference(owner) {
    if (!owner?.current()) return { status: 'inactive' };
    const result = await readCastPreference(owner);
    if (!owner.current()) return { status: 'inactive' };
    if (result.value) preferenceByOwner.set(owner, result.value);
    return result;
}

export async function writeAutocastPreference(owner, playerId) {
    if (!owner?.current() || typeof playerId !== 'string' || !playerId) return { status: 'inactive' };
    const result = await writeCastPreference(owner, playerId);
    if (!owner.current()) {
        if (result.token) void clearCastPreference(owner, result.token);
        return { status: 'inactive' };
    }
    if (result.token) preferenceByOwner.set(owner, result.token);
    return result;
}

export async function clearAutocastPreference(owner, expectedToken) {
    const result = expectedToken ? { status: 'read', value: expectedToken } : await readAutocastPreference(owner);
    if (result.status !== 'read' || !owner.current()) return false;
    if (!result.value) return true;
    const cleared = await clearCastPreference(owner, result.value);
    return owner.current() && cleared.status === 'cleared';
}

export async function reserveCastConnectionReceipt(owner, playerId) {
    if (!owner?.current() || typeof playerId !== 'string' || !playerId) return { status: 'inactive' };
    const result = await reserveCastReceipt(owner, playerId);
    if (!owner.current()) {
        if (result.token) void revokeCastReceipt(result.token);
        return { status: 'inactive' };
    }
    if (result.token) receiptByOwner.set(owner, result.token);
    return result;
}

export async function readRestoredCastReceipt(owner, session, playerId) {
    if (!owner?.current() || !session?.receiver?.label || !session.sessionId) return { status: 'inactive' };
    const result = await claimRestoredCastReceipt(owner, playerId, session);
    if (!owner.current()) {
        if (result.token) void revokeCastReceipt(result.token);
        return { status: 'inactive' };
    }
    if (result.token) receiptByOwner.set(owner, result.token);
    return result;
}

export async function writeCastConnectionReceipt(owner, playerId, session, token) {
    if (!owner?.current() || !session?.receiver?.label || !session.sessionId || !token) return { status: 'inactive' };
    const result = await confirmCastReceipt(owner, playerId, session, token);
    return owner.current() ? result : { status: 'inactive' };
}

export async function checkCastConnectionReceipt(owner, token) {
    if (!owner?.current()) return { status: 'inactive' };
    const result = await checkCastReceipt(token);
    return owner.current() ? result : { status: 'inactive' };
}

export function clearCastConnectionReceipt(_owner, _session, token) {
    if (token) return revokeCastReceipt(token);
    return Promise.resolve({ status: 'missing' });
}

export function revokeCastConnectionForLocalChoice(owner, playerId, isCurrent) {
    if (!owner?.current()) return Promise.resolve({ status: 'inactive' });
    return revokeOwnedCastReceipt(owner, playerId, isCurrent);
}

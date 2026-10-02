const DATABASE_NAME = 'jellyfin-cast-ownership';
const STORE_NAME = 'slots';
const VERSION = 1;
const PREFERENCE_KEY = 'preference';

function validIdentity(owner) {
    return [owner?.serverId, owner?.profileUserId, owner?.deviceId]
        .every(value => typeof value === 'string' && value.length > 0)
        && [owner.sessionEpoch, owner.authorityRevision]
            .every(value => Number.isSafeInteger(value) && value >= 0);
}

function validPlayer(playerId) {
    return typeof playerId === 'string' && playerId.length > 0;
}

function validSession(session) {
    return typeof session?.receiver?.label === 'string' && session.receiver.label.length > 0
        && typeof session.sessionId === 'string' && session.sessionId.length > 0;
}

function validReceiptToken(token) {
    if (!Number.isSafeInteger(token?.generation) || token.generation < 1
        || typeof token.operationId !== 'string' || !token.operationId) return false;
    try {
        const parts = JSON.parse(token.key);
        return Array.isArray(parts) && parts.length === 7 && parts[0] === 'receipt'
            && parts.slice(1, 4).every(part => typeof part === 'string' && part.length > 0)
            && parts.slice(4, 6).every(part => Number.isSafeInteger(part) && part >= 0)
            && validPlayer(parts[6]);
    } catch {
        return false;
    }
}

function operationId() {
    const browserCrypto = globalThis['crypto'];
    if (!browserCrypto?.getRandomValues) throw new Error('Cast ownership needs secure randomness');
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error('Cast storage unavailable'));
            return;
        }
        const request = indexedDB.open(DATABASE_NAME, VERSION);
        let blocked = false;
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        };
        request.onsuccess = () => {
            const database = request.result;
            if (blocked) {
                database.close();
                return;
            }
            database.onversionchange = () => database.close();
            resolve(database);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            blocked = true;
            reject(new Error('Cast storage upgrade blocked'));
        };
    });
}

async function transact(key, change) {
    let database;
    try {
        database = await openDatabase();
        return await new Promise(resolve => {
            let transaction;
            try {
                transaction = database.transaction(STORE_NAME, 'readwrite');
            } catch {
                resolve({ status: 'unavailable' });
                return;
            }
            let result = { status: 'unavailable' };
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => {
                try {
                    result = change(request.result, store);
                } catch {
                    transaction.abort();
                }
            };
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = () => resolve({ status: 'unavailable' });
        });
    } catch {
        return { status: 'unavailable' };
    } finally {
        database?.close();
    }
}

function identity(owner) {
    return {
        serverId: owner.serverId,
        profileUserId: owner.profileUserId,
        deviceId: owner.deviceId,
        sessionEpoch: owner.sessionEpoch,
        authorityRevision: owner.authorityRevision
    };
}

function sameIdentity(record, owner) {
    return record?.version === VERSION
        && record.serverId === owner.serverId
        && record.profileUserId === owner.profileUserId
        && record.deviceId === owner.deviceId
        && record.sessionEpoch === owner.sessionEpoch
        && record.authorityRevision === owner.authorityRevision;
}

function sameOperation(record, token) {
    return record?.version === VERSION && record.key === token.key
        && record.generation === token.generation && record.operationId === token.operationId;
}

function validPreferenceRecord(record) {
    return record?.key === PREFERENCE_KEY && record.kind === 'preference'
        && record.version === VERSION && validIdentity(record)
        && (record.state === 'enabled' ? validPlayer(record.playerId) : record.state === 'revoked' && record.playerId === null)
        && Number.isSafeInteger(record.generation) && record.generation >= 1
        && typeof record.operationId === 'string' && record.operationId.length > 0;
}

function receiptKey(owner, playerId) {
    return JSON.stringify(['receipt', owner.serverId, owner.profileUserId, owner.deviceId,
        owner.sessionEpoch, owner.authorityRevision, playerId]);
}

function nextToken(key, previous) {
    if (previous && (previous.key !== key || previous.version !== VERSION
        || previous.kind !== (key === PREFERENCE_KEY ? 'preference' : 'receipt')
        || !Number.isSafeInteger(previous.generation) || previous.generation < 0
        || previous.generation === Number.MAX_SAFE_INTEGER
        || typeof previous.operationId !== 'string' || !previous.operationId)) {
        throw new Error('Cast ownership record invalid');
    }
    const generation = previous ? previous.generation + 1 : 1;
    return { key, generation, operationId: operationId() };
}

function nextPreferenceToken(previous) {
    if (validPreferenceRecord(previous) && previous.generation === Number.MAX_SAFE_INTEGER) {
        throw new Error('Cast preference generation exhausted');
    }
    const generation = Number.isSafeInteger(previous?.generation)
        && previous.generation >= 0 && previous.generation < Number.MAX_SAFE_INTEGER ?
        previous.generation + 1 : 1;
    return { key: PREFERENCE_KEY, generation, operationId: operationId() };
}

function receiptFields(owner, playerId) {
    return { version: VERSION, ...identity(owner), playerId, kind: 'receipt' };
}

export function reserveCastReceipt(owner, playerId) {
    if (!validIdentity(owner) || !validPlayer(playerId)) return Promise.resolve({ status: 'invalid' });
    const key = receiptKey(owner, playerId);
    return transact(key, (previous, store) => {
        const token = nextToken(key, previous);
        store.put({ ...receiptFields(owner, playerId), ...token, state: 'pending' });
        return { status: 'reserved', token };
    });
}

export function confirmCastReceipt(owner, playerId, session, token) {
    if (!validIdentity(owner) || !validPlayer(playerId) || !validSession(session)
        || !validReceiptToken(token) || token.key !== receiptKey(owner, playerId)) {
        return Promise.resolve({ status: 'invalid' });
    }
    return transact(token.key, (record, store) => {
        if (record?.kind !== 'receipt' || !sameOperation(record, token) || !sameIdentity(record, owner)
            || record.playerId !== playerId || record.state !== 'pending') return { status: 'superseded' };
        store.put({ ...record, state: 'confirmed', receiverLabel: session.receiver.label, sessionId: session.sessionId });
        return { status: 'confirmed' };
    });
}

export function claimRestoredCastReceipt(owner, playerId, session) {
    if (!validIdentity(owner) || !validPlayer(playerId) || !validSession(session)) {
        return Promise.resolve({ status: 'invalid' });
    }
    const key = receiptKey(owner, playerId);
    return transact(key, (record, store) => {
        if (!sameIdentity(record, owner) || record.kind !== 'receipt' || record.playerId !== playerId
            || record.state !== 'confirmed' || record.receiverLabel !== session?.receiver?.label
            || record.sessionId !== session?.sessionId) return { status: 'missing' };
        const token = nextToken(key, record);
        store.put({ ...record, ...token });
        return { status: 'claimed', token, receipt: record };
    });
}

export function checkCastReceipt(token) {
    if (!validReceiptToken(token)) {
        return Promise.resolve({ status: 'invalid' });
    }
    return transact(token.key, record => ({ status: record?.kind === 'receipt' && sameOperation(record, token)
        && ['pending', 'confirmed'].includes(record.state) ? 'current' : 'superseded' }));
}

export function revokeCastReceipt(token) {
    if (!validReceiptToken(token)) {
        return Promise.resolve({ status: 'invalid' });
    }
    return transact(token.key, (record, store) => {
        if (record?.kind !== 'receipt' || !sameOperation(record, token)
            || !['pending', 'confirmed'].includes(record.state)) return { status: 'superseded' };
        store.put({ ...record, state: 'revoked', receiverLabel: null, sessionId: null });
        return { status: 'revoked' };
    });
}

export function revokeOwnedCastReceipt(owner, playerId, isCurrent = () => true) {
    if (!validIdentity(owner) || !validPlayer(playerId)) return Promise.resolve({ status: 'invalid' });
    const key = receiptKey(owner, playerId);
    return transact(key, (record, store) => {
        if (!isCurrent() || !sameIdentity(record, owner) || record.kind !== 'receipt'
            || record.playerId !== playerId || record.state !== 'confirmed') return { status: 'superseded' };
        store.put({ ...record, state: 'revoked', receiverLabel: null, sessionId: null });
        return { status: 'revoked' };
    });
}

export function readCastPreference(owner) {
    if (!validIdentity(owner)) return Promise.resolve({ status: 'invalid' });
    return transact(PREFERENCE_KEY, record => ({ status: 'read', value: validPreferenceRecord(record)
        && sameIdentity(record, owner) && record.state === 'enabled' ? record : null }));
}

export function writeCastPreference(owner, playerId) {
    if (!validIdentity(owner) || !validPlayer(playerId)) return Promise.resolve({ status: 'invalid' });
    return transact(PREFERENCE_KEY, (previous, store) => {
        const token = nextPreferenceToken(previous);
        store.put({ key: PREFERENCE_KEY, kind: 'preference', state: 'enabled', version: VERSION,
            ...identity(owner), playerId, ...token });
        return { status: 'written', token };
    });
}

export function clearCastPreference(owner, token) {
    if (!validIdentity(owner) || token?.key !== PREFERENCE_KEY
        || !Number.isSafeInteger(token.generation) || typeof token.operationId !== 'string') {
        return Promise.resolve({ status: 'invalid' });
    }
    return transact(PREFERENCE_KEY, (record, store) => {
        if (!sameIdentity(record, owner) || !sameOperation(record, token)
            || record.kind !== 'preference' || record.state !== 'enabled') return { status: 'superseded' };
        store.put({ ...record, state: 'revoked', playerId: null });
        return { status: 'cleared' };
    });
}

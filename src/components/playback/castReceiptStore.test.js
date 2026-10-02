import { afterEach, describe, expect, it } from 'vitest';

import {
    checkCastReceipt,
    clearCastPreference,
    confirmCastReceipt,
    reserveCastReceipt,
    revokeCastReceipt,
    revokeOwnedCastReceipt,
    readCastPreference,
    writeCastPreference
} from './castReceiptStore';

const owner = {
    serverId: 'server', profileUserId: 'profile', deviceId: 'device',
    sessionEpoch: 1, authorityRevision: 2
};

const schedule = callback => Promise.resolve().then(callback);

function installStorage(initial) {
    const records = new Map(initial ? [['preference', initial]] : []);
    globalThis.indexedDB = {
        open() {
            const request = {};
            void schedule(() => {
                request.result = {
                    objectStoreNames: { contains: () => true },
                    close() { return undefined; },
                    transaction() {
                        const transaction = {
                            objectStore: () => ({
                                get(key) {
                                    const read = {};
                                    void schedule(() => {
                                        read.result = records.get(key);
                                        read.onsuccess();
                                        void schedule(() => transaction.oncomplete());
                                    });
                                    return read;
                                },
                                put(record) { records.set(record.key, record); }
                            }),
                            abort() { void schedule(() => transaction.onabort()); }
                        };
                        return transaction;
                    }
                };
                request.onsuccess();
            });
            return request;
        }
    };
    return records;
}

afterEach(() => {
    delete globalThis.indexedDB;
});

describe('explicit Cast preference repair', () => {
    it.each([
        { version: 0, generation: 7, operationId: 'old-operation' },
        { version: 99, generation: 'bad', operationId: null },
        { version: 1, generation: 'bad', operationId: null }
    ])('does not auto-enable an invalid record but allows a transactional replacement', async invalid => {
        installStorage({ key: 'preference', kind: 'preference', state: 'enabled',
            ...owner, playerId: 'Google Cast', ...invalid });
        expect((await readCastPreference(owner)).value).toBeNull();

        const first = await writeCastPreference(owner, 'Google Cast');
        expect(first.status).toBe('written');
        expect((await readCastPreference(owner)).value.playerId).toBe('Google Cast');

        const successor = await writeCastPreference(owner, 'Google Cast');
        expect(successor.status).toBe('written');
        expect(await clearCastPreference(owner, first.token)).toMatchObject({ status: 'superseded' });
        expect((await readCastPreference(owner)).value.operationId).toBe(successor.token.operationId);
    });

    it('fails closed at the maximum generation without resetting a valid preference', async () => {
        const record = { key: 'preference', kind: 'preference', state: 'enabled', version: 1,
            ...owner, playerId: 'Google Cast', generation: Number.MAX_SAFE_INTEGER, operationId: 'last' };
        const records = installStorage(record);
        expect(await writeCastPreference(owner, 'Google Cast')).toMatchObject({ status: 'unavailable' });
        expect(records.get('preference')).toEqual(record);
    });
});

describe('local choice without a loaded Cast plugin', () => {
    const receiverSession = { sessionId: 'old-session', receiver: { label: 'living-room' } };

    it('revokes only the same-authority confirmed receipt; a later explicit reservation survives', async () => {
        installStorage();
        const old = await reserveCastReceipt(owner, 'Google Cast');
        expect(await confirmCastReceipt(owner, 'Google Cast', receiverSession, old.token))
            .toMatchObject({ status: 'confirmed' });

        expect(await revokeOwnedCastReceipt(owner, 'Google Cast')).toMatchObject({ status: 'revoked' });
        expect(await checkCastReceipt(old.token)).toMatchObject({ status: 'superseded' });
        const newer = await reserveCastReceipt(owner, 'Google Cast');
        expect(newer.token.generation).toBeGreaterThan(old.token.generation);
        expect(await confirmCastReceipt(owner, 'Google Cast', receiverSession, newer.token))
            .toMatchObject({ status: 'confirmed' });
        expect(await revokeCastReceipt(old.token)).toMatchObject({ status: 'superseded' });
        expect(await checkCastReceipt(newer.token)).toMatchObject({ status: 'current' });
    });

    it('does not revoke another document’s pending explicit reservation', async () => {
        installStorage();
        const old = await reserveCastReceipt(owner, 'Google Cast');
        await confirmCastReceipt(owner, 'Google Cast', receiverSession, old.token);
        const newer = await reserveCastReceipt(owner, 'Google Cast');

        expect(await revokeOwnedCastReceipt(owner, 'Google Cast')).toMatchObject({ status: 'superseded' });
        expect(await confirmCastReceipt(owner, 'Google Cast', receiverSession, newer.token))
            .toMatchObject({ status: 'confirmed' });
        expect(await checkCastReceipt(newer.token)).toMatchObject({ status: 'current' });
    });

    it('treats a fully confirmed B receipt as older when A local transaction follows it in storage order', async () => {
        installStorage();
        const older = await reserveCastReceipt(owner, 'Google Cast');
        await confirmCastReceipt(owner, 'Google Cast', receiverSession, older.token);
        const confirmedB = await reserveCastReceipt(owner, 'Google Cast');
        await confirmCastReceipt(owner, 'Google Cast', receiverSession, confirmedB.token);

        expect(await revokeOwnedCastReceipt(owner, 'Google Cast')).toMatchObject({ status: 'revoked' });
        expect(await checkCastReceipt(confirmedB.token)).toMatchObject({ status: 'superseded' });
    });
});

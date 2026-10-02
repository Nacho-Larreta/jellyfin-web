import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    client: null,
    authority: null,
    captured: null,
    envelopeListener: null,
    admissionListener: null,
    preference: null,
    receipt: null,
    generation: 0
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        currentApiClient: () => state.client,
        subscribeSessionSwitchEnvelope: (_serverId, listener) => {
            state.envelopeListener = listener;
            return () => {
                state.envelopeListener = null;
            };
        },
        readFreshSessionAuthority: () => state.authority
    }
}));
vi.mock('lib/profileSelector/sessionSwitch/application', () => ({
    getWebSessionSwitchApplication: () => ({
        captureBoundSessionRead: () => state.captured,
        subscribeSessionAdmission: (_serverId, listener) => {
            state.admissionListener = listener;
            return () => {
                state.admissionListener = null;
            };
        }
    })
}));
vi.mock('./castReceiptStore', () => {
    const matches = (record, owner) => record?.profileUserId === owner.profileUserId
        && record.authorityRevision === owner.authorityRevision && record.sessionEpoch === owner.sessionEpoch;
    return {
        readCastPreference: vi.fn(async owner => ({ status: 'read', value: matches(state.preference, owner) ? state.preference : null })),
        writeCastPreference: vi.fn(async (owner, playerId) => {
            const token = { key: 'preference', generation: ++state.generation };
            state.preference = { ...token, profileUserId: owner.profileUserId,
                authorityRevision: owner.authorityRevision, sessionEpoch: owner.sessionEpoch, playerId };
            return { status: 'written', token };
        }),
        clearCastPreference: vi.fn(async (_owner, token) => {
            if (state.preference?.generation !== token.generation) return { status: 'superseded' };
            state.preference = null;
            return { status: 'cleared' };
        }),
        reserveCastReceipt: vi.fn(async (owner, playerId) => {
            const token = { key: 'receipt', generation: ++state.generation };
            state.receipt = { token, owner: { profileUserId: owner.profileUserId,
                authorityRevision: owner.authorityRevision }, playerId, state: 'pending' };
            return { status: 'reserved', token };
        }),
        confirmCastReceipt: vi.fn(async (_owner, _playerId, session, token) => {
            if (state.receipt?.token !== token) return { status: 'superseded' };
            state.receipt = { ...state.receipt, session, state: 'confirmed' };
            return { status: 'confirmed' };
        }),
        claimRestoredCastReceipt: vi.fn(async (_owner, _playerId, session) => {
            if (state.receipt?.session !== session || state.receipt.state !== 'confirmed') return { status: 'missing' };
            const token = { key: 'receipt', generation: ++state.generation };
            state.receipt = { ...state.receipt, token };
            return { status: 'claimed', token, receipt: state.receipt };
        }),
        checkCastReceipt: vi.fn(async token => ({ status: state.receipt?.token === token ? 'current' : 'superseded' })),
        revokeCastReceipt: vi.fn(async token => {
            if (state.receipt?.token !== token) return { status: 'superseded' };
            state.receipt = null;
            return { status: 'revoked' };
        })
    };
});

import {
    clearAutocastPreference,
    clearCastConnectionReceipt,
    checkCastConnectionReceipt,
    createCastActivationOwner,
    readAutocastPreference,
    reserveCastConnectionReceipt,
    writeAutocastPreference,
    readRestoredCastReceipt,
    writeCastConnectionReceipt
} from './castActivationAuthority';

function installIdentity(profileUserId = 'A', revision = 7, epoch = 3) {
    const binding = {
        serverId: 'server', deviceId: 'device', profileUserId,
        sessionEpoch: epoch, credentialRef: { token: `secret-${profileUserId}` }
    };
    state.client = {
        serverId: () => 'server',
        serverVersion: () => '1',
        serverInfo: () => ({ LocalAddress: 'https://reachable' })
    };
    state.authority = { authorityRevision: revision };
    state.captured = {
        binding,
        basePath: 'https://server',
        identity: { authorityGeneration: `${revision}:opaque` },
        assertCurrent: vi.fn()
    };
}

const receiverSession = { sessionId: 'session-1', receiver: { label: 'receiver-1' } };

describe('Cast preference and receiver attribution', () => {
    beforeEach(() => {
        localStorage.clear();
        state.preference = null;
        state.receipt = null;
        state.generation = 0;
        state.envelopeListener = null;
        state.admissionListener = null;
        installIdentity();
    });

    it('denies missing capture and never upgrades a legacy unowned target', async () => {
        localStorage.setItem('autocastPlayerId', 'Google Cast');
        const owner = createCastActivationOwner();
        expect((await readAutocastPreference(owner)).value).toBeNull();
        expect(localStorage.getItem('autocastPlayerId')).toBe('Google Cast');
        owner.retire();
        state.captured = null;
        expect(createCastActivationOwner()).toBeNull();
    });

    it('confirms only a reserved receipt and claims the same receiver after reload', async () => {
        const owner = createCastActivationOwner();
        expect((await writeAutocastPreference(owner, 'Google Cast')).status).toBe('written');
        const reserved = await reserveCastConnectionReceipt(owner, 'Google Cast');
        expect((await writeCastConnectionReceipt(owner, 'Google Cast', receiverSession, reserved.token)).status).toBe('confirmed');
        expect((await readAutocastPreference(owner)).value?.playerId).toBe('Google Cast');
        expect((await readRestoredCastReceipt(owner, receiverSession, 'Google Cast')).status).toBe('claimed');
        expect((await readRestoredCastReceipt(owner, { ...receiverSession, sessionId: 'other' }, 'Google Cast')).status).toBe('missing');
        expect(JSON.stringify([state.preference, state.receipt])).not.toContain('secret-');
        owner.retire();
        installIdentity('B', 8, 4);
        const next = createCastActivationOwner();
        expect((await readAutocastPreference(next)).value).toBeNull();
        next.retire();
    });

    it('retires the old operation and never revives after ABA', async () => {
        const first = createCastActivationOwner();
        await writeAutocastPreference(first, 'Google Cast');
        const reserved = await reserveCastConnectionReceipt(first, 'Google Cast');
        await writeCastConnectionReceipt(first, 'Google Cast', receiverSession, reserved.token);
        state.captured.assertCurrent.mockImplementation(() => {
            throw new Error('revoked');
        });
        state.envelopeListener();
        await Promise.resolve();
        expect(first.current()).toBe(false);
        expect(state.preference).toBeNull();
        expect(state.receipt).toBeNull();
        installIdentity('B', 8, 4);
        const next = createCastActivationOwner();
        await writeAutocastPreference(next, 'Google Cast');
        const newer = await reserveCastConnectionReceipt(next, 'Google Cast');
        await writeCastConnectionReceipt(next, 'Google Cast', receiverSession, newer.token);
        expect(first.current()).toBe(false);
        expect((await readAutocastPreference(next)).value?.profileUserId).toBe('B');
        next.retire();
    });

    it('does not let an obsolete owner disable a newer profile preference', async () => {
        const first = createCastActivationOwner();
        installIdentity('B', 8, 4);
        const next = createCastActivationOwner();
        expect((await writeAutocastPreference(next, 'Google Cast')).status).toBe('written');
        await clearAutocastPreference(first);
        expect((await readAutocastPreference(next)).value?.profileUserId).toBe('B');
        next.retire();
        first.retire();
    });

    it('does not let an older same-profile receiver disconnect erase a newer receipt', async () => {
        const older = createCastActivationOwner();
        const newer = createCastActivationOwner();
        const newerSession = { sessionId: 'session-2', receiver: { label: 'receiver-2' } };
        const oldReservation = await reserveCastConnectionReceipt(older, 'Google Cast');
        const newReservation = await reserveCastConnectionReceipt(newer, 'Google Cast');
        expect((await writeCastConnectionReceipt(older, 'Google Cast', receiverSession, oldReservation.token)).status).toBe('superseded');
        expect((await writeCastConnectionReceipt(newer, 'Google Cast', newerSession, newReservation.token)).status).toBe('confirmed');
        await clearCastConnectionReceipt(older, receiverSession, oldReservation.token);
        expect((await checkCastConnectionReceipt(newer, newReservation.token)).status).toBe('current');
        older.retire();
        newer.retire();
    });
});

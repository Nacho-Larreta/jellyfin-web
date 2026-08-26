export const SESSION_SWITCH_ENVELOPE_VERSION = 1 as const;

export interface ActiveCredentialRef {
    readonly scope: 'active-profile';
    readonly token: string;
}

export interface RecoveryCredentialRef {
    readonly scope: 'owner-recovery';
    readonly token: string;
}

export interface ActiveProfileSession {
    readonly serverId: string;
    readonly deviceId: string;
    readonly profileUserId: string;
    readonly credentialRef: ActiveCredentialRef;
    readonly sessionEpoch: number;
}

export interface OwnerRecoverySession {
    readonly serverId: string;
    readonly deviceId: string;
    readonly ownerUserId: string;
    readonly credentialRef: RecoveryCredentialRef;
}

export interface SessionSwitchCompletionReceipt {
    readonly switchId: string;
    readonly serverId: string;
    readonly profileUserId: string;
    readonly sessionEpoch: number;
}

export interface CorruptSessionStorage {
    readonly kind: 'CorruptSessionStorage';
}

export const CORRUPT_SESSION_STORAGE: CorruptSessionStorage = Object.freeze({
    kind: 'CorruptSessionStorage'
});

export type SessionEnvelopeObservation = SessionSwitchEnvelope | CorruptSessionStorage | null;

export type PreCommitPhase = 'Preparing' | 'Quiescing' | 'Committing' | 'CommitUnknown' | 'ResolvingCommit';
export type CleanupPhase = 'Installing' | 'Resetting' | 'Reconnecting' | 'Completing';
export type QuarantinePhase = 'ClearingBinding' | 'Quarantined';

interface SwitchMarkerBase {
    readonly switchId: string;
    readonly serverId: string;
    readonly deviceId: string;
    readonly oldProfileUserId: string;
    readonly oldEpoch: number;
    readonly targetProfileUserId: string;
    readonly coordinatorId: string;
    readonly fencingToken: number;
    readonly leaseExpiresAtMs: number;
    readonly updatedAtMs: number;
}

export interface PendingSwitchRecord extends SwitchMarkerBase {
    readonly kind: 'PendingSwitch';
    readonly phase: PreCommitPhase;
}

export interface CommittedPendingCleanup extends SwitchMarkerBase {
    readonly kind: 'CommittedPendingCleanup';
    readonly phase: CleanupPhase;
}

export interface QuarantinedSession extends SwitchMarkerBase {
    readonly kind: 'QuarantinedSession';
    readonly phase: QuarantinePhase;
    readonly reason: 'IdentityMismatch';
}

export type SessionSwitchMarker = PendingSwitchRecord | CommittedPendingCleanup | QuarantinedSession;

export interface SessionSwitchEnvelope {
    readonly version: typeof SESSION_SWITCH_ENVELOPE_VERSION;
    readonly revision: number;
    readonly activeSession: ActiveProfileSession;
    readonly recoverySession: OwnerRecoverySession | null;
    readonly marker: SessionSwitchMarker | null;
    readonly lastCompletion: SessionSwitchCompletionReceipt | null;
}

export interface SessionSwitchRequest {
    readonly switchId: string;
    readonly targetProfileUserId: string;
    readonly pin?: string;
}

export interface ServerSwitchAuthentication {
    readonly accessToken: string;
    readonly userId: string;
}

export type ServerSwitchState = 'Prepared' | 'Committed' | 'Expired' | 'Aborted';

export interface ServerSwitchResult {
    readonly switchId: string;
    readonly targetProfileUserId: string;
    readonly state: ServerSwitchState;
    readonly authentication: ServerSwitchAuthentication | null;
}

export type PlaybackQuiesceResult =
    | { readonly outcome: 'NotActive' }
    | { readonly outcome: 'Acknowledged'; readonly reportKey: string }
    | { readonly outcome: 'Failed' };

export class SwitchAlreadyInProgressError extends Error {
    constructor(readonly activeSwitchId: string) {
        super('A different profile switch is already in progress.');
        this.name = 'SwitchAlreadyInProgressError';
    }
}

export class SessionSwitchInProgressError extends Error {
    constructor(readonly switchId: string) {
        super('Session-scoped work is blocked while a profile switch is in progress.');
        this.name = 'SessionSwitchInProgressError';
    }
}

export class CommitUnknownError extends Error {
    constructor() {
        super('The profile switch commit outcome is unknown.');
        this.name = 'CommitUnknownError';
    }
}

export class DeterministicSwitchRejectionError extends Error {
    constructor(readonly status: number) {
        super('The profile switch was rejected before the commit point.');
        this.name = 'DeterministicSwitchRejectionError';
    }
}

export class SessionSwitchRecoveryRequiredError extends Error {
    constructor(readonly switchId: string) {
        super('The profile switch must be recovered before protected content can render.');
        this.name = 'SessionSwitchRecoveryRequiredError';
    }
}

export class PlaybackQuiesceFailedError extends Error {
    constructor() {
        super('Old-session playback could not be safely quiesced.');
        this.name = 'PlaybackQuiesceFailedError';
    }
}

export class ConcurrentSessionWriteError extends Error {
    constructor(readonly actualRevision: number) {
        super('The session envelope changed before the atomic replacement.');
        this.name = 'ConcurrentSessionWriteError';
    }
}

export class SessionSwitchTimeoutError extends Error {
    constructor(readonly operation: 'Prepare' | 'Commit' | 'Status' | 'Abort' | 'Join') {
        super(`The profile switch ${operation} operation timed out.`);
        this.name = 'SessionSwitchTimeoutError';
    }
}

export class SessionStorageCorruptionError extends Error {
    constructor() {
        super('Session storage is corrupt; protected work remains blocked.');
        this.name = 'SessionStorageCorruptionError';
    }
}

export class SessionSwitchUnsupportedEngineError extends Error {
    constructor() {
        super('This browser cannot provide a cross-context session transaction.');
        this.name = 'SessionSwitchUnsupportedEngineError';
    }
}

export function createActiveProfileSession(
    serverId: string,
    deviceId: string,
    profileUserId: string,
    token: string,
    sessionEpoch: number
): ActiveProfileSession {
    assertIdentifier(serverId, 'serverId');
    assertIdentifier(deviceId, 'deviceId');
    assertIdentifier(profileUserId, 'profileUserId');
    assertIdentifier(token, 'active credential');
    assertSessionEpoch(sessionEpoch);

    return Object.freeze({
        serverId,
        deviceId,
        profileUserId,
        credentialRef: Object.freeze({ scope: 'active-profile' as const, token }),
        sessionEpoch
    });
}

export function createOwnerRecoverySession(
    serverId: string,
    deviceId: string,
    ownerUserId: string,
    token: string
): OwnerRecoverySession {
    assertIdentifier(serverId, 'serverId');
    assertIdentifier(deviceId, 'deviceId');
    assertIdentifier(ownerUserId, 'ownerUserId');
    assertIdentifier(token, 'recovery credential');

    return Object.freeze({
        serverId,
        deviceId,
        ownerUserId,
        credentialRef: Object.freeze({ scope: 'owner-recovery' as const, token })
    });
}

export function assertSessionEnvelope(value: unknown): asserts value is SessionSwitchEnvelope {
    if (!isRecord(value) || value.version !== SESSION_SWITCH_ENVELOPE_VERSION) {
        throw new TypeError('Invalid session switch envelope version.');
    }

    assertExactKeys(value, [
        'version',
        'revision',
        'activeSession',
        'recoverySession',
        'marker',
        'lastCompletion'
    ], 'session switch envelope');
    assertSessionEpoch(value.revision);

    assertActiveSession(value.activeSession);

    if (value.recoverySession !== null) {
        assertRecoverySession(value.recoverySession);
        if (value.recoverySession.serverId !== value.activeSession.serverId
            || value.recoverySession.deviceId !== value.activeSession.deviceId) {
            throw new TypeError('Recovery session is not bound to the active server and device.');
        }
    }

    if (value.marker !== null) {
        assertMarker(value.marker, value.activeSession);
    }

    if (value.lastCompletion !== null) {
        assertCompletion(value.lastCompletion);
        if (value.marker !== null
            || value.lastCompletion.serverId !== value.activeSession.serverId
            || value.lastCompletion.profileUserId !== value.activeSession.profileUserId
            || value.lastCompletion.sessionEpoch !== value.activeSession.sessionEpoch) {
            throw new TypeError('Completion receipt is not bound to the active terminal session.');
        }
    }
}

function assertActiveSession(value: unknown): asserts value is ActiveProfileSession {
    if (!isRecord(value) || !isRecord(value.credentialRef) || value.credentialRef.scope !== 'active-profile') {
        throw new TypeError('Invalid active profile session.');
    }

    assertExactKeys(value, [ 'serverId', 'deviceId', 'profileUserId', 'credentialRef', 'sessionEpoch' ], 'active session');
    assertExactKeys(value.credentialRef, [ 'scope', 'token' ], 'active credential reference');

    assertIdentifier(value.serverId, 'serverId');
    assertIdentifier(value.deviceId, 'deviceId');
    assertIdentifier(value.profileUserId, 'profileUserId');
    assertIdentifier(value.credentialRef.token, 'active credential');
    assertSessionEpoch(value.sessionEpoch);
}

function assertRecoverySession(value: unknown): asserts value is OwnerRecoverySession {
    if (!isRecord(value) || !isRecord(value.credentialRef) || value.credentialRef.scope !== 'owner-recovery') {
        throw new TypeError('Invalid owner recovery session.');
    }

    assertExactKeys(value, [ 'serverId', 'deviceId', 'ownerUserId', 'credentialRef' ], 'recovery session');
    assertExactKeys(value.credentialRef, [ 'scope', 'token' ], 'recovery credential reference');

    assertIdentifier(value.serverId, 'serverId');
    assertIdentifier(value.deviceId, 'deviceId');
    assertIdentifier(value.ownerUserId, 'ownerUserId');
    assertIdentifier(value.credentialRef.token, 'recovery credential');
}

function assertMarker(value: unknown, activeSession: ActiveProfileSession): asserts value is SessionSwitchMarker {
    if (!isRecord(value)
        || (value.kind !== 'PendingSwitch'
            && value.kind !== 'CommittedPendingCleanup'
            && value.kind !== 'QuarantinedSession')) {
        throw new TypeError('Invalid session switch marker.');
    }

    const markerKeys = [
        'kind',
        'phase',
        'switchId',
        'serverId',
        'deviceId',
        'oldProfileUserId',
        'oldEpoch',
        'targetProfileUserId',
        'coordinatorId',
        'fencingToken',
        'leaseExpiresAtMs',
        'updatedAtMs'
    ];
    assertExactKeys(
        value,
        value.kind === 'QuarantinedSession' ? [ ...markerKeys, 'reason' ] : markerKeys,
        'session switch marker'
    );

    assertIdentifier(value.switchId, 'switchId');
    assertIdentifier(value.serverId, 'serverId');
    assertIdentifier(value.deviceId, 'deviceId');
    assertIdentifier(value.oldProfileUserId, 'oldProfileUserId');
    assertIdentifier(value.targetProfileUserId, 'targetProfileUserId');
    assertIdentifier(value.coordinatorId, 'coordinatorId');
    assertSessionEpoch(value.oldEpoch);
    assertPositiveInteger(value.fencingToken, 'fencingToken');
    assertPositiveInteger(value.leaseExpiresAtMs, 'leaseExpiresAtMs');

    if (typeof value.updatedAtMs !== 'number' || !Number.isSafeInteger(value.updatedAtMs) || value.updatedAtMs < 0) {
        throw new TypeError('Invalid session switch marker timestamp.');
    }

    const phases = validPhases(value.kind);

    if (phases.indexOf(value.phase as string) === -1) {
        throw new TypeError('Invalid session switch marker phase.');
    }

    if (value.serverId !== activeSession.serverId || value.deviceId !== activeSession.deviceId) {
        throw new TypeError('Session switch marker is not bound to the active server and device.');
    }

    if (value.kind === 'PendingSwitch'
        && (value.oldProfileUserId !== activeSession.profileUserId || value.oldEpoch !== activeSession.sessionEpoch)) {
        throw new TypeError('Pending switch marker does not preserve the active old snapshot.');
    }

    if ((value.kind === 'CommittedPendingCleanup' || value.kind === 'QuarantinedSession')
        && (value.targetProfileUserId !== activeSession.profileUserId
            || value.oldEpoch + 1 !== activeSession.sessionEpoch)) {
        throw new TypeError('Committed cleanup marker does not match the installed target epoch.');
    }

    if (value.kind === 'QuarantinedSession' && value.reason !== 'IdentityMismatch') {
        throw new TypeError('Invalid quarantine reason.');
    }
}

function assertCompletion(value: unknown): asserts value is SessionSwitchCompletionReceipt {
    if (!isRecord(value)) {
        throw new TypeError('Invalid session switch completion receipt.');
    }

    assertExactKeys(
        value,
        [ 'switchId', 'serverId', 'profileUserId', 'sessionEpoch' ],
        'completion receipt'
    );

    assertIdentifier(value.switchId, 'switchId');
    assertIdentifier(value.serverId, 'serverId');
    assertIdentifier(value.profileUserId, 'profileUserId');
    assertSessionEpoch(value.sessionEpoch);
}

function validPhases(kind: SessionSwitchMarker['kind']): string[] {
    switch (kind) {
        case 'PendingSwitch':
            return [ 'Preparing', 'Quiescing', 'Committing', 'CommitUnknown', 'ResolvingCommit' ];
        case 'CommittedPendingCleanup':
            return [ 'Installing', 'Resetting', 'Reconnecting', 'Completing' ];
        case 'QuarantinedSession':
            return [ 'ClearingBinding', 'Quarantined' ];
    }
}

function assertSessionEpoch(value: unknown): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('Session epoch must be a non-negative safe integer.');
    }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer.`);
    }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], name: string): void {
    const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
    const sortedExpected = [ ...expected ].sort((left, right) => left.localeCompare(right));
    if (actual.length !== sortedExpected.length
        || actual.some((key, index) => key !== sortedExpected[index])) {
        throw new TypeError(`Invalid ${name} schema.`);
    }
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} is required.`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

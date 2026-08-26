import {
    SessionSwitchInProgressError,
    SessionStorageCorruptionError,
    SwitchAlreadyInProgressError,
    type ActiveProfileSession,
    type SessionEnvelopeObservation
} from './model';

export type SessionWorkKind = 'read' | 'mutation';
export type MutationSettlement = 'Acknowledged' | 'Rejected' | 'NotApplied' | 'Unknown';

export interface SessionWorkLease {
    readonly snapshot: ActiveProfileSession;
    readonly signal: AbortSignal;
    settle(outcome?: MutationSettlement): void;
}

interface OutstandingMutation {
    readonly settled: Promise<MutationSettlement>;
    settle(outcome: MutationSettlement): void;
}

export class SessionAdmissionBarrier {
    private closedBySwitchId: string | null = null;
    private currentSession: ActiveProfileSession | null = null;
    private storageCorrupt = false;
    private readonly activeReads = new Set<AbortController>();
    private readonly activeMutations = new Set<OutstandingMutation>();

    constructor(private readonly createCancellation = createAbortController) {}

    synchronize(envelope: SessionEnvelopeObservation): void {
        if (envelope !== null && 'kind' in envelope) {
            this.failClosedForCorruptStorage();
            return;
        }

        this.storageCorrupt = false;
        const previousSession = this.currentSession;
        this.currentSession = envelope?.activeSession ?? null;
        if (previousSession !== null
            && (this.currentSession === null || !sameSessionEpoch(previousSession, this.currentSession))) {
            this.cancelActiveReads();
        }
        const switchId = envelope?.marker?.switchId ?? null;
        if (switchId === null) {
            this.closedBySwitchId = null;
            return;
        }

        this.closedBySwitchId = switchId;
        this.cancelActiveReads();
    }

    admitCurrent(kind: SessionWorkKind): SessionWorkLease {
        if (this.storageCorrupt) {
            throw new SessionStorageCorruptionError();
        }
        if (this.currentSession === null) {
            throw new Error('No active profile session is available.');
        }

        return this.admit(this.currentSession, kind);
    }

    current(): ActiveProfileSession | null {
        return this.currentSession;
    }

    admit(snapshot: ActiveProfileSession, kind: SessionWorkKind): SessionWorkLease {
        if (this.storageCorrupt) {
            throw new SessionStorageCorruptionError();
        }
        if (this.closedBySwitchId !== null) {
            throw new SessionSwitchInProgressError(this.closedBySwitchId);
        }

        const controller = this.createCancellation();
        if (kind === 'read') {
            this.activeReads.add(controller);
            return createReadLease(snapshot, controller, this.activeReads);
        }

        const mutation = createOutstandingMutation();
        this.activeMutations.add(mutation);
        return createMutationLease(snapshot, controller, mutation, this.activeMutations);
    }

    close(switchId: string): void {
        if (this.closedBySwitchId !== null && this.closedBySwitchId !== switchId) {
            throw new SwitchAlreadyInProgressError(this.closedBySwitchId);
        }

        this.closedBySwitchId = switchId;
        this.cancelActiveReads();
    }

    async drainMutations(): Promise<void> {
        const outcomes = await Promise.all(Array.from(this.activeMutations, mutation => mutation.settled));
        if (outcomes.some(outcome => outcome === 'Unknown')) {
            throw new Error('An old-session mutation has an unclassified outcome.');
        }
    }

    reopen(switchId: string): void {
        if (this.closedBySwitchId === switchId) {
            this.closedBySwitchId = null;
        }
    }

    isClosed(): boolean {
        return this.storageCorrupt || this.closedBySwitchId !== null;
    }

    assertCurrentEpoch(captured: ActiveProfileSession, current: ActiveProfileSession): void {
        if (captured.serverId !== current.serverId
            || captured.deviceId !== current.deviceId
            || captured.profileUserId !== current.profileUserId
            || captured.sessionEpoch !== current.sessionEpoch) {
            throw new Error('Late session-scoped result belongs to a stale epoch.');
        }
    }

    private cancelActiveReads(): void {
        this.activeReads.forEach(controller => {
            controller.abort();
        });
        this.activeReads.clear();
    }

    private failClosedForCorruptStorage(): void {
        this.storageCorrupt = true;
        this.currentSession = null;
        this.closedBySwitchId = 'corrupt-session-storage';
        this.cancelActiveReads();
    }
}

function createReadLease(
    snapshot: ActiveProfileSession,
    controller: AbortController,
    activeReads: Set<AbortController>
): SessionWorkLease {
    let settled = false;
    return Object.freeze({
        snapshot,
        signal: controller.signal,
        settle: () => {
            if (!settled) {
                settled = true;
                activeReads.delete(controller);
            }
        }
    });
}

function createMutationLease(
    snapshot: ActiveProfileSession,
    controller: AbortController,
    mutation: OutstandingMutation,
    activeMutations: Set<OutstandingMutation>
): SessionWorkLease {
    let settled = false;
    return Object.freeze({
        snapshot,
        signal: controller.signal,
        settle: (outcome: MutationSettlement = 'Unknown') => {
            if (!settled) {
                settled = true;
                mutation.settle(outcome);
                activeMutations.delete(mutation);
            }
        }
    });
}

function createOutstandingMutation(): OutstandingMutation {
    let resolveSettlement: (outcome: MutationSettlement) => void = () => undefined;
    const settled = new Promise<MutationSettlement>(resolve => {
        resolveSettlement = resolve;
    });

    return {
        settled,
        settle: resolveSettlement
    };
}

function createAbortController(): AbortController {
    const AbortControllerConstructor = window['AbortController'];
    return new AbortControllerConstructor();
}

function sameSessionEpoch(left: ActiveProfileSession, right: ActiveProfileSession): boolean {
    return left.serverId === right.serverId
        && left.deviceId === right.deviceId
        && left.profileUserId === right.profileUserId
        && left.sessionEpoch === right.sessionEpoch;
}

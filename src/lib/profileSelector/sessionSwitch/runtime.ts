import {
    type ActiveProfileSession,
    type CommittedPendingCleanup,
    type SessionSwitchCompletionReceipt
} from './model';
import { type SessionRuntimePort } from './coordinator';

interface JellyfinUser {
    readonly Id?: string;
}

interface SessionRuntimeConnections {
    installSessionAuthentication(session: ActiveProfileSession): void;
    resetInstalledSession(serverId: string): void;
    reconnectInstalledSession(serverId: string): void;
    getInstalledSessionUser(serverId: string): Promise<JellyfinUser>;
    discardStagedSession(serverId: string): void;
    clearInstalledSession(serverId: string): void;
    publishSessionSwitchCompletion(
        user: JellyfinUser,
        receipt: SessionSwitchCompletionReceipt
    ): Promise<void>;
}

export class ServerConnectionsSessionRuntime implements SessionRuntimePort {
    private readonly verifiedUsers = new Map<string, JellyfinUser>();
    private readonly verifiedSessions = new Map<string, ActiveProfileSession>();

    constructor(private readonly connections: SessionRuntimeConnections) {}

    async installActiveSession(session: ActiveProfileSession): Promise<void> {
        this.verifiedUsers.delete(session.serverId);
        this.verifiedSessions.delete(session.serverId);
        this.connections.installSessionAuthentication(session);
    }

    isVerifiedSession(session: ActiveProfileSession): boolean {
        const verified = this.verifiedSessions.get(session.serverId);
        return verified !== undefined
            && verified.deviceId === session.deviceId
            && verified.profileUserId === session.profileUserId
            && verified.sessionEpoch === session.sessionEpoch
            && verified.credentialRef.token === session.credentialRef.token;
    }

    invalidate(serverId: string): void {
        this.clearVerification(serverId);
        this.connections.discardStagedSession(serverId);
    }

    async restoreOldSession(session: ActiveProfileSession): Promise<boolean> {
        await this.installActiveSession(session);
        const verified = await this.verifyAndReconnect(session);
        this.connections.discardStagedSession(session.serverId);
        return verified;
    }

    async resetSessionState(
        marker: CommittedPendingCleanup,
        session: ActiveProfileSession
    ): Promise<void> {
        assertMarkerBinding(marker, session);
        this.verifiedUsers.delete(session.serverId);
        this.verifiedSessions.delete(session.serverId);
        this.connections.resetInstalledSession(session.serverId);
    }

    reconnectAndVerify(session: ActiveProfileSession): Promise<boolean> {
        return this.verifyAndReconnect(session);
    }

    async clearActiveSession(session: ActiveProfileSession): Promise<void> {
        this.verifiedUsers.delete(session.serverId);
        this.verifiedSessions.delete(session.serverId);
        this.connections.clearInstalledSession(session.serverId);
    }

    async publishCompleted(receipt: SessionSwitchCompletionReceipt): Promise<void> {
        const user = this.verifiedUsers.get(receipt.serverId);
        if (!user || user.Id !== receipt.profileUserId) {
            throw new Error('Verified session identity is unavailable for completion.');
        }

        await this.connections.publishSessionSwitchCompletion(user, receipt);
    }

    private async verifyAndReconnect(session: ActiveProfileSession): Promise<boolean> {
        let user: JellyfinUser;
        try {
            user = await this.connections.getInstalledSessionUser(session.serverId);
        } catch {
            this.clearVerification(session.serverId);
            return false;
        }

        if (!user || user.Id !== session.profileUserId) {
            this.clearVerification(session.serverId);
            return false;
        }

        this.verifiedUsers.set(session.serverId, user);
        this.verifiedSessions.set(session.serverId, session);
        this.connections.reconnectInstalledSession(session.serverId);
        return true;
    }

    private clearVerification(serverId: string): void {
        this.verifiedUsers.delete(serverId);
        this.verifiedSessions.delete(serverId);
    }
}

function assertMarkerBinding(
    marker: CommittedPendingCleanup,
    session: ActiveProfileSession
): void {
    if (marker.serverId !== session.serverId
        || marker.deviceId !== session.deviceId
        || marker.targetProfileUserId !== session.profileUserId
        || marker.oldEpoch + 1 !== session.sessionEpoch) {
        throw new TypeError('Committed cleanup marker does not match the installed session.');
    }
}

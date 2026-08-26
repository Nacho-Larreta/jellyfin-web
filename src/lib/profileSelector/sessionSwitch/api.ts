import { assertValidProfilePin } from '../pin';

import {
    CommitUnknownError,
    DeterministicSwitchRejectionError,
    type ServerSwitchAuthentication,
    type ServerSwitchResult,
    type ServerSwitchState
} from './model';

interface AjaxResponse {
    json(): Promise<unknown>;
}

interface ProfileSwitchApiClient {
    ajax(options: Record<string, unknown>): Promise<AjaxResponse>;
    getUrl(path: string): string;
}

export interface PrepareSwitchCommand {
    readonly switchId: string;
    readonly targetProfileUserId: string;
    readonly pin?: string;
}

export interface ProfileSwitchApiPort {
    prepare(command: PrepareSwitchCommand): Promise<ServerSwitchResult>;
    commit(switchId: string): Promise<ServerSwitchResult>;
    status(switchId: string): Promise<ServerSwitchResult>;
    abort(switchId: string): Promise<ServerSwitchResult>;
}

export class LegacyProfileSwitchApi implements ProfileSwitchApiPort {
    constructor(private readonly apiClient: ProfileSwitchApiClient) {}

    async prepare(command: PrepareSwitchCommand): Promise<ServerSwitchResult> {
        const payload: { TargetProfileUserId: string; Pin?: string } = {
            TargetProfileUserId: command.targetProfileUserId
        };

        if (command.pin !== undefined) {
            payload.Pin = assertValidProfilePin(command.pin);
        }

        return this.send(
            'POST',
            `ProfileSelectors/Current/Switches/${encodeURIComponent(command.switchId)}/Prepare`,
            payload
        );
    }

    async commit(switchId: string): Promise<ServerSwitchResult> {
        try {
            return await this.send(
                'POST',
                `ProfileSelectors/Current/Switches/${encodeURIComponent(switchId)}/Commit`
            );
        } catch (error) {
            if (isCommitOutcomeUnknown(error)) {
                throw new CommitUnknownError();
            }

            throw error;
        }
    }

    async status(switchId: string): Promise<ServerSwitchResult> {
        return this.send('GET', `ProfileSelectors/Current/Switches/${encodeURIComponent(switchId)}`);
    }

    async abort(switchId: string): Promise<ServerSwitchResult> {
        return this.send('DELETE', `ProfileSelectors/Current/Switches/${encodeURIComponent(switchId)}`);
    }

    private async send(method: string, path: string, payload?: unknown): Promise<ServerSwitchResult> {
        const request: Record<string, unknown> = {
            type: method,
            url: this.apiClient.getUrl(path)
        };

        if (payload !== undefined) {
            request.contentType = 'application/json';
            request.data = JSON.stringify(payload);
        }

        let response: AjaxResponse;
        try {
            response = await this.apiClient.ajax(request);
        } catch (error) {
            const status = getHttpStatus(error);
            if (status !== null && status >= 400 && status < 500 && status !== 408) {
                throw new DeterministicSwitchRejectionError(status);
            }

            throw error;
        }

        return parseServerResult(await response.json());
    }
}

function parseServerResult(value: unknown): ServerSwitchResult {
    if (!isRecord(value)) {
        throw new TypeError('Invalid profile switch response.');
    }

    const switchId = readRequiredString(value.SwitchId, 'SwitchId');
    const targetProfileUserId = readRequiredString(value.TargetProfileUserId, 'TargetProfileUserId');
    const state = readState(value.State);
    const authentication = state === 'Committed' ?
        readAuthentication(value.AuthenticationResult) :
        null;

    return Object.freeze({
        switchId,
        targetProfileUserId,
        state,
        authentication
    });
}

function readAuthentication(value: unknown): ServerSwitchAuthentication {
    if (!isRecord(value) || !isRecord(value.User)) {
        throw new TypeError('Committed profile switch response is missing authentication data.');
    }

    return Object.freeze({
        accessToken: readRequiredString(value.AccessToken, 'AuthenticationResult.AccessToken'),
        userId: readRequiredString(value.User.Id, 'AuthenticationResult.User.Id')
    });
}

function readState(value: unknown): ServerSwitchState {
    if (value === 'Prepared' || value === 'Committed' || value === 'Expired' || value === 'Aborted') {
        return value;
    }

    throw new TypeError('Invalid profile switch state.');
}

function isCommitOutcomeUnknown(error: unknown): boolean {
    if (error instanceof CommitUnknownError) {
        return true;
    }

    if (error instanceof DeterministicSwitchRejectionError) {
        return false;
    }

    const status = getHttpStatus(error);
    return status === null || status === 408 || status >= 500 || isAbortError(error);
}

function getHttpStatus(error: unknown): number | null {
    if (!isRecord(error) || typeof error.status !== 'number') {
        return null;
    }

    return error.status;
}

function isAbortError(error: unknown): boolean {
    return isRecord(error) && error.name === 'AbortError';
}

function readRequiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} is required.`);
    }

    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

import { Jellyfin, type Api } from '@jellyfin/sdk';
import { type ArtistsApiGetArtistsRequest } from '@jellyfin/sdk/lib/generated-client/api/artists-api';
import { type ItemsApiGetItemsRequest } from '@jellyfin/sdk/lib/generated-client/api/items-api';
import { type PersonsApiGetPersonsRequest } from '@jellyfin/sdk/lib/generated-client/api/persons-api';
import { type BaseItemDtoQueryResult } from '@jellyfin/sdk/lib/generated-client';
import { getArtistsApi } from '@jellyfin/sdk/lib/utils/api/artists-api';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import { getPersonsApi } from '@jellyfin/sdk/lib/utils/api/persons-api';
import { CancelledError } from '@tanstack/react-query';
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';

import { type BoundSessionReadIdentity, type BoundSessionReadPort, StaleSessionReadError } from 'lib/profileSelector/sessionSwitch/boundRequests';

interface ReadApiClient {
    appName(): string;
    appVersion(): string;
    deviceName(): string;
    deviceId(): string;
}

export interface SessionScopedReadApi {
    readonly identity: BoundSessionReadIdentity;
    assertCurrent(): void;
    getItems(params: ItemsApiGetItemsRequest, signal?: AbortSignal): Promise<BaseItemDtoQueryResult>;
    getArtists(params: ArtistsApiGetArtistsRequest, signal?: AbortSignal): Promise<BaseItemDtoQueryResult>;
    getPersons(params: PersonsApiGetPersonsRequest, signal?: AbortSignal): Promise<BaseItemDtoQueryResult>;
}

const SEARCH_READ_PATHS = new Set(['/Items', '/Artists', '/Persons']);
const FORBIDDEN_QUERY_KEYS = new Set(['apikey', 'accesstoken', 'token', 'deviceid']);
const FORBIDDEN_HEADER_KEYS = ['x-emby-token', 'x-mediabrowser-token', 'x-emby-authorization'];

export function createSessionScopedReadApi(
    client: ReadApiClient,
    port: BoundSessionReadPort,
    transport: AxiosAdapter = axios.getAdapter(axios.defaults.adapter)
): SessionScopedReadApi {
    const instance = axios.create();
    const api = new Jellyfin({
        clientInfo: { name: client.appName(), version: client.appVersion() },
        deviceInfo: { name: client.deviceName(), id: port.binding.deviceId }
    }).createApi(port.basePath, port.binding.credentialRef.token, instance);
    const expectedAuthorization = api.authorizationHeader;

    const assertCurrent = () => {
        try {
            port.assertCurrent();
        } catch {
            throw new SessionReadCancelledError();
        }
    };

    instance.defaults.adapter = async config => {
        assertRequestBinding(api, config, port, expectedAuthorization);
        let lease;
        try {
            lease = port.acquire();
        } catch {
            throw new SessionReadCancelledError();
        }

        const controller = new window['AbortController']();
        const callerSignal = config.signal;
        const cancel = () => controller.abort();
        callerSignal?.addEventListener?.('abort', cancel, { once: true });
        lease.signal.addEventListener('abort', cancel, { once: true });
        if (callerSignal?.aborted || lease.signal.aborted) cancel();

        try {
            assertCurrent();
            if (controller.signal.aborted) throw new SessionReadCancelledError();
            const response = await transport({ ...config, signal: controller.signal });
            assertCurrent();
            if (controller.signal.aborted) throw new SessionReadCancelledError();
            return response;
        } catch (error) {
            assertCurrent();
            if (controller.signal.aborted || error instanceof StaleSessionReadError) {
                throw new SessionReadCancelledError();
            }
            throw error;
        } finally {
            callerSignal?.removeEventListener?.('abort', cancel);
            lease.signal.removeEventListener('abort', cancel);
            lease.settle();
        }
    };

    const read = async (request: () => Promise<{ data: BaseItemDtoQueryResult }>, signal?: AbortSignal) => {
        assertCurrent();
        try {
            const response = await request();
            assertCurrent();
            if (signal?.aborted) throw new SessionReadCancelledError();
            return response.data;
        } catch (error) {
            assertCurrent();
            if (signal?.aborted) throw new SessionReadCancelledError();
            throw error;
        }
    };

    return Object.freeze({
        identity: port.identity,
        assertCurrent,
        getItems: (params: ItemsApiGetItemsRequest, signal?: AbortSignal) =>
            read(() => getItemsApi(api).getItems(params, { signal }), signal),
        getArtists: (params: ArtistsApiGetArtistsRequest, signal?: AbortSignal) =>
            read(() => getArtistsApi(api).getArtists(params, { signal }), signal),
        getPersons: (params: PersonsApiGetPersonsRequest, signal?: AbortSignal) =>
            read(() => getPersonsApi(api).getPersons(params, { signal }), signal)
    });
}

export class SessionReadCancelledError extends CancelledError {
    constructor() {
        super({ silent: true });
        this.name = 'SessionReadCancelledError';
    }
}

function assertRequestBinding(
    api: Api,
    config: InternalAxiosRequestConfig,
    port: BoundSessionReadPort,
    expectedAuthorization: string
): void {
    if (api.basePath !== port.basePath
        || api.accessToken !== port.binding.credentialRef.token
        || api.deviceInfo.id !== port.binding.deviceId
        || api.authorizationHeader !== expectedAuthorization
        || config.method?.toUpperCase() !== 'GET'
        || config.auth || config.data !== undefined) throw new SessionReadCancelledError();

    let requested: URL;
    let base: URL;
    try {
        requested = new URL(axios.getUri(config), port.basePath);
        base = new URL(port.basePath);
    } catch {
        throw new SessionReadCancelledError();
    }
    const relativePath = requested.pathname.slice(base.pathname.replace(/\/$/, '').length);
    if (requested.origin !== base.origin || !SEARCH_READ_PATHS.has(relativePath)
        || requested.hash || config.baseURL && config.baseURL !== port.basePath
        || requested.searchParams.getAll('userId').length !== 1
        || requested.searchParams.get('userId') !== port.binding.profileUserId
        || Array.from(requested.searchParams.keys()).some(key => FORBIDDEN_QUERY_KEYS.has(key.toLowerCase()))) {
        throw new SessionReadCancelledError();
    }

    if (config.headers.get('Authorization') !== expectedAuthorization
        || FORBIDDEN_HEADER_KEYS.some(key => config.headers.has(key))) {
        throw new SessionReadCancelledError();
    }
}

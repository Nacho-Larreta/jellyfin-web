import type { Api } from '@jellyfin/sdk/lib/api';
import type { UserViewsApiGetUserViewsRequest } from '@jellyfin/sdk/lib/generated-client/api/user-views-api';
import { getUserViewsApi } from '@jellyfin/sdk/lib/utils/api/user-views-api';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { AxiosRequestConfig } from 'axios';
import { useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';

import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getBoundUserViewsQuery, type BoundUserViewsRead } from 'utils/jellyfin-apiclient/boundUserViewsQuery';
import events from 'utils/events';

import { useApi } from './useApi';

const fetchUserViews = async (
    api: Api,
    userId: string,
    params?: UserViewsApiGetUserViewsRequest,
    options?: AxiosRequestConfig
) => {
    const response = await getUserViewsApi(api)
        .getUserViews({ ...params, userId }, options);
    return response.data;
};

export const getUserViewsQuery = (
    api?: Api,
    userId?: string,
    params?: UserViewsApiGetUserViewsRequest
) => queryOptions({
    queryKey: [ 'User', userId, 'Views', params ],
    queryFn: ({ signal }) => fetchUserViews(api!, userId!, params, { signal }),
    // On initial page load we request user views 3x. Setting a 1 second stale time
    // allows a single request to be made to resolve all 3.
    staleTime: 1000, // 1 second
    enabled: !!api && !!userId
});

export const useUserViews = (
    userId?: string,
    params?: UserViewsApiGetUserViewsRequest
) => {
    const { sessionScopedUserViewsReadApi } = useApi();
    const [ invalidRead, setInvalidRead ] = useState<BoundUserViewsRead>();
    let currentRead = sessionScopedUserViewsReadApi === invalidRead ? undefined : sessionScopedUserViewsReadApi;
    try {
        currentRead?.assertCurrent();
    } catch {
        currentRead = undefined;
    }

    useLayoutEffect(() => {
        if (!sessionScopedUserViewsReadApi) return;
        const checkAuthority = (synchronous = false) => {
            try {
                sessionScopedUserViewsReadApi.assertCurrent();
            } catch {
                if (synchronous) {
                    flushSync(() => setInvalidRead(sessionScopedUserViewsReadApi));
                } else {
                    setInvalidRead(sessionScopedUserViewsReadApi);
                }
            }
        };
        const onAuthorityEvent = () => checkAuthority(true);
        events.on(ServerConnections, 'localusersignedin', onAuthorityEvent);
        events.on(ServerConnections, 'localusersignedout', onAuthorityEvent);
        events.on(ServerConnections, 'sessionswitchcompleted', onAuthorityEvent);
        let unsubscribeEnvelope: (() => void) | undefined;
        try {
            unsubscribeEnvelope = ServerConnections.subscribeSessionSwitchEnvelope(
                sessionScopedUserViewsReadApi.identity.serverId,
                onAuthorityEvent
            );
            checkAuthority();
        } catch {
            setInvalidRead(sessionScopedUserViewsReadApi);
        }
        return () => {
            unsubscribeEnvelope?.();
            events.off(ServerConnections, 'localusersignedin', onAuthorityEvent);
            events.off(ServerConnections, 'localusersignedout', onAuthorityEvent);
            events.off(ServerConnections, 'sessionswitchcompleted', onAuthorityEvent);
        };
    }, [ sessionScopedUserViewsReadApi ]);

    return useQuery(getBoundUserViewsQuery(currentRead, userId, params));
};

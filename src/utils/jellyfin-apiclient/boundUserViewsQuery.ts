import type { UserViewsApiGetUserViewsRequest } from '@jellyfin/sdk/lib/generated-client/api/user-views-api';
import { queryOptions } from '@tanstack/react-query';

import { SessionReadCancelledError, type SessionScopedHomeReadApi } from './sessionReadApi';

export type BoundUserViewsRead = Pick<SessionScopedHomeReadApi, 'identity' | 'assertCurrent' | 'getUserViews'>;

export const getBoundUserViewsQuery = (
    read?: BoundUserViewsRead,
    userId?: string,
    params?: UserViewsApiGetUserViewsRequest
) => queryOptions({
    queryKey: [ 'BoundUserViews', read?.identity, userId, params ],
    queryFn: async ({ signal }) => {
        if (!read || !userId || userId !== read.identity.profileUserId) throw new SessionReadCancelledError();
        read.assertCurrent();
        const result = await read.getUserViews({ ...params, userId }, signal);
        read.assertCurrent();
        return result;
    },
    staleTime: 1000,
    enabled: !!read && !!userId && userId === read.identity.profileUserId
});

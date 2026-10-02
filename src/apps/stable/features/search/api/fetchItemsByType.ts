import { ItemsApiGetItemsRequest } from '@jellyfin/sdk/lib/generated-client/api/items-api';
import { type SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { QUERY_OPTIONS } from '../constants/queryOptions';

export const fetchItemsByType = async (
    api: SessionScopedReadApi,
    userId?: string,
    params?: ItemsApiGetItemsRequest,
    options?: { signal?: AbortSignal }
) => {
    return api.getItems(
        {
            ...QUERY_OPTIONS,
            userId,
            recursive: true,
            ...params
        },
        options?.signal
    );
};

import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { useQuery } from '@tanstack/react-query';
import { useApi } from 'hooks/useApi';
import { type SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemsApiGetItemsRequest } from '@jellyfin/sdk/lib/generated-client/api/items-api';
import { fetchItemsByType } from './fetchItemsByType';

const fetchPrograms = async (
    api: SessionScopedReadApi,
    userId: string,
    params?: ItemsApiGetItemsRequest,
    options?: { signal?: AbortSignal }
) => {
    const response = await fetchItemsByType(
        api,
        userId,
        {
            includeItemTypes: [BaseItemKind.LiveTvProgram],
            ...params
        },
        options
    );

    return response;
};

export const useProgramsSearch = (
    parentId?: string,
    collectionType?: CollectionType,
    searchTerm?: string
) => {
    const { sessionScopedReadApi, sessionQueryIdentity, user } = useApi();
    const api = sessionScopedReadApi;
    const userId = user?.Id;

    return useQuery({
        queryKey: ['Search', sessionQueryIdentity, 'Programs', collectionType, parentId, searchTerm],
        queryFn: async ({ signal }) => {
            const result = await fetchPrograms(api!, userId!, { parentId, searchTerm }, { signal });
            sessionScopedReadApi!.assertCurrent();
            return result;
        },
        enabled: !!api && !!sessionQueryIdentity && userId === sessionQueryIdentity.profileUserId
            && !collectionType
    });
};

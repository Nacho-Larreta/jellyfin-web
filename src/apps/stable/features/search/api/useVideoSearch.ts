import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { useQuery } from '@tanstack/react-query';
import { useApi } from 'hooks/useApi';
import { type SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { QUERY_OPTIONS } from '../constants/queryOptions';
import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemsApiGetItemsRequest } from '@jellyfin/sdk/lib/generated-client/api/items-api';

const fetchVideos = async (
    api: SessionScopedReadApi,
    userId: string,
    params?: ItemsApiGetItemsRequest,
    options?: { signal?: AbortSignal }
) => {
    return api.getItems(
        {
            ...QUERY_OPTIONS,
            userId,
            recursive: true,
            mediaTypes: [MediaType.Video],
            excludeItemTypes: [
                BaseItemKind.Movie,
                BaseItemKind.Episode,
                BaseItemKind.TvChannel
            ],
            ...params
        },
        options?.signal
    );
};

export const useVideoSearch = (
    parentId?: string,
    collectionType?: CollectionType,
    searchTerm?: string
) => {
    const { sessionScopedReadApi, sessionQueryIdentity, user } = useApi();
    const api = sessionScopedReadApi;
    const userId = user?.Id;

    return useQuery({
        queryKey: ['Search', sessionQueryIdentity, 'Video', collectionType, parentId, searchTerm],
        queryFn: async ({ signal }) => {
            const result = await fetchVideos(api!, userId!, { parentId, searchTerm }, { signal });
            sessionScopedReadApi!.assertCurrent();
            return result;
        },
        enabled: !!api && !!sessionQueryIdentity && userId === sessionQueryIdentity.profileUserId
            && !collectionType
    });
};

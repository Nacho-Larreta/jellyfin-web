import type { SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { useQuery } from '@tanstack/react-query';

import { useApi } from 'hooks/useApi';

const fetchGetItems = async (
    api: SessionScopedReadApi,
    userId: string,
    parentId?: string,
    options?: { signal?: AbortSignal }
) => {
    const response = await api.getItems(
        {
            userId,
            sortBy: [ItemSortBy.IsFavoriteOrLiked, ItemSortBy.Random],
            includeItemTypes: [
                BaseItemKind.Movie,
                BaseItemKind.Series,
                BaseItemKind.MusicArtist
            ],
            limit: 20,
            recursive: true,
            imageTypeLimit: 0,
            enableImages: false,
            parentId,
            enableTotalRecordCount: false
        },
        options?.signal
    );
    return response.Items || [];
};

export const useSearchSuggestions = (parentId?: string) => {
    const { sessionScopedReadApi, sessionQueryIdentity, user } = useApi();
    const api = sessionScopedReadApi;
    const userId = user?.Id;

    return useQuery({
        queryKey: ['SearchSuggestions', sessionQueryIdentity, { parentId }],
        queryFn: async ({ signal }) => {
            const result = await fetchGetItems(api!, userId!, parentId, { signal });
            sessionScopedReadApi!.assertCurrent();
            return result;
        },
        refetchOnWindowFocus: false,
        enabled: !!api && !!sessionQueryIdentity && userId === sessionQueryIdentity.profileUserId
    });
};

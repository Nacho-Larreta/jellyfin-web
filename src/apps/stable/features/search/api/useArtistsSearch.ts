import { ArtistsApiGetArtistsRequest } from '@jellyfin/sdk/lib/generated-client/api/artists-api';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { useQuery } from '@tanstack/react-query';
import { useApi } from 'hooks/useApi';
import { type SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { QUERY_OPTIONS } from '../constants/queryOptions';
import { isMusic } from '../utils/search';

const fetchArtists = async (
    api: SessionScopedReadApi,
    userId: string,
    params?: ArtistsApiGetArtistsRequest,
    options?: { signal?: AbortSignal }
) => {
    return api.getArtists(
        {
            ...QUERY_OPTIONS,
            userId,
            ...params
        },
        options?.signal
    );
};

export const useArtistsSearch = (
    parentId?: string,
    collectionType?: CollectionType,
    searchTerm?: string
) => {
    const { sessionScopedReadApi, sessionQueryIdentity, user } = useApi();
    const api = sessionScopedReadApi;
    const userId = user?.Id;

    return useQuery({
        queryKey: ['Search', sessionQueryIdentity, 'Artists', collectionType, parentId, searchTerm],
        queryFn: async ({ signal }) => {
            const result = await fetchArtists(api!, userId!, { parentId, searchTerm }, { signal });
            sessionScopedReadApi!.assertCurrent();
            return result;
        },
        enabled: !!api && !!sessionQueryIdentity && userId === sessionQueryIdentity.profileUserId
            && (!collectionType || isMusic(collectionType))
    });
};

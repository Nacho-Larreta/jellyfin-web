import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { useQuery } from '@tanstack/react-query';
import { useApi } from 'hooks/useApi';
import { type SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { QUERY_OPTIONS } from '../constants/queryOptions';
import { isMovies, isTVShows } from '../utils/search';
import { PersonsApiGetPersonsRequest } from '@jellyfin/sdk/lib/generated-client/api/persons-api';

const fetchPeople = async (
    api: SessionScopedReadApi,
    userId: string,
    params?: PersonsApiGetPersonsRequest,
    options?: { signal?: AbortSignal }
) => {
    return api.getPersons(
        {
            ...QUERY_OPTIONS,
            userId,
            ...params
        },
        options?.signal
    );
};

export const usePeopleSearch = (
    parentId?: string,
    collectionType?: CollectionType,
    searchTerm?: string
) => {
    const { sessionScopedReadApi, sessionQueryIdentity, user } = useApi();
    const api = sessionScopedReadApi;
    const userId = user?.Id;

    const isPeopleEnabled = (!collectionType || isMovies(collectionType) || isTVShows(collectionType));

    return useQuery({
        queryKey: ['Search', sessionQueryIdentity, 'People', collectionType, parentId, searchTerm],
        queryFn: async ({ signal }) => {
            const result = await fetchPeople(api!, userId!, { searchTerm }, { signal });
            sessionScopedReadApi!.assertCurrent();
            return result;
        },
        enabled: !!api && !!sessionQueryIdentity && userId === sessionQueryIdentity.profileUserId
            && isPeopleEnabled
    });
};

import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { ApiClient } from 'jellyfin-apiclient';
import { useMutation, useQuery } from '@tanstack/react-query';

import { useApi } from 'hooks/useApi';
import { getCurrentProfileSelector } from 'lib/profileSelector/api';
import { getActiveProfile } from 'lib/profileSelector/utils';
import { queryClient } from 'utils/query/queryClient';

export type SearchHistoryEntryDto = {
    SearchTerm: string;
    HitCount: number;
    LastSearchedUtc: string;
};

export type ExploreItemDto = {
    Id?: string;
    Name?: string;
    Overview?: string | null;
    Type?: string;
    Item?: BaseItemDto | null;
    ItemCount?: number;
    RepresentativeItem?: BaseItemDto | null;
    Children?: ExploreItemDto[];
};

type ExploreSectionDto = {
    Id?: string;
    Name?: string;
    Items?: ExploreItemDto[];
    TotalRecordCount?: number;
};

type SearchProfileContext = {
    ownerUserId: string;
    profileUserId: string;
    userId: string;
    serverId: string;
};

const SEARCH_HISTORY_LIMIT = 8;
const EXPLORE_GENRE_LIMIT = 12;
const EXPLORE_COLLECTION_LIMIT = 24;

const searchProfileContextKey = (apiClient?: ApiClient, userId?: string) => [
    'SearchDiscovery',
    'ProfileContext',
    apiClient?.serverId(),
    userId
];

const searchHistoryKey = (context?: SearchProfileContext) => [
    'SearchDiscovery',
    'History',
    context?.serverId,
    context?.ownerUserId,
    context?.profileUserId
];

const searchGenresKey = (context?: SearchProfileContext, parentId?: string) => [
    'SearchDiscovery',
    'Genres',
    context?.serverId,
    context?.userId,
    parentId
];

const searchCollectionsKey = (context?: SearchProfileContext) => [
    'SearchDiscovery',
    'Collections',
    context?.serverId,
    context?.userId
];

const getSearchProfileContext = async (apiClient: ApiClient, userId: string): Promise<SearchProfileContext> => {
    const selector = await getCurrentProfileSelector(apiClient);
    const activeProfile = selector ? getActiveProfile(selector) : null;
    const profileUserId = activeProfile?.ProfileUserId
        || selector?.CurrentDeviceProfileUserId
        || userId;

    return {
        ownerUserId: selector?.OwnerUserId || userId,
        profileUserId,
        userId: profileUserId,
        serverId: apiClient.serverId()
    };
};

const fetchSearchHistory = async (
    apiClient: ApiClient,
    context: SearchProfileContext
): Promise<SearchHistoryEntryDto[]> => {
    return apiClient.getJSON(apiClient.getUrl(
        `Users/${context.ownerUserId}/Profiles/${context.profileUserId}/Search/History`,
        { Limit: SEARCH_HISTORY_LIMIT }
    ), true);
};

const recordSearchHistory = async (
    apiClient: ApiClient,
    context: SearchProfileContext,
    searchTerm: string
) => {
    await apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl(`Users/${context.ownerUserId}/Profiles/${context.profileUserId}/Search/History`),
        contentType: 'application/json',
        data: JSON.stringify({ SearchTerm: searchTerm })
    });
};

const clearSearchHistory = async (
    apiClient: ApiClient,
    context: SearchProfileContext
) => {
    await apiClient.ajax({
        type: 'DELETE',
        url: apiClient.getUrl(`Users/${context.ownerUserId}/Profiles/${context.profileUserId}/Search/History`)
    });
};

const fetchExploreGenres = async (
    apiClient: ApiClient,
    context: SearchProfileContext
): Promise<ExploreSectionDto> => {
    return apiClient.getJSON(apiClient.getUrl(
        `Users/${context.userId}/Explore/Genres`,
        { Limit: EXPLORE_GENRE_LIMIT }
    ), true);
};

const fetchExploreCollections = async (
    apiClient: ApiClient,
    context: SearchProfileContext
): Promise<ExploreSectionDto> => {
    return apiClient.getJSON(apiClient.getUrl(
        `Users/${context.userId}/Explore/Collections`,
        {
            Limit: EXPLORE_COLLECTION_LIMIT,
            Depth: 3
        }
    ), true);
};

export const useSearchProfileContext = () => {
    const { __legacyApiClient__, user } = useApi();
    const userId = user?.Id;

    return useQuery({
        queryKey: searchProfileContextKey(__legacyApiClient__, userId),
        queryFn: () => getSearchProfileContext(__legacyApiClient__!, userId!),
        enabled: !!__legacyApiClient__ && !!userId,
        staleTime: 30_000
    });
};

export const useSearchHistory = () => {
    const { __legacyApiClient__ } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data;

    const query = useQuery({
        queryKey: searchHistoryKey(context),
        queryFn: () => fetchSearchHistory(__legacyApiClient__!, context!),
        enabled: !!__legacyApiClient__ && !!context
    });

    return {
        ...query,
        profileContext: context,
        isPending: profileContextQuery.isPending || query.isPending
    };
};

export const useExploreGenres = (parentId?: string) => {
    const { __legacyApiClient__ } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data;

    const query = useQuery({
        queryKey: searchGenresKey(context, parentId),
        queryFn: () => fetchExploreGenres(__legacyApiClient__!, context!),
        enabled: !!__legacyApiClient__ && !!context
    });

    return {
        ...query,
        isPending: profileContextQuery.isPending || query.isPending
    };
};

export const useExploreCollections = () => {
    const { __legacyApiClient__ } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data;

    const query = useQuery({
        queryKey: searchCollectionsKey(context),
        queryFn: () => fetchExploreCollections(__legacyApiClient__!, context!),
        enabled: !!__legacyApiClient__ && !!context
    });

    return {
        ...query,
        isPending: profileContextQuery.isPending || query.isPending
    };
};

export const useRecordSearchHistory = () => {
    const { __legacyApiClient__ } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data;

    return useMutation({
        mutationFn: (searchTerm: string) => recordSearchHistory(__legacyApiClient__!, context!, searchTerm),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: searchHistoryKey(context) });
        },
        retry: false
    });
};

export const useClearSearchHistory = () => {
    const { __legacyApiClient__ } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data;

    return useMutation({
        mutationFn: () => clearSearchHistory(__legacyApiClient__!, context!),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: searchHistoryKey(context) });
        },
        retry: false
    });
};

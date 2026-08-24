import type { Api } from '@jellyfin/sdk';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { SortOrder } from '@jellyfin/sdk/lib/generated-client/models/sort-order';
import { getGenresApi } from '@jellyfin/sdk/lib/utils/api/genres-api';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import type { ApiClient } from 'jellyfin-apiclient';
import { useMutation, useQuery } from '@tanstack/react-query';

import { useApi } from 'hooks/useApi';
import { getCurrentProfileSelector } from 'lib/profileSelector/api';
import { getActiveProfile } from 'lib/profileSelector/utils';
import { queryClient } from 'utils/query/queryClient';
import {
    clearSearchHistory,
    fetchExploreCollections,
    fetchExploreGenres,
    fetchSearchHistory,
    recordSearchHistory,
    requireSearchMutationContext,
    SEARCH_DISCOVERY_LIMITS,
    toStandardExploreItem,
    type ExploreItemDto,
    type ExploreSectionDto,
    type SearchDiscoveryFallback,
    type SearchProfileContext
} from './searchDiscoveryApi';

export type { ExploreItemDto, SearchHistoryEntryDto } from './searchDiscoveryApi';

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

const toExploreSection = (items: ExploreItemDto[], totalRecordCount?: number): ExploreSectionDto => ({
    Items: items,
    TotalRecordCount: totalRecordCount ?? items.length
});

const createStandardDiscoveryFallback = (api: Api): SearchDiscoveryFallback => ({
    fetchGenres: async (context, parentId) => {
        const response = await getGenresApi(api).getGenres({
            userId: context.userId,
            parentId,
            limit: SEARCH_DISCOVERY_LIMITS.genres,
            sortBy: [ ItemSortBy.SortName ],
            sortOrder: [ SortOrder.Ascending ],
            enableImages: true,
            enableTotalRecordCount: true
        });
        const items = (response.data.Items || []).map(toStandardExploreItem);

        return toExploreSection(items, response.data.TotalRecordCount);
    },
    fetchCollections: async context => {
        const response = await getItemsApi(api).getItems({
            userId: context.userId,
            includeItemTypes: [ BaseItemKind.BoxSet ],
            recursive: true,
            limit: SEARCH_DISCOVERY_LIMITS.collections,
            sortBy: [ ItemSortBy.SortName ],
            sortOrder: [ SortOrder.Ascending ],
            enableImages: true,
            enableTotalRecordCount: true
        });
        const items = (response.data.Items || []).map(toStandardExploreItem);

        return toExploreSection(items, response.data.TotalRecordCount);
    }
});

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
    const { api, __legacyApiClient__ } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data;

    const query = useQuery({
        queryKey: searchGenresKey(context, parentId),
        queryFn: () => fetchExploreGenres(
            __legacyApiClient__!,
            context!,
            createStandardDiscoveryFallback(api!),
            parentId
        ),
        enabled: !!api && !!__legacyApiClient__ && !!context
    });

    return {
        ...query,
        isPending: profileContextQuery.isPending || query.isPending
    };
};

export const useExploreCollections = () => {
    const { api, __legacyApiClient__ } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data;

    const query = useQuery({
        queryKey: searchCollectionsKey(context),
        queryFn: () => fetchExploreCollections(
            __legacyApiClient__!,
            context!,
            createStandardDiscoveryFallback(api!)
        ),
        enabled: !!api && !!__legacyApiClient__ && !!context
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

    const mutation = useMutation({
        mutationFn: (searchTerm: string) => {
            const ready = requireSearchMutationContext(__legacyApiClient__, context);
            return recordSearchHistory(ready.apiClient, ready.context, searchTerm);
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: searchHistoryKey(context) });
        },
        retry: false
    });

    return {
        ...mutation,
        isReady: !!__legacyApiClient__ && !!context
    };
};

export const useClearSearchHistory = () => {
    const { __legacyApiClient__ } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data;

    const mutation = useMutation({
        mutationFn: () => {
            const ready = requireSearchMutationContext(__legacyApiClient__, context);
            return clearSearchHistory(ready.apiClient, ready.context);
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: searchHistoryKey(context) });
        },
        retry: false
    });

    return {
        ...mutation,
        isReady: !!__legacyApiClient__ && !!context
    };
};

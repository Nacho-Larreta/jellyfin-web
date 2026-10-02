import type { Api } from '@jellyfin/sdk';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { SortOrder } from '@jellyfin/sdk/lib/generated-client/models/sort-order';
import { getGenresApi } from '@jellyfin/sdk/lib/utils/api/genres-api';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import type { ApiClient } from 'jellyfin-apiclient';
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { useApi } from 'hooks/useApi';
import { getCurrentProfileSelector } from 'lib/profileSelector/api';
import type { BoundSessionReadIdentity } from 'lib/profileSelector/sessionSwitch/boundRequests';
import type { SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
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
    type SearchDiscoveryContext,
    type SearchDiscoveryFallback,
    type SearchProfileContext
} from './searchDiscoveryApi';

export type { ExploreItemDto, SearchHistoryEntryDto } from './searchDiscoveryApi';

type SearchContexts = {
    discovery: SearchDiscoveryContext;
    history?: SearchProfileContext;
};

type HistorySelectorState = {
    IsEnabled?: boolean;
    OwnerUserId?: string | null;
    Profiles?: { ProfileUserId?: string | null; IsDisabled?: boolean }[];
};

const searchProfileContextKey = (apiClient?: ApiClient, userId?: string, identity?: BoundSessionReadIdentity) => [
    'SearchDiscovery',
    'ProfileContext',
    apiClient?.serverId(),
    userId,
    identity
];

const searchHistoryKey = (context?: SearchProfileContext, identity?: BoundSessionReadIdentity) => [
    'SearchDiscovery',
    'History',
    context?.serverId,
    context?.ownerUserId,
    context?.profileUserId,
    identity
];

const sameHistoryContext = (left?: SearchProfileContext, right?: SearchProfileContext) => !!left && !!right
    && left.serverId === right.serverId
    && left.ownerUserId === right.ownerUserId
    && left.profileUserId === right.profileUserId;

const currentHistoryContext = (
    cache: QueryClient,
    apiClient?: ApiClient,
    userId?: string,
    identity?: BoundSessionReadIdentity
): SearchProfileContext | undefined => {
    if (!apiClient || !userId || !identity) return undefined;
    const state = cache.getQueryState<SearchContexts>(searchProfileContextKey(apiClient, userId, identity));
    return state?.status === 'success' ? state.data?.history : undefined;
};

const searchGenresKey = (context?: SearchDiscoveryContext, parentId?: string, identity?: BoundSessionReadIdentity) => [
    'SearchDiscovery',
    'Genres',
    context?.serverId,
    context?.userId,
    parentId,
    identity
];

const searchCollectionsKey = (context?: SearchDiscoveryContext, identity?: BoundSessionReadIdentity) => [
    'SearchDiscovery',
    'Collections',
    context?.serverId,
    context?.userId,
    identity
];

const getSearchProfileContext = async (
    apiClient: ApiClient,
    userId: string,
    readApi?: SessionScopedReadApi
): Promise<SearchContexts> => {
    readApi?.assertCurrent();
    const selector = await getCurrentProfileSelector(apiClient) as HistorySelectorState | null;
    readApi?.assertCurrent();
    const discovery = { userId, serverId: apiClient.serverId() };
    const isLinkedMember = selector?.Profiles?.some(profile => (
        profile.ProfileUserId === userId && profile.IsDisabled !== true
    ));

    return {
        discovery,
        history: readApi && selector?.IsEnabled && selector.OwnerUserId && isLinkedMember ?
            { ...discovery, ownerUserId: selector.OwnerUserId, profileUserId: userId } :
            undefined
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
    const { __legacyApiClient__, user, sessionScopedReadApi, sessionQueryIdentity } = useApi();
    const userId = user?.Id;

    return useQuery({
        queryKey: searchProfileContextKey(__legacyApiClient__, userId, sessionQueryIdentity),
        queryFn: () => getSearchProfileContext(__legacyApiClient__!, userId!, sessionScopedReadApi),
        enabled: !!__legacyApiClient__ && !!userId,
        staleTime: 30_000
    });
};

export const useSearchHistory = () => {
    const { __legacyApiClient__, user, sessionScopedReadApi, sessionQueryIdentity } = useApi();
    const cache = useQueryClient();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.isSuccess ? profileContextQuery.data?.history : undefined;
    const previousHistoryKey = useRef<ReturnType<typeof searchHistoryKey>>();

    useEffect(() => {
        if (context) {
            previousHistoryKey.current = searchHistoryKey(context, sessionQueryIdentity);
        } else if (previousHistoryKey.current) {
            cache.removeQueries({ queryKey: previousHistoryKey.current, exact: true });
            previousHistoryKey.current = undefined;
        }
    }, [cache, context, sessionQueryIdentity]);

    const query = useQuery({
        queryKey: searchHistoryKey(context, sessionQueryIdentity),
        queryFn: async () => {
            const active = currentHistoryContext(cache, __legacyApiClient__, user?.Id, sessionQueryIdentity);
            if (!__legacyApiClient__ || !active || !sameHistoryContext(active, context) || !sessionScopedReadApi) return [];
            sessionScopedReadApi.assertCurrent();
            const history = await fetchSearchHistory(__legacyApiClient__, active);
            sessionScopedReadApi.assertCurrent();
            return sameHistoryContext(
                active, currentHistoryContext(cache, __legacyApiClient__, user?.Id, sessionQueryIdentity)
            ) ? history : [];
        },
        enabled: !!__legacyApiClient__ && !!context && !!sessionScopedReadApi
    });

    return {
        ...query,
        data: context ? query.data : [],
        isError: profileContextQuery.isError || query.isError,
        error: profileContextQuery.error ?? query.error,
        profileContext: context,
        isPending: profileContextQuery.isPending || (!!context && query.isPending)
    };
};

export const useExploreGenres = (parentId?: string) => {
    const { api, __legacyApiClient__, sessionQueryIdentity } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data?.discovery;

    const query = useQuery({
        queryKey: searchGenresKey(context, parentId, sessionQueryIdentity),
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
    const { api, __legacyApiClient__, sessionQueryIdentity } = useApi();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.data?.discovery;

    const query = useQuery({
        queryKey: searchCollectionsKey(context, sessionQueryIdentity),
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
    const { __legacyApiClient__, user, sessionScopedReadApi, sessionQueryIdentity } = useApi();
    const cache = useQueryClient();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.isSuccess ? profileContextQuery.data?.history : undefined;

    const mutation = useMutation({
        mutationFn: async (searchTerm: string) => {
            sessionScopedReadApi?.assertCurrent();
            const active = currentHistoryContext(cache, __legacyApiClient__, user?.Id, sessionQueryIdentity);
            const ready = requireSearchMutationContext(__legacyApiClient__, sameHistoryContext(active, context) ? active : undefined);
            if (!sessionScopedReadApi) throw new Error('Search history capability is not ready.');
            await recordSearchHistory(ready.apiClient, ready.context, searchTerm);
            sessionScopedReadApi.assertCurrent();
            requireSearchMutationContext(__legacyApiClient__, sameHistoryContext(
                ready.context, currentHistoryContext(cache, __legacyApiClient__, user?.Id, sessionQueryIdentity)
            ) ? ready.context : undefined);
        },
        onSuccess: () => {
            sessionScopedReadApi?.assertCurrent();
            if (sameHistoryContext(context, currentHistoryContext(cache, __legacyApiClient__, user?.Id, sessionQueryIdentity))) {
                void queryClient.invalidateQueries({ queryKey: searchHistoryKey(context, sessionQueryIdentity) });
            }
        },
        retry: false
    });

    return {
        ...mutation,
        isReady: !!__legacyApiClient__ && !!context && !!sessionScopedReadApi
    };
};

export const useClearSearchHistory = () => {
    const { __legacyApiClient__, user, sessionScopedReadApi, sessionQueryIdentity } = useApi();
    const cache = useQueryClient();
    const profileContextQuery = useSearchProfileContext();
    const context = profileContextQuery.isSuccess ? profileContextQuery.data?.history : undefined;

    const mutation = useMutation({
        mutationFn: async () => {
            sessionScopedReadApi?.assertCurrent();
            const active = currentHistoryContext(cache, __legacyApiClient__, user?.Id, sessionQueryIdentity);
            const ready = requireSearchMutationContext(__legacyApiClient__, sameHistoryContext(active, context) ? active : undefined);
            if (!sessionScopedReadApi) throw new Error('Search history capability is not ready.');
            await clearSearchHistory(ready.apiClient, ready.context);
            sessionScopedReadApi.assertCurrent();
            requireSearchMutationContext(__legacyApiClient__, sameHistoryContext(
                ready.context, currentHistoryContext(cache, __legacyApiClient__, user?.Id, sessionQueryIdentity)
            ) ? ready.context : undefined);
        },
        onSuccess: () => {
            sessionScopedReadApi?.assertCurrent();
            if (sameHistoryContext(context, currentHistoryContext(cache, __legacyApiClient__, user?.Id, sessionQueryIdentity))) {
                void queryClient.invalidateQueries({ queryKey: searchHistoryKey(context, sessionQueryIdentity) });
            }
        },
        retry: false
    });

    return {
        ...mutation,
        isReady: !!__legacyApiClient__ && !!context && !!sessionScopedReadApi
    };
};

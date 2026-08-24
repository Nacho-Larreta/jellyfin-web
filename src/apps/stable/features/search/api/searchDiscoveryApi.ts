import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { ApiClient } from 'jellyfin-apiclient';

export type SearchHistoryEntryDto = {
    SearchTerm: string;
    HitCount: number;
    LastSearchedUtc: string;
};

export type ExploreItemDto = {
    Id?: string;
    Name?: string | null;
    Overview?: string | null;
    Type?: string;
    Item?: BaseItemDto | null;
    ItemCount?: number;
    RepresentativeItem?: BaseItemDto | null;
    Children?: ExploreItemDto[];
};

export type ExploreSectionDto = {
    Id?: string;
    Name?: string;
    Items?: ExploreItemDto[];
    TotalRecordCount?: number;
};

export const toStandardExploreItem = (item: BaseItemDto): ExploreItemDto => {
    const itemCount = item.RecursiveItemCount ?? item.ChildCount ?? undefined;

    return {
        Id: item.Id,
        Name: item.Name,
        Item: item,
        RepresentativeItem: item,
        ...(itemCount === undefined ? {} : { ItemCount: itemCount })
    };
};

export type SearchProfileContext = {
    ownerUserId: string;
    profileUserId: string;
    userId: string;
    serverId: string;
};

type SearchDiscoveryApiClient = Pick<ApiClient, 'ajax' | 'getJSON' | 'getUrl'>;

export type SearchDiscoveryFallback = {
    fetchGenres: (context: SearchProfileContext, parentId?: string) => Promise<ExploreSectionDto>;
    fetchCollections: (context: SearchProfileContext) => Promise<ExploreSectionDto>;
};

const SEARCH_HISTORY_LIMIT = 8;
const EXPLORE_GENRE_LIMIT = 12;
const EXPLORE_COLLECTION_LIMIT = 24;

const isNotFoundError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const response = error as { status?: number; response?: { status?: number } };
    return response.status === 404 || response.response?.status === 404;
};

export const requireSearchMutationContext = (
    apiClient?: SearchDiscoveryApiClient,
    context?: SearchProfileContext
) => {
    if (!apiClient || !context) {
        throw new Error('Search profile context is not ready.');
    }

    return { apiClient, context };
};

export const fetchSearchHistory = async (
    apiClient: SearchDiscoveryApiClient,
    context: SearchProfileContext
): Promise<SearchHistoryEntryDto[]> => {
    try {
        return await apiClient.getJSON(apiClient.getUrl(
            `Users/${context.ownerUserId}/Profiles/${context.profileUserId}/Search/History`,
            { Limit: SEARCH_HISTORY_LIMIT }
        ), true);
    } catch (error) {
        if (isNotFoundError(error)) {
            return [];
        }

        throw error;
    }
};

export const recordSearchHistory = async (
    apiClient: SearchDiscoveryApiClient,
    context: SearchProfileContext,
    searchTerm: string
): Promise<void> => {
    try {
        await apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl(`Users/${context.ownerUserId}/Profiles/${context.profileUserId}/Search/History`),
            contentType: 'application/json',
            data: JSON.stringify({ SearchTerm: searchTerm })
        });
    } catch (error) {
        if (!isNotFoundError(error)) {
            throw error;
        }
    }
};

export const clearSearchHistory = async (
    apiClient: SearchDiscoveryApiClient,
    context: SearchProfileContext
): Promise<void> => {
    try {
        await apiClient.ajax({
            type: 'DELETE',
            url: apiClient.getUrl(`Users/${context.ownerUserId}/Profiles/${context.profileUserId}/Search/History`)
        });
    } catch (error) {
        if (!isNotFoundError(error)) {
            throw error;
        }
    }
};

export const fetchExploreGenres = async (
    apiClient: SearchDiscoveryApiClient,
    context: SearchProfileContext,
    fallback: SearchDiscoveryFallback,
    parentId?: string
): Promise<ExploreSectionDto> => {
    try {
        return await apiClient.getJSON(apiClient.getUrl(
            `Users/${context.userId}/Explore/Genres`,
            {
                Limit: EXPLORE_GENRE_LIMIT,
                ParentId: parentId
            }
        ), true);
    } catch (error) {
        if (isNotFoundError(error)) {
            return fallback.fetchGenres(context, parentId);
        }

        throw error;
    }
};

export const fetchExploreCollections = async (
    apiClient: SearchDiscoveryApiClient,
    context: SearchProfileContext,
    fallback: SearchDiscoveryFallback
): Promise<ExploreSectionDto> => {
    try {
        return await apiClient.getJSON(apiClient.getUrl(
            `Users/${context.userId}/Explore/Collections`,
            {
                Limit: EXPLORE_COLLECTION_LIMIT,
                Depth: 3
            }
        ), true);
    } catch (error) {
        if (isNotFoundError(error)) {
            return fallback.fetchCollections(context);
        }

        throw error;
    }
};

export const SEARCH_DISCOVERY_LIMITS = {
    genres: EXPLORE_GENRE_LIMIT,
    collections: EXPLORE_COLLECTION_LIMIT
} as const;

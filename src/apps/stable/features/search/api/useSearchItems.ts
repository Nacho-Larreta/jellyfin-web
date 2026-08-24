import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../../hooks/useApi';
import { addSection, getItemTypesFromCollectionType, isLivetv, isMovies, isMusic, isTVShows, sortSections } from '../utils/search';
import { buildSearchResultData } from '../utils/searchResultData';
import { useArtistsSearch } from './useArtistsSearch';
import { usePeopleSearch } from './usePeopleSearch';
import { useVideoSearch } from './useVideoSearch';
import { Section } from '../types';
import { useLiveTvSearch } from './useLiveTvSearch';
import { fetchItemsByType } from './fetchItemsByType';
import { useProgramsSearch } from './useProgramsSearch';
import { LIVETV_CARD_OPTIONS } from '../constants/liveTvCardOptions';

type SearchItemFilters = {
    genre?: string;
};

type SearchItemsResult = {
    Items?: BaseItemDto[] | null;
};

const isAuxiliarySearchReady = (
    hasGenreFilter: boolean,
    isPending: boolean,
    collectionType: CollectionType | undefined,
    isCollectionTypeEnabled: boolean
): boolean => hasGenreFilter || !isPending || (!!collectionType && isCollectionTypeEnabled);

const addAuxiliarySections = (
    sections: Section[],
    artists?: SearchItemsResult,
    programs?: SearchItemsResult,
    people?: SearchItemsResult,
    videos?: SearchItemsResult
) => {
    addSection(sections, 'Artists', artists?.Items, {
        coverImage: true
    });

    addSection(sections, 'Programs', programs?.Items, {
        ...LIVETV_CARD_OPTIONS
    });

    addSection(sections, 'People', people?.Items, {
        coverImage: true
    });

    addSection(sections, 'HeaderVideos', videos?.Items, {
        showParentTitle: true
    });
};

export const useSearchItems = (
    parentId?: string,
    collectionType?: CollectionType,
    searchTerm?: string,
    filters: SearchItemFilters = {}
) => {
    const normalizedGenre = filters.genre?.trim() || undefined;
    const hasGenreFilter = Boolean(normalizedGenre);
    const auxiliarySearchTerm = hasGenreFilter ? undefined : searchTerm;
    const { data: artists, isPending: isArtistsPending } = useArtistsSearch(parentId, collectionType, auxiliarySearchTerm);
    const { data: people, isPending: isPeoplePending } = usePeopleSearch(parentId, collectionType, auxiliarySearchTerm);
    const { data: videos, isPending: isVideosPending } = useVideoSearch(parentId, collectionType, auxiliarySearchTerm);
    const { data: programs, isPending: isProgramsPending } = useProgramsSearch(parentId, collectionType, auxiliarySearchTerm);
    const { data: liveTvSections, isPending: isLiveTvPending } = useLiveTvSearch(parentId, collectionType, auxiliarySearchTerm);
    const { api, user } = useApi();
    const userId = user?.Id;

    const isArtistsEnabled = isAuxiliarySearchReady(hasGenreFilter, isArtistsPending, collectionType, collectionType ? !isMusic(collectionType) : false);
    const isPeopleEnabled = isAuxiliarySearchReady(
        hasGenreFilter,
        isPeoplePending,
        collectionType,
        collectionType ? !isMovies(collectionType) && !isTVShows(collectionType) : false
    );
    const isVideosEnabled = isAuxiliarySearchReady(hasGenreFilter, isVideosPending, collectionType, true);
    const isProgramsEnabled = isAuxiliarySearchReady(hasGenreFilter, isProgramsPending, collectionType, true);
    const isLiveTvEnabled = hasGenreFilter || !isLiveTvPending || !collectionType || !isLivetv(collectionType);

    return useQuery({
        queryKey: ['Search', 'Items', collectionType, parentId, searchTerm, normalizedGenre],
        queryFn: async ({ signal }) => {
            if (!hasGenreFilter && liveTvSections && collectionType && isLivetv(collectionType)) {
                const sections = sortSections(liveTvSections);
                return {
                    sections,
                    topResult: sections[0]?.items[0]
                };
            }

            const sections: Section[] = [];

            if (!hasGenreFilter) {
                addAuxiliarySections(sections, artists, programs, people, videos);
            }

            const itemTypes: BaseItemKind[] = getItemTypesFromCollectionType(collectionType);

            const searchData = await fetchItemsByType(
                api!,
                userId,
                {
                    includeItemTypes: itemTypes,
                    parentId,
                    searchTerm: hasGenreFilter ? undefined : searchTerm,
                    genres: normalizedGenre ? [normalizedGenre] : undefined,
                    isMissing: itemTypes.includes(BaseItemKind.Episode) && !user?.Configuration?.DisplayMissingEpisodes ? false : undefined,
                    limit: 800
                },
                { signal }
            );

            return buildSearchResultData(sections, itemTypes, searchData.Items || []);
        },
        enabled: (
            !!api
            && !!userId
            && !!isArtistsEnabled
            && !!isPeopleEnabled
            && !!isVideosEnabled
            && !!isLiveTvEnabled
            && !!isProgramsEnabled
        )
    });
};

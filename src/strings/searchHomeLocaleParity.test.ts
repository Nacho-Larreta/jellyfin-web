import { describe, expect, it } from 'vitest';

import enUs from './en-us.json';
import es from './es.json';
import es419 from './es_419.json';

const SEARCH_HOME_KEYS = [
    'SearchAllDecades',
    'SearchAllInGenre',
    'SearchClearHistory',
    'SearchClearInput',
    'SearchDiscoveryEmptyBody',
    'SearchDiscoveryEmptyTitle',
    'SearchDiscoveryErrorBody',
    'SearchDiscoveryErrorTitle',
    'SearchDiscoveryPartialError',
    'SearchExploreByCollection',
    'SearchExploreByGenre',
    'SearchExploreCollectionHint',
    'SearchExploreGenreHint',
    'SearchFeatured',
    'SearchFilteredCount',
    'SearchFilterByDecade',
    'SearchFilters',
    'SearchGenreContext',
    'SearchGenreDescriptionAction',
    'SearchGenreDescriptionAdventure',
    'SearchGenreDescriptionAnimation',
    'SearchGenreDescriptionComedy',
    'SearchGenreDescriptionCrime',
    'SearchGenreDescriptionDefault',
    'SearchGenreDescriptionDocumentary',
    'SearchGenreDescriptionDrama',
    'SearchGenreDescriptionFamily',
    'SearchGenreDescriptionFantasy',
    'SearchGenreDescriptionHorror',
    'SearchGenreDescriptionKids',
    'SearchGenreDescriptionRomance',
    'SearchGenreDescriptionScienceFiction',
    'SearchGenreDescriptionThriller',
    'SearchGenreFilters',
    'SearchInYourLibrary',
    'SearchInputPlaceholder',
    'SearchItemsCount',
    'SearchNoContentFor',
    'SearchNoResults',
    'SearchNoResultsFor',
    'SearchNoResultsHint',
    'SearchRecentSearches',
    'SearchResultsErrorBody',
    'SearchResultsErrorTitle',
    'SearchSortRating',
    'SearchSortRecent',
    'SearchSortRelevance',
    'SearchSortResults',
    'SearchTitleCount',
    'SearchTitlesCount',
    'SearchTopResult',
    'SearchTopResultFor',
    'SearchTrending',
    'SearchTrendingHint',
    'SearchUnknownYear',
    'Channel',
    'HomeContinueWatchingHint',
    'HomeEmptyBody',
    'HomeEmptyTitle',
    'HomeErrorBody',
    'HomeErrorTitle',
    'HomeMinutesRemaining',
    'HomeNextEpisodeCode',
    'HomeNextUpHint',
    'HomePartialBody',
    'HomePartialTitle',
    'HomeRecentlyAddedHint',
    'Item',
    'MoreInfo',
    'RecentlyAdded',
    'Song',
    'ViewAll'
] as const;

const locales = {
    'en-US': enUs,
    es,
    'es-419': es419
};

describe('Search and Home locale coverage', () => {
    it.each(Object.entries(locales))('%s owns every new string', (_locale, strings) => {
        for (const key of SEARCH_HOME_KEYS) {
            expect(strings[key], key).toBeTypeOf('string');
            expect(strings[key], key).not.toHaveLength(0);
        }
    });
});

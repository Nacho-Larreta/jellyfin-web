import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import React, { type FC, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useSearchItems } from '../api/useSearchItems';
import globalize from 'lib/globalize';
import Loading from 'components/loading/LoadingComponent';
import { Section } from '../types';
import { appRouter } from 'components/router/appRouter';
import { useApi } from 'hooks/useApi';
import { getItemBackdropImageUrl } from 'utils/jellyfin-apiclient/backdropImage';
import {
    getSearchItemImageUrl,
    getSearchItemInitials,
    getSearchItemSubtitle,
    getSearchItemTypeLabel
} from '../utils/search';
import { normalizeRouterUrl } from '../utils/searchRoutes';
import {
    FilterPill,
    GenreFilterButton,
    GenreSortButton,
    type GenreSortOption
} from './SearchFilterControls';

interface SearchResultsProps {
    parentId?: string;
    collectionType?: CollectionType;
    genre?: string;
    collectionName?: string;
    query?: string;
}

const ALL_FILTER = 'all';
const ALL_DECADES = 'all';

const getTitleCountLabel = (count: number) => globalize.translate(
    count === 1 ? 'SearchTitleCount' : 'SearchTitlesCount',
    count
);

const getGenreDescription = (genreName: string) => {
    const descriptions: Record<string, string> = {
        'acción': 'SearchGenreDescriptionAction',
        'animación': 'SearchGenreDescriptionAnimation',
        'aventura': 'SearchGenreDescriptionAdventure',
        'ciencia ficción': 'SearchGenreDescriptionScienceFiction',
        'comedia': 'SearchGenreDescriptionComedy',
        'crimen': 'SearchGenreDescriptionCrime',
        'documentales': 'SearchGenreDescriptionDocumentary',
        'drama': 'SearchGenreDescriptionDrama',
        'familiar': 'SearchGenreDescriptionFamily',
        'fantasía': 'SearchGenreDescriptionFantasy',
        'kids': 'SearchGenreDescriptionKids',
        'romance': 'SearchGenreDescriptionRomance',
        'terror': 'SearchGenreDescriptionHorror',
        'thriller': 'SearchGenreDescriptionThriller'
    };
    const descriptionKey = descriptions[genreName.toLocaleLowerCase()];

    return descriptionKey ? globalize.translate(descriptionKey) : globalize.translate('SearchGenreDescriptionDefault', genreName);
};

const getDecadeValue = (year?: number | null) => {
    if (!year) {
        return 'unknown';
    }

    return `${Math.floor(year / 10) * 10}`;
};

const getDecadeLabel = (value: string) => {
    if (value === ALL_DECADES) {
        return globalize.translate('SearchAllDecades');
    }

    if (value === 'unknown') {
        return globalize.translate('SearchUnknownYear');
    }

    return `${value}s`;
};

const getRatingPercent = (item: BaseItemDto) => {
    if (!item.CommunityRating) {
        return undefined;
    }

    return `${Math.round(item.CommunityRating * 10)}%`;
};

const getSortedGenreItems = (items: BaseItemDto[], sortBy: GenreSortOption) => {
    const sortableItems = [...items];

    if (sortBy === 'recent') {
        return sortableItems.sort((a, b) => (b.ProductionYear || 0) - (a.ProductionYear || 0));
    }

    if (sortBy === 'rating') {
        return sortableItems.sort((a, b) => (b.CommunityRating || 0) - (a.CommunityRating || 0));
    }

    return sortableItems;
};

export const createGenreTypeFilters = (
    sections: Section[],
    translate: (key: string) => string
) => [
    {
        id: ALL_FILTER,
        label: translate('All'),
        count: sections.reduce((count, section) => count + section.items.length, 0)
    },
    ...sections.map(section => ({
        id: section.title,
        label: translate(section.title),
        count: section.items.length
    }))
];

/*
 * React component to display search result rows for global search and library view search
 */
const SearchResults: FC<SearchResultsProps> = ({
    parentId,
    collectionType,
    genre,
    collectionName,
    query
}) => {
    const { data, isPending, isError, refetch } = useSearchItems(parentId, collectionType, query?.trim(), {
        genre
    });
    const [activeFilter, setActiveFilter] = useState('all');
    const contextLabel = genre ? globalize.translate('SearchGenreContext', genre) : collectionName || query;
    const emptyLabel = contextLabel || globalize.translate('Search');
    const retrySearch = useCallback(() => {
        refetch().catch(error => console.error('Failed to retry search.', error));
    }, [ refetch ]);

    useEffect(() => {
        if (activeFilter !== 'all' && data && !data.sections.some(section => section.title === activeFilter)) {
            setActiveFilter('all');
        }
    }, [ activeFilter, data ]);

    if (isPending) {
        return (
            <div className='search-screen__body'>
                <Loading />
            </div>
        );
    }

    if (isError) {
        return (
            <SearchErrorState onRetry={retrySearch} />
        );
    }

    if (!data?.sections.length) {
        return (
            <div className='search-screen__body search-no-results'>
                <div className='search-no-results__panel'>
                    <p className='search-eyebrow'>{globalize.translate('SearchNoResults')}</p>
                    <h2>
                        {query ?
                            globalize.translate('SearchNoResultsFor', query) :
                            globalize.translate('SearchNoContentFor', emptyLabel)}
                    </h2>
                    <p>{globalize.translate('SearchNoResultsHint')}</p>
                </div>
                {collectionType && query && (
                    <div>
                        <Link
                            className='search-action-link'
                            to={`/search?query=${encodeURIComponent(query || '')}`}
                        >{globalize.translate('RetryWithGlobalSearch')}</Link>
                    </div>
                )}
            </div>
        );
    }

    const activeSections = activeFilter === 'all' ?
        data.sections :
        data.sections.filter(section => section.title === activeFilter);
    const resultCount = activeSections.reduce((total, section) => total + section.items.length, 0);
    const topResult = data.topResult;

    if (genre && !query) {
        return (
            <GenreBrowseResults
                genre={genre}
                sections={data.sections}
                topResult={topResult}
            />
        );
    }

    return (
        <div className='search-screen__body search-results'>
            <div className='filter-pill-list' role='group' aria-label={globalize.translate('SearchFilters')}>
                <FilterPill
                    id='all'
                    label={globalize.translate('All')}
                    count={data.sections.reduce((total, section) => total + section.items.length, 0)}
                    isActive={activeFilter === 'all'}
                    onSelect={setActiveFilter}
                />
                {data.sections.map(section => (
                    <FilterPill
                        key={section.title}
                        id={section.title}
                        label={globalize.translate(section.title)}
                        count={section.items.length}
                        isActive={activeFilter === section.title}
                        onSelect={setActiveFilter}
                    />
                ))}
            </div>

            {activeFilter === 'all' && topResult && (
                <TopResult item={topResult} contextLabel={contextLabel} />
            )}

            <section className='search-section'>
                <div className='search-section__header'>
                    <h2 className='search-section__title'>
                        {activeFilter === 'all' ? globalize.translate('SearchResults') : globalize.translate(activeFilter)}
                    </h2>
                    <span className='search-section__meta'>{globalize.translate('SearchItemsCount', resultCount)}</span>
                </div>
                {activeSections.map(section => (
                    <SearchResultSection key={section.title} section={section} />
                ))}
            </section>
        </div>
    );
};

const GenreBrowseResults = ({
    genre,
    sections,
    topResult
}: {
    genre: string;
    sections: Section[];
    topResult?: BaseItemDto;
}) => {
    const [activeFilter, setActiveFilter] = useState(ALL_FILTER);
    const [activeDecade, setActiveDecade] = useState(ALL_DECADES);
    const [sortBy, setSortBy] = useState<GenreSortOption>('relevance');
    const onDecadeChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        setActiveDecade(event.target.value);
    }, []);

    const allItems = useMemo(() => sections.flatMap(section => section.items), [ sections ]);
    const typeFilters = useMemo(() => createGenreTypeFilters(
        sections,
        key => globalize.translate(key)
    ), [ sections ]);
    const decadeFilters = useMemo(() => {
        const decadeValues = new Set(allItems.map(item => getDecadeValue(item.ProductionYear)));

        return [
            ALL_DECADES,
            ...Array.from(decadeValues).sort((a, b) => {
                if (a === 'unknown') return 1;
                if (b === 'unknown') return -1;

                return Number(b) - Number(a);
            })
        ];
    }, [ allItems ]);
    const filteredItems = useMemo(() => {
        const typeItems = activeFilter === ALL_FILTER ?
            allItems :
            sections.find(section => section.title === activeFilter)?.items || [];
        const decadeItems = activeDecade === ALL_DECADES ?
            typeItems :
            typeItems.filter(item => getDecadeValue(item.ProductionYear) === activeDecade);

        return getSortedGenreItems(decadeItems, sortBy);
    }, [ activeDecade, activeFilter, allItems, sections, sortBy ]);

    useEffect(() => {
        if (!typeFilters.some(filter => filter.id === activeFilter)) {
            setActiveFilter(ALL_FILTER);
        }
    }, [ activeFilter, typeFilters ]);

    useEffect(() => {
        if (!decadeFilters.includes(activeDecade)) {
            setActiveDecade(ALL_DECADES);
        }
    }, [ activeDecade, decadeFilters ]);

    return (
        <div className='search-screen__body search-genre-page'>
            <GenreHero genre={genre} item={topResult} totalCount={allItems.length} />
            <div className='genre-browse-controls'>
                <div className='genre-browse-filter-row' role='group' aria-label={globalize.translate('SearchGenreFilters')}>
                    {typeFilters.map(filter => (
                        <GenreFilterButton
                            key={filter.id}
                            id={filter.id}
                            label={filter.label}
                            count={filter.count}
                            isActive={activeFilter === filter.id}
                            onSelect={setActiveFilter}
                        />
                    ))}
                    <select
                        id='genreDecadeFilter'
                        name='genreDecadeFilter'
                        className='genre-decade-select'
                        aria-label={globalize.translate('SearchFilterByDecade')}
                        value={activeDecade}
                        onChange={onDecadeChange}
                    >
                        {decadeFilters.map(decade => (
                            <option key={decade} value={decade}>{getDecadeLabel(decade)}</option>
                        ))}
                    </select>
                </div>
                <div className='genre-sort-row' role='group' aria-label={globalize.translate('SearchSortResults')}>
                    <span>{globalize.translate('LabelSortBy')}</span>
                    <GenreSortButton id='relevance' label={globalize.translate('SearchSortRelevance')} activeSort={sortBy} onSelect={setSortBy} />
                    <GenreSortButton id='recent' label={globalize.translate('SearchSortRecent')} activeSort={sortBy} onSelect={setSortBy} />
                    <GenreSortButton id='rating' label={globalize.translate('SearchSortRating')} activeSort={sortBy} onSelect={setSortBy} />
                </div>
            </div>
            <section className='genre-browse-results'>
                <div className='genre-browse-results__header'>
                    <h2>{globalize.translate('SearchAllInGenre')} <span className='genre-browse-results__genre'>{genre}</span></h2>
                    <span className='genre-browse-results__count'>{globalize.translate('SearchFilteredCount', filteredItems.length, getTitleCountLabel(allItems.length))}</span>
                </div>
                <div className='genre-card-grid'>
                    {filteredItems.map((item, index) => (
                        <GenreBrowseCard key={item.Id || `${item.Name}-${index}`} item={item} />
                    ))}
                </div>
            </section>
        </div>
    );
};

const GenreHero = ({
    genre,
    item,
    totalCount
}: {
    genre: string;
    item?: BaseItemDto;
    totalCount: number;
}) => {
    const { __legacyApiClient__ } = useApi();
    const backdropUrl = __legacyApiClient__ && item ?
        getItemBackdropImageUrl(__legacyApiClient__, item, {
            fillWidth: 1600,
            fillHeight: 720,
            quality: 96
        }) :
        undefined;
    const posterUrl = item ? getSearchItemImageUrl(__legacyApiClient__, item, {
        fillWidth: 180,
        fillHeight: 270
    }) : undefined;

    return (
        <section className='genre-hero'>
            {backdropUrl && (
                <span
                    className='genre-hero__backdrop'
                    style={{ backgroundImage: `url("${backdropUrl}")` }}
                    aria-hidden='true'
                />
            )}
            <span className='genre-hero__ghost' aria-hidden='true'>{genre}</span>
            <div className='genre-hero__content'>
                <span className='genre-hero__kicker'>
                    <span aria-hidden='true' />
                    {globalize.translate('Genre')} · {getTitleCountLabel(totalCount)}
                </span>
                <h1>{genre}</h1>
                <p>{getGenreDescription(genre)}</p>
                {item && (
                    <div className='genre-feature-card'>
                        <span className='genre-feature-card__poster'>
                            {posterUrl ? (
                                <img src={posterUrl} alt='' loading='lazy' />
                            ) : (
                                <span>{getSearchItemInitials(item)}</span>
                            )}
                        </span>
                        <span className='genre-feature-card__content'>
                            <span className='genre-feature-card__label'>{globalize.translate('SearchFeatured')}</span>
                            <strong>{item.Name}</strong>
                            <span className='genre-feature-card__subtitle'>{getSearchItemSubtitle(item) || globalize.translate('SearchInYourLibrary')}</span>
                            <span className='genre-feature-card__actions'>
                                <Link className='genre-secondary-action' to={normalizeRouterUrl(appRouter.getRouteUrl(item))}>{globalize.translate('MoreInfo')}</Link>
                            </span>
                        </span>
                    </div>
                )}
            </div>
        </section>
    );
};

const GenreBrowseCard = ({ item }: { item: BaseItemDto }) => {
    const { __legacyApiClient__ } = useApi();
    const imageUrl = getSearchItemImageUrl(__legacyApiClient__, item, {
        fillWidth: 360,
        fillHeight: 540
    });
    const rating = getRatingPercent(item);

    return (
        <Link className='genre-card' to={normalizeRouterUrl(appRouter.getRouteUrl(item))}>
            <span className='genre-card__poster'>
                {imageUrl ? (
                    <img src={imageUrl} alt='' loading='lazy' />
                ) : (
                    <span className='genre-card__fallback'>{getSearchItemInitials(item)}</span>
                )}
                <span className='genre-card__type'>{getSearchItemTypeLabel(item).toLocaleUpperCase()}</span>
                {rating && (
                    <span className='genre-card__rating'>{rating}</span>
                )}
            </span>
            <span className='genre-card__title'>{item.Name}</span>
            {item.ProductionYear && (
                <span className='genre-card__year'>{item.ProductionYear}</span>
            )}
        </Link>
    );
};

const TopResult = ({ item, contextLabel }: { item: BaseItemDto; contextLabel?: string }) => {
    const { __legacyApiClient__ } = useApi();
    const backdropUrl = __legacyApiClient__ ?
        getItemBackdropImageUrl(__legacyApiClient__, item, {
            fillWidth: 960,
            fillHeight: 420,
            quality: 96
        }) :
        undefined;
    const posterUrl = getSearchItemImageUrl(__legacyApiClient__, item, {
        fillWidth: 220,
        fillHeight: 330
    });

    return (
        <Link className='top-result' to={normalizeRouterUrl(appRouter.getRouteUrl(item))}>
            {backdropUrl && (
                <span
                    className='top-result__backdrop'
                    style={{ backgroundImage: `url("${backdropUrl}")` }}
                    aria-hidden='true'
                />
            )}
            <span className='top-result__poster'>
                {posterUrl ? (
                    <img src={posterUrl} alt='' loading='lazy' />
                ) : (
                    <span className='result-card__fallback'>{getSearchItemInitials(item)}</span>
                )}
            </span>
            <span className='top-result__content'>
                <span className='search-eyebrow'>
                    {contextLabel ? globalize.translate('SearchTopResultFor', contextLabel) : globalize.translate('SearchTopResult')}
                </span>
                <span className='top-result__title'>{item.Name}</span>
                <span className='top-result__meta'>{getSearchItemSubtitle(item)}</span>
                {item.Overview && (
                    <span className='top-result__overview'>{item.Overview}</span>
                )}
            </span>
        </Link>
    );
};

const SearchResultSection = ({ section }: { section: Section }) => (
    <div className='search-results-group'>
        <h3 className='search-results-group__title'>{globalize.translate(section.title)}</h3>
        <div className='search-results-grid'>
            {section.items.map((item, index) => (
                <SearchResultCard key={item.Id || `${section.title}-${item.Name}-${index}`} item={item} />
            ))}
        </div>
    </div>
);

const SearchResultCard = ({ item }: { item: BaseItemDto }) => {
    const { __legacyApiClient__ } = useApi();
    const imageUrl = getSearchItemImageUrl(__legacyApiClient__, item, {
        fillWidth: 320,
        fillHeight: 480
    });

    return (
        <Link className='result-card' to={normalizeRouterUrl(appRouter.getRouteUrl(item))}>
            <span className='result-card__image'>
                {imageUrl ? (
                    <img src={imageUrl} alt='' loading='lazy' />
                ) : (
                    <span className='result-card__fallback'>{getSearchItemInitials(item)}</span>
                )}
                <span className='result-card__type'>{getSearchItemTypeLabel(item)}</span>
                <span className='result-card__play' aria-hidden='true'>▶</span>
            </span>
            <span className='result-card__title'>{item.Name}</span>
            <span className='result-card__meta'>{getSearchItemSubtitle(item)}</span>
        </Link>
    );
};

export default SearchResults;

const SearchErrorState = ({ onRetry }: { onRetry: () => void }) => (
    <div className='search-screen__body search-no-results' role='alert'>
        <div className='search-no-results__panel'>
            <h2>{globalize.translate('SearchResultsErrorTitle')}</h2>
            <p>{globalize.translate('SearchResultsErrorBody')}</p>
            <button type='button' className='search-action-link' onClick={onRetry}>
                {globalize.translate('Retry')}
            </button>
        </div>
    </div>
);

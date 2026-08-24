import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import React, {
    FunctionComponent,
    type CSSProperties,
    useCallback
} from 'react';
import { Link } from 'react-router-dom';

import Loading from 'components/loading/LoadingComponent';
import { appRouter } from 'components/router/appRouter';
import globalize from 'lib/globalize';
import { useSearchSuggestions } from '../api/useSearchSuggestions';
import { useApi } from 'hooks/useApi';
import {
    type ExploreItemDto,
    type SearchHistoryEntryDto,
    useClearSearchHistory,
    useExploreCollections,
    useExploreGenres,
    useSearchHistory
} from '../api/useSearchDiscovery';
import {
    getSearchItemImageUrl,
    getSearchItemInitials,
    getSearchItemSubtitle
} from '../utils/search';
import {
    getCollectionBrowseUrl,
    getGenreBrowseUrl,
    normalizeRouterUrl
} from '../utils/searchRoutes';

type SearchShortcut = {
    label: string;
    query: string;
};

type ShortcutButtonProps = {
    shortcut: SearchShortcut;
    className: string;
    onSearch: (query: string) => void;
    children: React.ReactNode;
};

type SearchSuggestionsProps = {
    parentId?: string | null;
    onSearch: (query: string) => void;
};

const getItemMeta = (item: BaseItemDto) => {
    const segments = [
        item.Type,
        item.ProductionYear?.toString()
    ].filter(Boolean);

    return getSearchItemSubtitle(item) || segments.join(' · ') || globalize.translate('SearchInYourLibrary');
};

const getExploreItemName = (item: ExploreItemDto) => item.Name || item.Item?.Name || '';

const getExploreItemCountLabel = (item: ExploreItemDto) => {
    const count = item.ItemCount;

    if (count === undefined) {
        return null;
    }

    return globalize.translate(count === 1 ? 'SearchTitleCount' : 'SearchTitlesCount', count);
};

const getExploreItemRouteUrl = (
    item: ExploreItemDto,
    kind: 'genre' | 'collection',
    name: string
) => {
    if (kind === 'genre') {
        return getGenreBrowseUrl(name);
    }

    if (item.Item) {
        return normalizeRouterUrl(appRouter.getRouteUrl(item.Item));
    }

    return item.Id ? getCollectionBrowseUrl(item.Id, name) : undefined;
};

const getExploreTileStyle = (imageUrl?: string | null): CSSProperties | undefined => {
    if (!imageUrl) {
        return undefined;
    }

    return {
        '--search-tile-image': `url("${imageUrl}")`
    } as CSSProperties;
};

const ShortcutButton = ({ shortcut, className, onSearch, children }: ShortcutButtonProps) => {
    const onClick = useCallback(() => {
        onSearch(shortcut.query);
    }, [ onSearch, shortcut.query ]);

    return (
        <button
            type='button'
            className={className}
            onClick={onClick}
        >
            {children}
        </button>
    );
};

const RecentSearchChip = ({
    historyEntry,
    onSearch
}: {
    historyEntry: SearchHistoryEntryDto;
    onSearch: (query: string) => void;
}) => (
    <ShortcutButton
        shortcut={{
            label: historyEntry.SearchTerm,
            query: historyEntry.SearchTerm
        }}
        className='recent-chip'
        onSearch={onSearch}
    >
        <span className='material-icons history' aria-hidden='true' />
        {historyEntry.SearchTerm}
    </ShortcutButton>
);

const ExploreTileCard = ({
    item,
    kind,
    onSearch
}: {
    item: ExploreItemDto;
    kind: 'genre' | 'collection';
    onSearch: (query: string) => void;
}) => {
    const { __legacyApiClient__ } = useApi();
    const name = getExploreItemName(item);
    const imageSource = item.RepresentativeItem || item.Item || undefined;
    const imageUrl = imageSource ? getSearchItemImageUrl(__legacyApiClient__, imageSource, {
        fillWidth: 420,
        fillHeight: 236
    }) : null;
    const routeUrl = getExploreItemRouteUrl(item, kind, name);
    const className = [
        'genre-tile',
        `genre-tile--${kind}`,
        imageUrl ? 'genre-tile--has-image' : ''
    ].filter(Boolean).join(' ');
    const style = getExploreTileStyle(imageUrl);
    const countLabel = getExploreItemCountLabel(item);
    const onTileSearch = useCallback(() => {
        onSearch(name);
    }, [ name, onSearch ]);

    const content = (
        <>
            <span className='genre-tile__name'>{name}</span>
            {countLabel && <span className='genre-tile__count'>{countLabel}</span>}
        </>
    );

    if (routeUrl) {
        return (
            <Link
                className={className}
                style={style}
                to={routeUrl}
            >
                {content}
            </Link>
        );
    }

    return (
        <button
            type='button'
            className={className}
            style={style}
            onClick={onTileSearch}
        >
            {content}
        </button>
    );
};

const TrendingItemCard = ({ item, rank }: { item: BaseItemDto; rank: number }) => {
    const { __legacyApiClient__ } = useApi();
    const imageUrl = getSearchItemImageUrl(__legacyApiClient__, item, {
        fillWidth: 220,
        fillHeight: 124
    });

    return (
        <Link className='trend-card' to={normalizeRouterUrl(appRouter.getRouteUrl(item))}>
            <span className='trend-card__rank'>{rank}</span>
            <span className='trend-card__thumb'>
                {imageUrl ? (
                    <img src={imageUrl} alt='' loading='lazy' />
                ) : (
                    <span>{getSearchItemInitials(item)}</span>
                )}
            </span>
            <span className='trend-card__content'>
                <span className='trend-card__title'>{item.Name}</span>
                <span className='trend-card__meta'>{getItemMeta(item)}</span>
            </span>
        </Link>
    );
};

const SearchSuggestions: FunctionComponent<SearchSuggestionsProps> = ({ parentId, onSearch }) => {
    const suggestionsQuery = useSearchSuggestions(parentId || undefined);
    const historyQuery = useSearchHistory();
    const genresQuery = useExploreGenres(parentId || undefined);
    const collectionsQuery = useExploreCollections();
    const {
        mutate: clearSearchHistory,
        isPending: isClearingHistory,
        isReady: isClearHistoryReady
    } = useClearSearchHistory();
    const suggestions = suggestionsQuery.data;
    const history = historyQuery.data;
    const genres = genresQuery.data;
    const collections = collectionsQuery.data;
    const discoveryQueries = [ suggestionsQuery, historyQuery, genresQuery, collectionsQuery ];
    const hasDiscoveryError = discoveryQueries.some(query => query.isError);
    const isDiscoveryPending = discoveryQueries.every(query => query.isPending);

    const onClearHistory = useCallback(() => {
        clearSearchHistory();
    }, [ clearSearchHistory ]);

    const onRetry = useCallback(() => {
        Promise.all([
            suggestionsQuery.refetch(),
            historyQuery.refetch(),
            genresQuery.refetch(),
            collectionsQuery.refetch()
        ]).catch(error => console.error('Failed to retry search discovery.', error));
    }, [ collectionsQuery, genresQuery, historyQuery, suggestionsQuery ]);

    if (isDiscoveryPending) {
        return (
            <div className='search-screen__body'>
                <Loading />
            </div>
        );
    }

    const historyEntries = (history || [])
        .filter(entry => entry.SearchTerm)
        .slice(0, 8);
    const genreItems = (genres?.Items || [])
        .filter(item => getExploreItemName(item))
        .slice(0, 12);
    const collectionItems = (collections?.Items || [])
        .filter(item => getExploreItemName(item))
        .slice(0, 12);
    const trendingItems = suggestions?.slice(0, 6) || [];
    const hasDiscoveryData = Boolean(
        historyEntries.length || genreItems.length || collectionItems.length || trendingItems.length
    );

    if (hasDiscoveryError && !hasDiscoveryData) {
        return <SearchDiscoveryError onRetry={onRetry} />;
    }

    return (
        <div className='search-screen__body search-empty-state search-discovery'>
            {hasDiscoveryError && (
                <div className='search-discovery-status' role='status'>
                    <span>{globalize.translate('SearchDiscoveryPartialError')}</span>
                    <button type='button' onClick={onRetry}>{globalize.translate('Retry')}</button>
                </div>
            )}
            {historyEntries.length > 0 && (
                <section className='search-section search-section--recent'>
                    <h2 className='search-section__title'>{globalize.translate('SearchRecentSearches')}</h2>
                    <div className='recent-chip-list' aria-label={globalize.translate('SearchRecentSearches')}>
                        {historyEntries.map(search => (
                            <RecentSearchChip
                                key={`${search.SearchTerm}-${search.LastSearchedUtc}`}
                                historyEntry={search}
                                onSearch={onSearch}
                            />
                        ))}
                        <button
                            type='button'
                            className='recent-history-clear'
                            disabled={isClearingHistory || !isClearHistoryReady}
                            onClick={onClearHistory}
                        >
                            {globalize.translate('SearchClearHistory')}
                        </button>
                    </div>
                </section>
            )}

            {genreItems.length > 0 && (
                <section className='search-section'>
                    <div className='search-section__header'>
                        <h2 className='search-section__title'>{globalize.translate('SearchExploreByGenre')}</h2>
                        <span className='search-section__meta'>{globalize.translate('SearchExploreGenreHint')}</span>
                    </div>
                    <div className='genre-tile-grid genre-tile-grid--browse'>
                        {genreItems.map(genre => (
                            <ExploreTileCard
                                key={genre.Id || getExploreItemName(genre)}
                                item={genre}
                                kind='genre'
                                onSearch={onSearch}
                            />
                        ))}
                    </div>
                </section>
            )}

            {collectionItems.length > 0 && (
                <section className='search-section'>
                    <div className='search-section__header'>
                        <h2 className='search-section__title'>{globalize.translate('SearchExploreByCollection')}</h2>
                        <span className='search-section__meta'>{globalize.translate('SearchExploreCollectionHint')}</span>
                    </div>
                    <div className='genre-tile-grid genre-tile-grid--browse genre-tile-grid--collections'>
                        {collectionItems.map(collection => (
                            <ExploreTileCard
                                key={collection.Id || getExploreItemName(collection)}
                                item={collection}
                                kind='collection'
                                onSearch={onSearch}
                            />
                        ))}
                    </div>
                </section>
            )}

            {trendingItems.length > 0 && (
                <section className='search-section'>
                    <div className='search-section__header'>
                        <h2 className='search-section__title'>{globalize.translate('SearchTrending')}</h2>
                        <span className='search-section__meta'>{globalize.translate('SearchTrendingHint')}</span>
                    </div>
                    <div className='trend-row'>
                        {trendingItems.map((item, index) => (
                            <TrendingItemCard
                                key={item.Id || item.Name}
                                item={item}
                                rank={index + 1}
                            />
                        ))}
                    </div>
                </section>
            )}

            {!historyEntries.length && !genreItems.length && !collectionItems.length && !trendingItems.length && (
                <section className='search-no-results'>
                    <div className='search-no-results__panel'>
                        <h2>{globalize.translate('SearchDiscoveryEmptyTitle')}</h2>
                        <p>{globalize.translate('SearchDiscoveryEmptyBody')}</p>
                    </div>
                </section>
            )}
        </div>
    );
};

const SearchDiscoveryError = ({ onRetry }: { onRetry: () => void }) => (
    <div className='search-screen__body search-no-results' role='alert'>
        <div className='search-no-results__panel'>
            <h2>{globalize.translate('SearchDiscoveryErrorTitle')}</h2>
            <p>{globalize.translate('SearchDiscoveryErrorBody')}</p>
            <button type='button' className='search-action-link' onClick={onRetry}>
                {globalize.translate('Retry')}
            </button>
        </div>
    </div>
);

export default SearchSuggestions;

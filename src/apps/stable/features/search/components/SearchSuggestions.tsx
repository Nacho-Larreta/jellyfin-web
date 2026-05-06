import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import React, {
    FunctionComponent,
    type CSSProperties,
    useCallback
} from 'react';
import { Link } from 'react-router-dom';

import Loading from 'components/loading/LoadingComponent';
import { appRouter } from 'components/router/appRouter';
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
import { getSearchItemImageUrl, getSearchItemInitials } from '../utils/search';

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

    return segments.join(' · ') || 'En tu biblioteca';
};

const getExploreItemName = (item: ExploreItemDto) => item.Name || item.Item?.Name || '';

const getExploreItemCountLabel = (item: ExploreItemDto) => {
    const count = item.ItemCount ?? 0;
    return `${count} ${count === 1 ? 'título' : 'títulos'}`;
};

const getGenreBrowseUrl = (name: string) => `/search?genre=${encodeURIComponent(name)}`;

const getCollectionBrowseUrl = (item: ExploreItemDto, name: string) => (
    item.Id ?
        `/search?parentId=${encodeURIComponent(item.Id)}&collectionName=${encodeURIComponent(name)}` :
        undefined
);

const getExploreItemRouteUrl = (
    item: ExploreItemDto,
    kind: 'genre' | 'collection',
    name: string
) => {
    if (kind === 'genre') {
        return getGenreBrowseUrl(name);
    }

    return item.Item ? appRouter.getRouteUrl(item.Item) : getCollectionBrowseUrl(item, name);
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

    const content = (
        <>
            <span className='genre-tile__name'>{name}</span>
            <span className='genre-tile__count'>{getExploreItemCountLabel(item)}</span>
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
            onClick={() => onSearch(name)}
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
        <Link className='trend-card' to={appRouter.getRouteUrl(item)}>
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
    const { data: suggestions, isPending: suggestionsPending } = useSearchSuggestions(parentId || undefined);
    const { data: history, isPending: historyPending } = useSearchHistory();
    const { data: genres, isPending: genresPending } = useExploreGenres(parentId || undefined);
    const { data: collections, isPending: collectionsPending } = useExploreCollections();
    const {
        mutate: clearSearchHistory,
        isPending: isClearingHistory
    } = useClearSearchHistory();

    const onClearHistory = useCallback(() => {
        clearSearchHistory();
    }, [ clearSearchHistory ]);

    if (suggestionsPending && historyPending && genresPending && collectionsPending) {
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

    return (
        <div className='search-screen__body search-empty-state search-discovery'>
            {historyEntries.length > 0 && (
                <section className='search-section search-section--recent'>
                    <h2 className='search-section__title'>Búsquedas recientes</h2>
                    <div className='recent-chip-list' aria-label='Búsquedas recientes'>
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
                            disabled={isClearingHistory}
                            onClick={onClearHistory}
                        >
                            Borrar historial
                        </button>
                    </div>
                </section>
            )}

            {genreItems.length > 0 && (
                <section className='search-section'>
                    <div className='search-section__header'>
                        <h2 className='search-section__title'>Explorar por género</h2>
                        <span className='search-section__meta'>Tocá uno para ver todo el contenido</span>
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
                        <h2 className='search-section__title'>Explorar por colección</h2>
                        <span className='search-section__meta'>Sagas y grupos curados de tu servidor</span>
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
                        <h2 className='search-section__title'>Lo más buscado</h2>
                        <span className='search-section__meta'>En tu servidor esta semana</span>
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
                        <h2>Tu biblioteca todavía no tiene datos para explorar</h2>
                        <p>Agregá contenido o empezá a buscar para crear historial por perfil.</p>
                    </div>
                </section>
            )}
        </div>
    );
};

export default SearchSuggestions;

import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import React, { type FC, useCallback, useEffect, useState } from 'react';
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

interface SearchResultsProps {
    parentId?: string;
    collectionType?: CollectionType;
    query?: string;
}

/*
 * React component to display search result rows for global search and library view search
 */
const SearchResults: FC<SearchResultsProps> = ({
    parentId,
    collectionType,
    query
}) => {
    const { data, isPending } = useSearchItems(parentId, collectionType, query?.trim());
    const [activeFilter, setActiveFilter] = useState('all');

    useEffect(() => {
        if (activeFilter !== 'all' && data && !data.some(section => section.title === activeFilter)) {
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

    if (!data?.length) {
        return (
            <div className='search-screen__body search-no-results'>
                <div className='search-no-results__panel'>
                    <p className='search-eyebrow'>{globalize.translate('Search')}</p>
                    <h2>{globalize.translate('SearchResultsEmpty', query)}</h2>
                    <p>Probá con un título más corto, una persona o alguno de los atajos de género.</p>
                </div>
                {collectionType && (
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
        data :
        data.filter(section => section.title === activeFilter);
    const resultCount = activeSections.reduce((total, section) => total + section.items.length, 0);
    const topResult = data[0]?.items[0];

    return (
        <div className='search-screen__body search-results'>
            <div className='filter-pill-list' aria-label='Filtros de búsqueda'>
                <FilterPill
                    id='all'
                    label='Todo'
                    count={data.reduce((total, section) => total + section.items.length, 0)}
                    isActive={activeFilter === 'all'}
                    onSelect={setActiveFilter}
                />
                {data.map(section => (
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
                <TopResult item={topResult} query={query} />
            )}

            <section className='search-section'>
                <div className='search-section__header'>
                    <h2 className='search-section__title'>
                        {activeFilter === 'all' ? 'Resultados' : globalize.translate(activeFilter)}
                    </h2>
                    <span className='search-section__meta'>{resultCount} elementos</span>
                </div>
                {activeSections.map(section => (
                    <SearchResultSection key={section.title} section={section} />
                ))}
            </section>
        </div>
    );
};

const FilterPill = ({
    id,
    label,
    count,
    isActive,
    onSelect
}: {
    id: string;
    label: string;
    count: number;
    isActive: boolean;
    onSelect: (id: string) => void;
}) => {
    const onClick = useCallback(() => {
        onSelect(id);
    }, [ id, onSelect ]);

    return (
        <button
            type='button'
            className={`filter-pill${isActive ? ' filter-pill--active' : ''}`}
            onClick={onClick}
        >
            <span>{label}</span>
            <span className='filter-pill__count'>{count}</span>
        </button>
    );
};

const TopResult = ({ item, query }: { item: BaseItemDto; query?: string }) => {
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
        <Link className='top-result' to={appRouter.getRouteUrl(item)}>
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
                <span className='search-eyebrow'>Mejor resultado para &quot;{query}&quot;</span>
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
        <Link className='result-card' to={appRouter.getRouteUrl(item)}>
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

import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import React, { FunctionComponent, useCallback } from 'react';
import { Link } from 'react-router-dom';

import Loading from 'components/loading/LoadingComponent';
import { appRouter } from 'components/router/appRouter';
import { useSearchSuggestions } from '../api/useSearchSuggestions';
import globalize from 'lib/globalize';
import { useApi } from 'hooks/useApi';
import { getSearchItemImageUrl, getSearchItemInitials } from '../utils/search';

const QUICK_SEARCHES = [
    'Acción',
    'Drama',
    'Comedia',
    'Documental',
    'Familia',
    'Ciencia ficción'
];

const GENRE_TILES = [
    { name: 'Acción', tone: 'red' },
    { name: 'Animación', tone: 'purple' },
    { name: 'Comedia', tone: 'green' },
    { name: 'Drama', tone: 'blue' },
    { name: 'Documental', tone: 'orange' },
    { name: 'Suspenso', tone: 'slate' }
];

type SearchShortcutProps = {
    name: string;
    onSearch: (query: string) => void;
};

type GenreTileProps = SearchShortcutProps & {
    tone: string;
};

type SearchSuggestionsProps = {
    parentId?: string | null;
    onSearch: (query: string) => void;
};

const SuggestionCard = ({ item }: { item: BaseItemDto }) => {
    const { __legacyApiClient__ } = useApi();
    const imageUrl = getSearchItemImageUrl(__legacyApiClient__, item, {
        fillWidth: 320,
        fillHeight: 480
    });

    return (
        <Link className='result-card result-card--poster' to={appRouter.getRouteUrl(item)}>
            <span className='result-card__image'>
                {imageUrl ? (
                    <img src={imageUrl} alt='' loading='lazy' />
                ) : (
                    <span className='result-card__fallback'>{getSearchItemInitials(item)}</span>
                )}
                <span className='result-card__play' aria-hidden='true'>▶</span>
            </span>
            <span className='result-card__title'>{item.Name}</span>
        </Link>
    );
};

const SearchShortcut = ({ name, onSearch }: SearchShortcutProps) => {
    const onClick = useCallback(() => {
        onSearch(name);
    }, [ name, onSearch ]);

    return (
        <button
            type='button'
            className='search-chip'
            onClick={onClick}
        >
            {name}
        </button>
    );
};

const GenreTile = ({ name, tone, onSearch }: GenreTileProps) => {
    const onClick = useCallback(() => {
        onSearch(name);
    }, [ name, onSearch ]);

    return (
        <button
            type='button'
            className={`genre-tile genre-tile--${tone}`}
            onClick={onClick}
        >
            <span className='genre-tile__name'>{name}</span>
            <span className='genre-tile__hint'>Explorar</span>
        </button>
    );
};

const SearchSuggestions: FunctionComponent<SearchSuggestionsProps> = ({ parentId, onSearch }) => {
    const { data: suggestions, isPending } = useSearchSuggestions(parentId || undefined);

    if (isPending) {
        return (
            <div className='search-screen__body'>
                <Loading />
            </div>
        );
    }

    return (
        <div className='search-screen__body search-empty-state'>
            <section className='search-section search-empty-state__intro'>
                <p className='search-eyebrow'>{globalize.translate('Search')}</p>
                <h1 className='search-empty-state__title'>Encontrá algo para ver</h1>
                <p className='search-empty-state__copy'>
                    Buscá títulos, personas, colecciones, canciones, episodios o arrancá con un atajo.
                </p>
                <div className='search-chip-list' aria-label='Búsquedas rápidas'>
                    {QUICK_SEARCHES.map(search => (
                        <SearchShortcut
                            key={search}
                            name={search}
                            onSearch={onSearch}
                        />
                    ))}
                </div>
            </section>

            <section className='search-section'>
                <div className='search-section__header'>
                    <h2 className='search-section__title'>Explorar por género</h2>
                </div>
                <div className='genre-tile-grid'>
                    {GENRE_TILES.map(genre => (
                        <GenreTile
                            key={genre.name}
                            name={genre.name}
                            tone={genre.tone}
                            onSearch={onSearch}
                        />
                    ))}
                </div>
            </section>

            {!!suggestions?.length && (
                <section className='search-section'>
                    <div className='search-section__header'>
                        <h2 className='search-section__title'>{globalize.translate('Suggestions')}</h2>
                        <span className='search-section__meta'>Tendencias de tu biblioteca</span>
                    </div>
                    <div className='search-results-grid search-results-grid--suggestions'>
                        {suggestions.slice(0, 10).map(item => (
                            <SuggestionCard key={item.Id} item={item} />
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
};

export default SearchSuggestions;

import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import enUs from '../../../../../strings/en-us.json';

vi.mock('../api/useSearchItems', () => ({ useSearchItems: vi.fn() }));
vi.mock('components/loading/LoadingComponent', () => ({ default: () => null }));
vi.mock('components/router/appRouter', () => ({
    appRouter: { getRouteUrl: () => '/item' }
}));
vi.mock('hooks/useApi', () => ({ useApi: () => ({}) }));
vi.mock('lib/globalize', () => ({
    default: { translate: (key: string) => key }
}));
vi.mock('utils/jellyfin-apiclient/backdropImage', () => ({
    getItemBackdropImageUrl: () => undefined
}));
vi.mock('../utils/search', () => ({
    getSearchItemImageUrl: () => undefined,
    getSearchItemInitials: () => '',
    getSearchItemSubtitle: () => '',
    getSearchItemTypeLabel: () => ''
}));
vi.mock('../utils/searchRoutes', () => ({
    normalizeRouterUrl: (url: string) => url
}));

describe('Search and Genre filter semantics', () => {
    it('builds the Genre all-filter label from the en-US locale owner', async () => {
        const { createGenreTypeFilters } = await import('./SearchResults');
        const translate = (key: string) => enUs[key as keyof typeof enUs] || key;

        expect(createGenreTypeFilters([
            {
                title: 'Movies',
                items: [{ Id: 'movie' }]
            }
        ], translate)[0]).toEqual({
            id: 'all',
            label: 'All',
            count: 1
        });
    });

    it('exposes pressed state through native buttons', async () => {
        const { FilterPill, GenreFilterButton, GenreSortButton } = await import('./SearchFilterControls');
        const onSelect = vi.fn();
        const filterHtml = renderToStaticMarkup(
            <FilterPill id='all' label='All' count={4} isActive onSelect={onSelect} />
        );
        const genreHtml = renderToStaticMarkup(
            <GenreFilterButton id='Movies' label='Movies' count={2} isActive={false} onSelect={onSelect} />
        );
        const sortHtml = renderToStaticMarkup(
            <GenreSortButton id='recent' label='Recent' activeSort='recent' onSelect={onSelect} />
        );

        expect(filterHtml).toContain('<button');
        expect(filterHtml).toContain('aria-pressed="true"');
        expect(genreHtml).toContain('aria-pressed="false"');
        expect(sortHtml).toContain('aria-pressed="true"');
    });
});

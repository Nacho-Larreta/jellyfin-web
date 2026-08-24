import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { describe, expect, it } from 'vitest';

import { buildSearchResultData } from './searchResultData';

describe('search result ranking', () => {
    it('preserves the first item from the server ranking as the top result', () => {
        const rankedItems = [
            { Id: 'series-first', Type: BaseItemKind.Series, Name: 'Series first' },
            { Id: 'movie-second', Type: BaseItemKind.Movie, Name: 'Movie second' }
        ];

        const result = buildSearchResultData([], [ BaseItemKind.Movie, BaseItemKind.Series ], rankedItems);

        expect(result.sections.map(section => section.title)).toEqual([ 'Movies', 'Shows' ]);
        expect(result.topResult?.Id).toBe('series-first');
    });
});

import type { BaseItemDto, ParentalRating } from '@jellyfin/sdk/lib/generated-client/models';
import { describe, expect, it } from 'vitest';

import {
    SCREENSAVER_AGE_CEILINGS,
    ScreensaverContentPolicy,
    normalizeScreensaverAgeCeiling
} from './ScreensaverContentPolicy';

const catalog: ParentalRating[] = [
    { Name: 'G', RatingScore: { score: 0 } },
    { Name: 'PG', RatingScore: { score: 10 } },
    { Name: 'PG-13', RatingScore: { score: 13 } },
    { Name: 'Adult', RatingScore: { score: 1000 } },
    { Name: 'Unrated', RatingScore: undefined }
];

function item(overrides: Partial<BaseItemDto> = {}): BaseItemDto {
    return {
        Type: 'Movie',
        OfficialRating: 'G',
        BackdropImageTags: [ 'backdrop' ],
        ...overrides
    };
}

describe('ScreensaverContentPolicy preferences', () => {
    it.each(SCREENSAVER_AGE_CEILINGS)('preserves supported persisted ceiling %s', ageCeiling => {
        expect(normalizeScreensaverAgeCeiling(ageCeiling)).toBe(ageCeiling);
        expect(normalizeScreensaverAgeCeiling(ageCeiling.toString())).toBe(ageCeiling);
    });

    it.each([
        undefined,
        null,
        '',
        ' 5 ',
        '05',
        '5.0',
        '13.5',
        13.5,
        -2,
        '-2',
        4,
        '4',
        Number.NaN,
        Number.POSITIVE_INFINITY,
        {}
    ])('fails closed for invalid persisted value %s', value => {
        expect(normalizeScreensaverAgeCeiling(value)).toBe(0);
    });
});

describe('ScreensaverContentPolicy query', () => {
    it('builds the exact bounded Movie and Series query', () => {
        expect(new ScreensaverContentPolicy(13).buildQuery()).toEqual({
            ImageTypes: 'Backdrop',
            EnableImageTypes: 'Backdrop',
            IncludeItemTypes: 'Movie,Series',
            SortBy: 'Random',
            Recursive: true,
            Fields: 'Taglines,CustomRating',
            ImageTypeLimit: 10,
            HasParentalRating: true,
            MaxOfficialRating: 13,
            StartIndex: 0,
            Limit: 200
        });
    });

    it('omits only the maximum rating for explicit unlimited', () => {
        expect(new ScreensaverContentPolicy(-1).buildQuery()).toEqual({
            ImageTypes: 'Backdrop',
            EnableImageTypes: 'Backdrop',
            IncludeItemTypes: 'Movie,Series',
            SortBy: 'Random',
            Recursive: true,
            Fields: 'Taglines,CustomRating',
            ImageTypeLimit: 10,
            HasParentalRating: true,
            StartIndex: 0,
            Limit: 200
        });
    });
});

describe('ScreensaverContentPolicy result boundary', () => {
    it.each(SCREENSAVER_AGE_CEILINGS.filter(age => age >= 0))(
        'accepts the exact %s boundary and rejects one age above',
        ageCeiling => {
            const policy = new ScreensaverContentPolicy(ageCeiling);
            const eligible = policy.filterEligibleItems([
                item({ Id: 'boundary', OfficialRating: ageCeiling.toString() }),
                item({ Id: 'above', OfficialRating: (ageCeiling + 1).toString() })
            ], catalog);

            expect(eligible.map(candidate => candidate.Id)).toEqual([ 'boundary' ]);
        }
    );

    it('defaults missing preferences to general audiences', () => {
        const eligible = new ScreensaverContentPolicy(undefined).filterEligibleItems([
            item({ Id: 'general', OfficialRating: 'G' }),
            item({ Id: 'older', OfficialRating: '5' })
        ], catalog);

        expect(eligible.map(candidate => candidate.Id)).toEqual([ 'general' ]);
    });

    it('requires a resolvable rating even when unlimited is explicit', () => {
        const eligible = new ScreensaverContentPolicy(-1).filterEligibleItems([
            item({ Id: 'catalog-adult', OfficialRating: 'Adult' }),
            item({ Id: 'numeric', OfficialRating: '21' }),
            item({ Id: 'missing', OfficialRating: undefined }),
            item({ Id: 'unrated', OfficialRating: 'Unrated' }),
            item({ Id: 'unknown', OfficialRating: 'Not-In-Catalog' }),
            item({ Id: 'negative', OfficialRating: '-1' }),
            item({ Id: 'fractional', OfficialRating: '13.5' }),
            item({ Id: 'out-of-range', OfficialRating: '22' })
        ], catalog);

        expect(eligible.map(candidate => candidate.Id)).toEqual([ 'catalog-adult', 'numeric' ]);
    });

    it('uses a non-blank custom rating before the official rating', () => {
        const policy = new ScreensaverContentPolicy(0);
        const eligible = policy.filterEligibleItems([
            item({ Id: 'custom-wins-reject', CustomRating: 'PG-13', OfficialRating: 'G' }),
            item({ Id: 'custom-wins-accept', CustomRating: 'G', OfficialRating: 'PG-13' }),
            item({ Id: 'blank-custom', CustomRating: '  ', OfficialRating: 'G' }),
            item({ Id: 'unknown-custom', CustomRating: 'Unknown', OfficialRating: 'G' })
        ], catalog);

        expect(eligible.map(candidate => candidate.Id)).toEqual([ 'custom-wins-accept', 'blank-custom' ]);
    });

    it('rejects wrong types and items without usable backdrop art', () => {
        const eligible = new ScreensaverContentPolicy(0).filterEligibleItems([
            item({ Id: 'series', Type: 'Series' }),
            item({ Id: 'artist', Type: 'MusicArtist' }),
            item({ Id: 'missing-image', BackdropImageTags: undefined }),
            item({ Id: 'empty-image', BackdropImageTags: [] })
        ], catalog);

        expect(eligible.map(candidate => candidate.Id)).toEqual([ 'series' ]);
    });

    it('fails closed when the parental rating catalog is unavailable', () => {
        expect(new ScreensaverContentPolicy(0).filterEligibleItems([
            item({ OfficialRating: 'G' }),
            item({ OfficialRating: '0' })
        ], [])).toEqual([]);
    });
});

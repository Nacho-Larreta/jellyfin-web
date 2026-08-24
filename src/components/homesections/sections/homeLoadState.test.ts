import { describe, expect, it } from 'vitest';

import { aggregateHomeSectionResults, getHomeLoadState } from './homeLoadState';

describe('TV Home load state', () => {
    it('aggregates successful sections without a failure signal', () => {
        const aggregation = aggregateHomeSectionResults([
            { status: 'fulfilled', value: [ 'first' ] },
            { status: 'fulfilled', value: [ 'second' ] }
        ]);

        expect(aggregation).toEqual({
            items: [ 'first', 'second' ],
            status: 'fulfilled'
        });
        expect(getHomeLoadState(false, [ 'fulfilled', 'fulfilled', aggregation.status ], true)).toBe('ready');
    });

    it('keeps useful rows while preserving a mixed rejection signal', () => {
        const aggregation = aggregateHomeSectionResults([
            { status: 'fulfilled', value: [ 'available' ] },
            { status: 'rejected', reason: new Error('Unavailable library') }
        ]);

        expect(aggregation).toEqual({
            items: [ 'available' ],
            status: 'rejected'
        });
        expect(getHomeLoadState(true, [ 'fulfilled', 'fulfilled', aggregation.status ], true)).toBe('partial');
    });

    it('preserves an all-failed rejection signal with no fabricated rows', () => {
        const aggregation = aggregateHomeSectionResults([
            { status: 'rejected', reason: new Error('First unavailable library') },
            { status: 'rejected', reason: new Error('Second unavailable library') }
        ]);

        expect(aggregation).toEqual({
            items: [],
            status: 'rejected'
        });
        expect(getHomeLoadState(false, [ 'rejected', 'rejected', aggregation.status ], false)).toBe('error');
    });

    it('distinguishes empty, partial and error states from usable content', () => {
        expect(getHomeLoadState(false, [ 'fulfilled', 'fulfilled', 'fulfilled' ], false)).toBe('empty');
        expect(getHomeLoadState(true, [ 'fulfilled', 'rejected', 'fulfilled' ], true)).toBe('partial');
        expect(getHomeLoadState(false, [ 'rejected', 'rejected', 'rejected' ], false)).toBe('error');
        expect(getHomeLoadState(true, [ 'fulfilled', 'fulfilled', 'fulfilled' ], true)).toBe('ready');
    });
});

import { describe, expect, it } from 'vitest';

import { getCollectionBrowseUrl, getGenreBrowseUrl, normalizeRouterUrl } from './searchRoutes';

describe('search browse routes', () => {
    it('encodes browse parameters without introducing hash duplication', () => {
        expect(getGenreBrowseUrl('Science Fiction')).toBe('/search?genre=Science%20Fiction');
        expect(getCollectionBrowseUrl('box/set', 'Saga & More')).toBe('/search?parentId=box%2Fset&collectionName=Saga%20%26%20More');
        expect(normalizeRouterUrl('#/details?id=1')).toBe('/details?id=1');
        expect(normalizeRouterUrl('/details?id=1')).toBe('/details?id=1');
    });
});

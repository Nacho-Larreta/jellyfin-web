import { describe, expect, it, vi } from 'vitest';

import {
    clearSearchHistory,
    fetchExploreCollections,
    fetchExploreGenres,
    fetchSearchHistory,
    recordSearchHistory,
    requireSearchMutationContext,
    toStandardExploreItem,
    type SearchDiscoveryFallback,
    type SearchProfileContext
} from './searchDiscoveryApi';

const context: SearchProfileContext = {
    ownerUserId: 'owner',
    profileUserId: 'profile',
    userId: 'profile',
    serverId: 'server'
};

const responseError = (status: number) => ({ status });

const createApiClient = () => ({
    getJSON: vi.fn(),
    ajax: vi.fn(),
    getUrl: vi.fn((path: string) => path)
});

const createFallback = (): SearchDiscoveryFallback => ({
    fetchGenres: vi.fn(),
    fetchCollections: vi.fn()
});

describe('search discovery compatibility', () => {
    it('preserves trustworthy standard genre counts and omits unknown counts', () => {
        expect(toStandardExploreItem({
            Id: 'animation',
            Name: 'Animation',
            RecursiveItemCount: 3
        })).toMatchObject({
            Id: 'animation',
            Name: 'Animation',
            ItemCount: 3
        });

        expect(toStandardExploreItem({
            Id: 'unknown',
            Name: 'Unknown'
        })).not.toHaveProperty('ItemCount');
    });

    it('treats a nullable SDK count as unknown without discarding numeric zero', () => {
        expect(toStandardExploreItem({
            Id: 'unknown',
            Name: 'Unknown',
            ChildCount: null
        })).not.toHaveProperty('ItemCount');

        expect(toStandardExploreItem({
            Id: 'empty',
            Name: 'Empty',
            ChildCount: 0
        })).toHaveProperty('ItemCount', 0);
    });

    it('treats a missing history capability as an empty no-op capability', async () => {
        const apiClient = createApiClient();
        apiClient.getJSON.mockRejectedValue(responseError(404));
        apiClient.ajax.mockRejectedValue(responseError(404));

        await expect(fetchSearchHistory(apiClient, context)).resolves.toEqual([]);
        await expect(recordSearchHistory(apiClient, context, 'Arrival')).resolves.toBeUndefined();
        await expect(clearSearchHistory(apiClient, context)).resolves.toBeUndefined();
    });

    it('falls back to standard Genres and BoxSet queries only for a missing endpoint', async () => {
        const apiClient = createApiClient();
        const fallback = createFallback();
        const genres = { Items: [{ Name: 'Drama' }] };
        const collections = { Items: [{ Name: 'Saga' }] };
        apiClient.getJSON.mockRejectedValue(responseError(404));
        vi.mocked(fallback.fetchGenres).mockResolvedValue(genres);
        vi.mocked(fallback.fetchCollections).mockResolvedValue(collections);

        await expect(fetchExploreGenres(apiClient, context, fallback, 'library')).resolves.toEqual(genres);
        await expect(fetchExploreCollections(apiClient, context, fallback)).resolves.toEqual(collections);
        expect(fallback.fetchGenres).toHaveBeenCalledWith(context, 'library');
        expect(fallback.fetchCollections).toHaveBeenCalledWith(context);
    });

    it('keeps server failures visible instead of converting them into empty data', async () => {
        const apiClient = createApiClient();
        const fallback = createFallback();
        const error = responseError(503);
        apiClient.getJSON.mockRejectedValue(error);

        await expect(fetchSearchHistory(apiClient, context)).rejects.toBe(error);
        await expect(fetchExploreGenres(apiClient, context, fallback)).rejects.toBe(error);
        await expect(fetchExploreCollections(apiClient, context, fallback)).rejects.toBe(error);
        expect(fallback.fetchGenres).not.toHaveBeenCalled();
        expect(fallback.fetchCollections).not.toHaveBeenCalled();
    });

    it('blocks profile-scoped mutations until the API and profile context are ready', () => {
        expect(() => requireSearchMutationContext()).toThrowError();
        expect(() => requireSearchMutationContext(createApiClient())).toThrowError();
        expect(requireSearchMutationContext(createApiClient(), context).context).toBe(context);
    });
});

import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { describe, expect, it, vi } from 'vitest';

import type { SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { readFavoriteSection } from './favoriteSectionRead';

function read(): SessionScopedReadApi {
    const result = { Items: [
        { Id: '5dae694ba968f2676a64ceb6934f667b', ServerId: 'server-a' },
        { Id: '11111111111111111111111111111111', ServerId: 'server-b' }
    ] };
    return {
        identity: { serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: 1, authorityGeneration: 'revision-a' },
        assertCurrent: vi.fn(),
        getItems: vi.fn(async () => result),
        getArtists: vi.fn(async () => result),
        getPersons: vi.fn(async () => result)
    } as unknown as SessionScopedReadApi;
}

describe('Favorites section queries', () => {
    it('binds every regular type to the captured user and keeps the favorite query contract', async () => {
        const session = read();
        const signal = new window['AbortController']().signal;
        const types = [BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.Season,
            BaseItemKind.Episode, BaseItemKind.Video, BaseItemKind.MusicVideo,
            BaseItemKind.BoxSet, BaseItemKind.Playlist, BaseItemKind.MusicAlbum,
            BaseItemKind.Audio, BaseItemKind.Book, BaseItemKind.LiveTvChannel,
            BaseItemKind.PhotoAlbum, BaseItemKind.Photo];
        for (const type of types) {
            expect(await readFavoriteSection(session, type, signal)).toHaveLength(1);
        }
        expect(session.getItems).toHaveBeenCalledTimes(14);
        for (const [params, calledSignal] of vi.mocked(session.getItems).mock.calls) {
            expect(params).toMatchObject({
                userId: 'user-a', limit: 20, recursive: true,
                filters: ['IsFavorite'], isFavorite: true,
                sortBy: ['SeriesSortName', 'SortName'], sortOrder: ['Ascending'],
                includeItemTypes: [expect.any(String)], collapseBoxSetItems: false,
                excludeLocationTypes: ['Virtual'], enableTotalRecordCount: false
            });
            expect(calledSignal).toBe(signal);
        }
    });

    it('routes artist and person through their bounded endpoints', async () => {
        const session = read();
        const signal = new window['AbortController']().signal;
        await readFavoriteSection(session, BaseItemKind.MusicArtist, signal);
        await readFavoriteSection(session, BaseItemKind.Person, signal);
        expect(session.getArtists).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a', isFavorite: true, limit: 20 }), signal);
        expect(session.getPersons).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a', isFavorite: true, limit: 20 }), signal);
        expect(session.getItems).not.toHaveBeenCalled();
    });
});

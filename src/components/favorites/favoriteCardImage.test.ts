import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { describe, expect, it } from 'vitest';

import { getFavoriteCardImage } from './favoriteCardImage';

const id = '5dae694ba968f2676a64ceb6934f667b';
const parentId = '11111111111111111111111111111111';

describe('Favorites bound image selection', () => {
    it('preserves thumb, episode parent backdrop, primary, series, parent and album precedence', () => {
        const thumb = { Id: id, ImageTags: { Thumb: 'thumb', Primary: 'primary' } } as BaseItemDto;
        expect(getFavoriteCardImage(thumb, 'overflowBackdrop', { preferThumb: true }).descriptor)
            .toMatchObject({ itemId: id, type: ImageType.Thumb, tag: 'thumb' });
        const episode = {
            Id: id, Type: 'Episode', ChildCount: 0,
            ParentBackdropItemId: parentId, ParentBackdropImageTags: ['backdrop'],
            ImageTags: { Primary: 'episode-primary' }
        } as BaseItemDto;
        expect(getFavoriteCardImage(episode, 'overflowBackdrop', { preferThumb: true }).descriptor)
            .toMatchObject({ itemId: parentId, type: ImageType.Backdrop, tag: 'backdrop' });
        expect(getFavoriteCardImage(thumb, 'overflowPortrait', {}).descriptor)
            .toMatchObject({ itemId: id, type: ImageType.Primary, tag: 'primary' });
        expect(getFavoriteCardImage({ SeriesId: parentId, SeriesPrimaryImageTag: 'series' } as BaseItemDto,
            'overflowPortrait', {}).descriptor?.itemId).toBe(parentId);
        expect(getFavoriteCardImage({ ParentPrimaryImageItemId: parentId, ParentPrimaryImageTag: 'parent' } as BaseItemDto,
            'overflowPortrait', {}).descriptor?.tag).toBe('parent');
        expect(getFavoriteCardImage({ AlbumId: parentId, AlbumPrimaryImageTag: 'album' } as BaseItemDto,
            'overflowSquare', {}).descriptor?.tag).toBe('album');
    });

    it('does not create remote slots for missing tags or invalid item ids', () => {
        expect(getFavoriteCardImage({ Id: id } as BaseItemDto, 'overflowPortrait', {}).descriptor).toBeUndefined();
        expect(getFavoriteCardImage({ Id: 'not-an-id', ImageTags: { Primary: 'tag' } } as BaseItemDto,
            'overflowPortrait', {}).descriptor).toBeUndefined();
    });
});

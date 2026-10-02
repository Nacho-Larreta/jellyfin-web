import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import type { HomeImageDescriptor } from 'utils/jellyfin-apiclient/sessionImageRead';

interface FavoriteImageOptions {
    readonly preferThumb?: boolean;
    readonly showTitle?: boolean;
}

interface ProgramAwareItem extends BaseItemDto {
    readonly ProgramInfo?: BaseItemDto;
    readonly PrimaryImageItemId?: string;
    readonly PrimaryImageTag?: string;
}

interface FavoriteImagePresentation {
    readonly descriptor?: HomeImageDescriptor;
    readonly forceName: boolean;
    readonly coverImage: boolean;
}

const VALID_ITEM_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

export function getFavoriteCardImage(
    item: BaseItemDto,
    shape: string,
    options: FavoriteImageOptions
): FavoriteImagePresentation {
    const media: ProgramAwareItem = (item as ProgramAwareItem).ProgramInfo || item;
    const wide = shape.toLowerCase().includes('backdrop');
    let dimensions = { fillWidth: 400, fillHeight: 600, quality: 84 };
    if (wide) dimensions = { fillWidth: 640, fillHeight: 360, quality: 84 };
    else if (shape.toLowerCase().includes('square')) dimensions = { fillWidth: 400, fillHeight: 400, quality: 84 };
    const primary = media.ImageTags?.Primary;
    const thumb = media.ImageTags?.Thumb;
    const backdrop = media.BackdropImageTags?.[0];
    const parentBackdrop = media.ParentBackdropImageTags?.[0];
    const candidates: Array<[string | null | undefined, HomeImageDescriptor['type'], string | null | undefined, boolean]> = [];

    if (options.preferThumb) {
        candidates.push(
            [media.Id, ImageType.Thumb, thumb, false],
            [media.SeriesId, ImageType.Thumb, media.SeriesThumbImageTag, false],
            [media.ParentThumbItemId, ImageType.Thumb, media.ParentThumbImageTag, false],
            [media.Id, ImageType.Backdrop, backdrop, true]
        );
        if (media.Type === 'Episode') {
            candidates.push([media.ParentBackdropItemId, ImageType.Backdrop, parentBackdrop, false]);
        }
    }

    if (media.Type !== 'Episode' || media.ChildCount !== 0) {
        candidates.push([media.Id, ImageType.Primary, primary, Boolean(options.preferThumb && options.showTitle)]);
    }
    candidates.push(
        [media.SeriesId, ImageType.Primary, media.SeriesPrimaryImageTag, false],
        [media.PrimaryImageItemId, ImageType.Primary, media.PrimaryImageTag, Boolean(options.preferThumb && options.showTitle)],
        [media.ParentPrimaryImageItemId, ImageType.Primary, media.ParentPrimaryImageTag, false],
        [media.AlbumId, ImageType.Primary, media.AlbumPrimaryImageTag, false]
    );
    if (media.Type === 'Season') candidates.push([media.Id, ImageType.Thumb, thumb, false]);
    candidates.push(
        [media.Id, ImageType.Backdrop, backdrop, false],
        [media.Id, ImageType.Thumb, thumb, false],
        [media.SeriesId, ImageType.Thumb, media.SeriesThumbImageTag, false],
        [media.ParentThumbItemId, ImageType.Thumb, media.ParentThumbImageTag, false],
        [media.ParentBackdropItemId, ImageType.Backdrop, parentBackdrop, false]
    );

    const selected = candidates.find(([id, , tag]) => id && VALID_ITEM_ID.test(id) && tag);
    if (!selected) return { forceName: false, coverImage: false };
    const [itemId, type, tag, forceName] = selected;
    const expectedRatio = wide ? 16 / 9 : dimensions.fillWidth / dimensions.fillHeight;
    const ratio = media.PrimaryImageAspectRatio;
    return {
        descriptor: { itemId: itemId!, type, tag: tag!, ...dimensions },
        forceName,
        coverImage: type === ImageType.Primary && typeof ratio === 'number'
            && Math.abs(ratio - expectedRatio) / expectedRatio <= 0.2
    };
}

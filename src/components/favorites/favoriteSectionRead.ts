import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { ItemFilter } from '@jellyfin/sdk/lib/generated-client/models/item-filter';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { LocationType } from '@jellyfin/sdk/lib/generated-client/models/location-type';
import { SortOrder } from '@jellyfin/sdk/lib/generated-client/models/sort-order';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import type { SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';

const FAVORITE_LIMIT = 20;
const FAVORITE_SORT = [ItemSortBy.SeriesSortName, ItemSortBy.SortName];
const FAVORITE_FIELDS = [ItemFields.PrimaryImageAspectRatio];
const FAVORITE_FILTER = [ItemFilter.IsFavorite];
const VALID_ITEM_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

export async function readFavoriteSection(
    read: SessionScopedReadApi,
    type: BaseItemKind,
    signal: AbortSignal
): Promise<BaseItemDto[]> {
    const common = {
        userId: read.identity.profileUserId,
        limit: FAVORITE_LIMIT,
        fields: FAVORITE_FIELDS,
        filters: FAVORITE_FILTER,
        isFavorite: true
    };
    let result;
    if (type === BaseItemKind.MusicArtist) {
        result = await read.getArtists({ ...common, sortBy: FAVORITE_SORT, sortOrder: [SortOrder.Ascending], enableTotalRecordCount: false }, signal);
    } else if (type === BaseItemKind.Person) {
        result = await read.getPersons(common, signal);
    } else {
        result = await read.getItems({
            ...common,
            includeItemTypes: [type],
            sortBy: FAVORITE_SORT,
            sortOrder: [SortOrder.Ascending],
            recursive: true,
            collapseBoxSetItems: false,
            excludeLocationTypes: [LocationType.Virtual],
            enableTotalRecordCount: false
        }, signal);
    }

    read.assertCurrent();
    if (!Array.isArray(result?.Items)) return [];
    return result.Items.slice(0, FAVORITE_LIMIT)
        .filter(item => item && typeof item.Id === 'string' && VALID_ITEM_ID.test(item.Id)
            && (!item.ServerId || item.ServerId === read.identity.serverId));
}

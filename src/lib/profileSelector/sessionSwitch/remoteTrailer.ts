import type { ApiClient, WebSocketDeliveryContext } from 'jellyfin-apiclient';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client';

import type { BoundSessionReadPort } from './boundRequests';
import { createSessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';

interface TrailerRead {
    getItems(params: { userId: string; ids: string[]; limit: number }): Promise<{
        Items?: BaseItemDto[] | null;
        TotalRecordCount?: number;
    }>;
}

type CaptureRead = (client: ApiClient) => BoundSessionReadPort | null;
type CreateRead = (client: ApiClient, port: BoundSessionReadPort) => TrailerRead;

const createBoundRead: CreateRead = (client, port) => createSessionScopedReadApi(client, port);

export async function playBoundTrailer(
    client: ApiClient,
    itemId: string,
    delivery: WebSocketDeliveryContext,
    captureRead: CaptureRead,
    play: (item: BaseItemDto) => void,
    createRead: CreateRead = createBoundRead
): Promise<void> {
    if (typeof itemId !== 'string' || !itemId || !delivery.isCurrent()) return;
    const port = captureRead(client);
    if (!port || !delivery.isCurrent()) return;

    try {
        port.assertCurrent();
        const result = await createRead(client, port).getItems({
            userId: port.binding.profileUserId,
            ids: [itemId],
            limit: 2
        });
        port.assertCurrent();
        if (!delivery.isCurrent() || !Array.isArray(result?.Items)
            || result.Items.length !== 1
            || result.TotalRecordCount !== undefined && result.TotalRecordCount !== 1) return;
        const item = result.Items[0];
        if (item?.Id !== itemId || item.ServerId !== port.binding.serverId) return;
        port.assertCurrent();
        if (delivery.isCurrent()) play(item);
    } catch {
        // A failed or stale read must not act on the successor session.
    }
}

import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { getAuthorizationHeader } from '@jellyfin/sdk/lib/utils/authentication';

import type { BoundSessionReadPort } from 'lib/profileSelector/sessionSwitch/boundRequests';
import { SessionReadCancelledError } from './sessionReadApi';

export interface HomeImageDescriptor {
    readonly itemId: string;
    readonly type: typeof ImageType.Backdrop | typeof ImageType.Primary | typeof ImageType.Thumb;
    readonly index?: number;
    readonly tag?: string;
    readonly fillWidth?: number;
    readonly fillHeight?: number;
    readonly maxHeight?: number;
    readonly quality?: number;
}

export interface SessionImageRead {
    assertCurrent(): void;
    fetchImage(descriptor: HomeImageDescriptor, signal: AbortSignal, maxBytes: number): Promise<Blob>;
}

interface ImageApiClient {
    appName(): string;
    appVersion(): string;
    deviceName(): string;
}

const IMAGE_TYPES = new Set([ImageType.Backdrop, ImageType.Primary, ImageType.Thumb]);
const RASTER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);
const ITEM_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

function imageUrl(basePath: string, descriptor: HomeImageDescriptor): string {
    if (!ITEM_ID.test(descriptor.itemId) || !IMAGE_TYPES.has(descriptor.type)
        || descriptor.index !== undefined && (!Number.isSafeInteger(descriptor.index) || descriptor.index < 0)
        || descriptor.tag !== undefined && (typeof descriptor.tag !== 'string' || descriptor.tag.length > 256)
        || !validSize(descriptor.fillWidth, 1920) || !validSize(descriptor.fillHeight, 1080)
        || !validSize(descriptor.maxHeight, 520) || !validSize(descriptor.quality, 100)) {
        throw new TypeError('Invalid Home image descriptor');
    }

    const url = new URL(`${basePath}/Items/${descriptor.itemId}/Images/${descriptor.type}`);
    const fields = {
        imageIndex: descriptor.index,
        tag: descriptor.tag,
        fillWidth: descriptor.fillWidth,
        fillHeight: descriptor.fillHeight,
        maxHeight: descriptor.maxHeight,
        quality: descriptor.quality
    };
    for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.href;
}

function validSize(value: number | undefined, maximum: number): boolean {
    return value === undefined || Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function rasterMime(response: Response, maxBytes: number): string {
    const mime = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (!response.ok || response.redirected || response.type === 'opaque' || !mime || !RASTER_TYPES.has(mime)
        || Number(response.headers.get('Content-Length')) > maxBytes || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Home image response unavailable');
    }
    return mime;
}

async function readRasterBody(response: Response, maxBytes: number, assertCurrent: () => void, signal: AbortSignal): Promise<BlobPart[]> {
    const reader = response.body!.getReader();
    const chunks: BlobPart[] = [];
    let size = 0;
    let complete = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            assertCurrent();
            if (signal.aborted) throw new SessionReadCancelledError();
            if (done) {
                complete = true;
                return chunks;
            }
            size += value.byteLength;
            if (size > maxBytes) throw new Error('Home image exceeded budget');
            chunks.push(Uint8Array.from(value));
        }
    } finally {
        if (!complete) void reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

export function createSessionImageRead(
    client: ImageApiClient,
    port: BoundSessionReadPort,
    transport: typeof fetch = fetch
): SessionImageRead {
    const authorization = getAuthorizationHeader(
        { name: client.appName(), version: client.appVersion() },
        { name: client.deviceName(), id: port.binding.deviceId },
        port.binding.credentialRef.token
    );
    const assertCurrent = () => {
        try {
            port.assertCurrent();
        } catch {
            throw new SessionReadCancelledError();
        }
    };

    return Object.freeze({
        assertCurrent,
        async fetchImage(descriptor: HomeImageDescriptor, callerSignal: AbortSignal, maxBytes: number): Promise<Blob> {
            assertCurrent();
            const url = imageUrl(port.basePath, descriptor);
            if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Invalid Home image budget');
            let lease;
            try {
                lease = port.acquire();
            } catch {
                throw new SessionReadCancelledError();
            }
            const controller = new window['AbortController']();
            const cancel = () => controller.abort();
            callerSignal.addEventListener('abort', cancel, { once: true });
            lease.signal.addEventListener('abort', cancel, { once: true });
            if (callerSignal.aborted || lease.signal.aborted) cancel();
            try {
                assertCurrent();
                if (controller.signal.aborted) throw new SessionReadCancelledError();
                const response = await transport(url, {
                    method: 'GET',
                    headers: { Authorization: authorization, 'Cache-Control': 'no-cache' },
                    credentials: 'omit',
                    cache: 'no-store',
                    redirect: 'error',
                    signal: controller.signal
                });
                assertCurrent();
                if (controller.signal.aborted) throw new SessionReadCancelledError();
                const mime = rasterMime(response, maxBytes);
                const chunks = await readRasterBody(response, maxBytes, assertCurrent, controller.signal);
                assertCurrent();
                if (controller.signal.aborted) throw new SessionReadCancelledError();
                return new Blob(chunks, { type: mime });
            } catch (error) {
                assertCurrent();
                if (controller.signal.aborted) throw new SessionReadCancelledError();
                throw error;
            } finally {
                callerSignal.removeEventListener('abort', cancel);
                lease.signal.removeEventListener('abort', cancel);
                lease.settle();
            }
        }
    });
}

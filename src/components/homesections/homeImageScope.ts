import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import type { HomeImageDescriptor, SessionImageRead } from 'utils/jellyfin-apiclient/sessionImageRead';

// The encoded-byte budget limits retained blobs, not browser-decoded raster memory.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SCOPE_BYTES = 48 * 1024 * 1024;
const MAX_CONCURRENT_IMAGES = 4;
const MAX_QUEUED_IMAGES = 40;

interface ImageSlot {
    readonly element: HTMLImageElement;
    readonly descriptor: HomeImageDescriptor;
    readonly onUnavailable: () => void;
    readonly controller: AbortController;
    state: 'waiting' | 'queued' | 'loading' | 'complete';
    url?: string;
}

export interface HomeImageScope {
    add(element: HTMLImageElement, descriptor: HomeImageDescriptor, onUnavailable: () => void, eager?: boolean): void;
    dispose(): void;
}

export function getBackdropDescriptor(
    item: BaseItemDto,
    dimensions: Pick<HomeImageDescriptor, 'fillWidth' | 'fillHeight' | 'quality'>
): HomeImageDescriptor | undefined {
    if (item.Id && item.BackdropImageTags?.length) {
        return { itemId: item.Id, type: ImageType.Backdrop, index: 0, tag: item.BackdropImageTags[0], ...dimensions };
    }
    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
        return { itemId: item.ParentBackdropItemId, type: ImageType.Backdrop, index: 0, tag: item.ParentBackdropImageTags[0], ...dimensions };
    }
    if (item.Id && item.ImageTags?.Primary) {
        return { itemId: item.Id, type: ImageType.Primary, tag: item.ImageTags.Primary, ...dimensions };
    }
    return undefined;
}

export function getHeroPosterDescriptor(item: BaseItemDto): HomeImageDescriptor | undefined {
    const dimensions = { maxHeight: 520, quality: 90 };
    if (item.Id && item.ImageTags?.Primary) {
        return { itemId: item.Id, type: ImageType.Primary, tag: item.ImageTags.Primary, ...dimensions };
    }
    if (item.SeriesId && item.SeriesPrimaryImageTag) {
        return { itemId: item.SeriesId, type: ImageType.Primary, tag: item.SeriesPrimaryImageTag, ...dimensions };
    }
    if (item.ParentPrimaryImageItemId && item.ParentPrimaryImageTag) {
        return { itemId: item.ParentPrimaryImageItemId, type: ImageType.Primary, tag: item.ParentPrimaryImageTag, ...dimensions };
    }
    return undefined;
}

export function getWideDescriptor(item: BaseItemDto): HomeImageDescriptor | undefined {
    const dimensions = { fillWidth: 640, fillHeight: 360, quality: 84 };
    const backdrop = getBackdropDescriptor(item, dimensions);
    if (backdrop) return backdrop;
    if (item.Id && item.ImageTags?.Thumb) {
        return { itemId: item.Id, type: ImageType.Thumb, tag: item.ImageTags.Thumb, ...dimensions };
    }
    if (item.Id && item.ImageTags?.Primary) {
        return { itemId: item.Id, type: ImageType.Primary, tag: item.ImageTags.Primary, ...dimensions };
    }
    return undefined;
}

export function createHomeImageScope(root: HTMLElement, read: SessionImageRead): HomeImageScope {
    const slots = new Set<ImageSlot>();
    const queue: ImageSlot[] = [];
    const urls = new Set<string>();
    let disposed = false;
    let inFlight = 0;
    let retainedBytes = 0;
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const slot = Array.from(slots).find(candidate => candidate.element === entry.target);
            if (slot) enqueue(slot, false);
            observer?.unobserve(entry.target);
        }
    }, { rootMargin: '300px' });

    function isCurrent(slot: ImageSlot): boolean {
        if (disposed || !slots.has(slot) || !root.contains(slot.element)) return false;
        try {
            read.assertCurrent();
            return true;
        } catch {
            return false;
        }
    }

    function unavailable(slot: ImageSlot): void {
        if (isCurrent(slot)) slot.onUnavailable();
    }

    function enqueue(slot: ImageSlot, priority: boolean): void {
        if (slot.state !== 'waiting' || !isCurrent(slot)) return;
        slot.state = 'queued';
        if (queue.length >= MAX_QUEUED_IMAGES) {
            slot.state = 'complete';
            unavailable(slot);
            return;
        }
        if (priority) queue.unshift(slot);
        else queue.push(slot);
        drain();
    }

    function drain(): void {
        while (!disposed && inFlight < MAX_CONCURRENT_IMAGES && queue.length) {
            const slot = queue.shift()!;
            if (!isCurrent(slot)) continue;
            slot.state = 'loading';
            inFlight++;
            const remaining = MAX_SCOPE_BYTES - retainedBytes;
            if (remaining <= 0) {
                slot.state = 'complete';
                inFlight--;
                unavailable(slot);
                continue;
            }
            void read.fetchImage(slot.descriptor, slot.controller.signal, Math.min(MAX_IMAGE_BYTES, remaining))
                .then(blob => {
                    if (!isCurrent(slot)) return;
                    if (blob.size > MAX_SCOPE_BYTES - retainedBytes) {
                        unavailable(slot);
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    if (!isCurrent(slot)) {
                        URL.revokeObjectURL(url);
                        return;
                    }
                    retainedBytes += blob.size;
                    urls.add(url);
                    slot.url = url;
                    slot.element.addEventListener('error', () => {
                        if (!isCurrent(slot) || slot.element.src !== url) return;
                        slot.element.removeAttribute('src');
                        URL.revokeObjectURL(url);
                        urls.delete(url);
                        retainedBytes -= blob.size;
                        unavailable(slot);
                    }, { once: true });
                    slot.element.src = url;
                })
                .catch(() => unavailable(slot))
                .finally(() => {
                    slot.state = 'complete';
                    inFlight--;
                    drain();
                });
        }
    }

    return {
        add(element, descriptor, onUnavailable, eager = false) {
            if (disposed || !root.contains(element)) return;
            const slot: ImageSlot = {
                element, descriptor, onUnavailable, controller: new window['AbortController'](), state: 'waiting'
            };
            slots.add(slot);
            if (eager || !observer) enqueue(slot, eager);
            else observer.observe(element);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            observer?.disconnect();
            queue.length = 0;
            for (const slot of slots) {
                slot.controller.abort();
                if (slot.url && slot.element.src === slot.url) slot.element.removeAttribute('src');
            }
            slots.clear();
            for (const url of urls) URL.revokeObjectURL(url);
            urls.clear();
            retainedBytes = 0;
        }
    };
}

import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { describe, expect, it, vi } from 'vitest';

import type { SessionImageRead } from 'utils/jellyfin-apiclient/sessionImageRead';
import { createHomeImageScope, getBackdropDescriptor, getHeroPosterDescriptor, getWideDescriptor } from './homeImageScope';

const itemId = '5dae694ba968f2676a64ceb6934f667b';
const descriptor = { itemId, type: ImageType.Primary, tag: 'tag-a' };

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function rootWithImage() {
    const root = document.createElement('div');
    const image = document.createElement('img');
    root.append(image);
    return { root, image };
}

describe('Home image descriptors and visual scope', () => {
    it('preserves item, parent and primary backdrop fallback plus poster and wide thumb precedence', () => {
        const backdrop = { Id: itemId, BackdropImageTags: ['backdrop'], ImageTags: { Primary: 'primary', Thumb: 'thumb' } } as BaseItemDto;
        expect(getBackdropDescriptor(backdrop, { fillWidth: 640, fillHeight: 360, quality: 84 }))
            .toMatchObject({ itemId, type: ImageType.Backdrop, index: 0, tag: 'backdrop' });
        expect(getWideDescriptor(backdrop)?.type).toBe(ImageType.Backdrop);
        expect(getHeroPosterDescriptor(backdrop)?.tag).toBe('primary');

        const parent = { Id: itemId, ParentBackdropItemId: '11111111111111111111111111111111', ParentBackdropImageTags: ['parent'], ImageTags: { Thumb: 'thumb' } } as BaseItemDto;
        expect(getBackdropDescriptor(parent, {})?.itemId).toBe(parent.ParentBackdropItemId);
        expect(getWideDescriptor(parent)?.type).toBe(ImageType.Backdrop);

        const thumb = { Id: itemId, ImageTags: { Thumb: 'thumb', Primary: 'primary' } } as BaseItemDto;
        expect(getWideDescriptor(thumb)?.type).toBe(ImageType.Primary);
        expect(getWideDescriptor({ Id: itemId, ImageTags: { Thumb: 'thumb' } } as BaseItemDto)?.type).toBe(ImageType.Thumb);
        expect(getBackdropDescriptor(thumb, {})?.type).toBe(ImageType.Primary);
        expect(getHeroPosterDescriptor({ SeriesId: itemId, SeriesPrimaryImageTag: 'series' } as BaseItemDto)?.tag).toBe('series');
        expect(getHeroPosterDescriptor({ ParentPrimaryImageItemId: itemId, ParentPrimaryImageTag: 'parent' } as BaseItemDto)?.tag).toBe('parent');
        expect(getWideDescriptor({ Id: itemId } as BaseItemDto)).toBeUndefined();
    });

    it('never publishes a late A blob or clears B when A transport ignores abort', async () => {
        const pending = deferred<Blob>();
        const oldRead = { assertCurrent: vi.fn(), fetchImage: vi.fn(() => pending.promise) } as unknown as SessionImageRead;
        const newRead = { assertCurrent: vi.fn(), fetchImage: vi.fn(async () => new Blob(['B'], { type: 'image/png' })) } as unknown as SessionImageRead;
        const create = vi.fn().mockReturnValue('blob:B');
        const revoke = vi.fn();
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
        const { root, image: oldImage } = rootWithImage();
        const oldScope = createHomeImageScope(root, oldRead);
        oldScope.add(oldImage, descriptor, vi.fn(), true);
        oldScope.dispose();
        oldImage.remove();
        const newImage = document.createElement('img');
        root.append(newImage);
        const newScope = createHomeImageScope(root, newRead);
        newScope.add(newImage, descriptor, vi.fn(), true);
        await vi.waitFor(() => expect(newImage.src).toContain('blob:B'));
        pending.resolve(new Blob(['A'], { type: 'image/png' }));
        await vi.waitFor(() => expect(oldScope).toBeDefined());

        expect(create).toHaveBeenCalledTimes(1);
        expect(oldImage.hasAttribute('src')).toBe(false);
        expect(newImage.src).toContain('blob:B');
        newScope.dispose();
        newScope.dispose();
        expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:B');
        Reflect.deleteProperty(URL, 'createObjectURL');
        Reflect.deleteProperty(URL, 'revokeObjectURL');
    });

    it('uses the existing placeholder callback on decode error and revokes its blob exactly once', async () => {
        const create = vi.fn(() => 'blob:broken');
        const revoke = vi.fn();
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
        try {
            const read = {
                assertCurrent: vi.fn(),
                fetchImage: vi.fn(async () => new Blob(['invalid'], { type: 'image/png' }))
            } as unknown as SessionImageRead;
            const { root, image } = rootWithImage();
            const unavailable = vi.fn(() => image.replaceWith(document.createElement('span')));
            const scope = createHomeImageScope(root, read);
            scope.add(image, descriptor, unavailable, true);
            await vi.waitFor(() => expect(image.src).toContain('blob:broken'));
            image.dispatchEvent(new Event('error'));

            expect(unavailable).toHaveBeenCalledOnce();
            expect(root.querySelector('span')).not.toBeNull();
            scope.dispose();
            expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:broken');
        } finally {
            Reflect.deleteProperty(URL, 'createObjectURL');
            Reflect.deleteProperty(URL, 'revokeObjectURL');
        }
    });

    it('creates separate blob URLs for the same descriptor after an authority-scoped replacement', async () => {
        const create = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
        const revoke = vi.fn();
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
        try {
            const read = {
                assertCurrent: vi.fn(),
                fetchImage: vi.fn(async () => new Blob(['pixels'], { type: 'image/png' }))
            } as unknown as SessionImageRead;
            const { root, image: first } = rootWithImage();
            const oldScope = createHomeImageScope(root, read);
            oldScope.add(first, descriptor, vi.fn(), true);
            await vi.waitFor(() => expect(first.src).toContain('blob:first'));
            oldScope.dispose();
            expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:first');

            first.remove();
            const second = document.createElement('img');
            root.append(second);
            const nextScope = createHomeImageScope(root, read);
            nextScope.add(second, descriptor, vi.fn(), true);
            await vi.waitFor(() => expect(second.src).toContain('blob:second'));
            expect(create).toHaveBeenCalledTimes(2);
            expect(revoke).not.toHaveBeenCalledWith('blob:second');
            nextScope.dispose();
            expect(revoke).toHaveBeenCalledWith('blob:second');
        } finally {
            Reflect.deleteProperty(URL, 'createObjectURL');
            Reflect.deleteProperty(URL, 'revokeObjectURL');
        }
    });

    it('keeps a transport-violating oversized blob out of the DOM and uses the placeholder', async () => {
        const create = vi.fn();
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
        try {
            const read = {
                assertCurrent: vi.fn(),
                fetchImage: vi.fn(async () => ({ size: 49 * 1024 * 1024 }) as Blob)
            } as unknown as SessionImageRead;
            const { root, image } = rootWithImage();
            const unavailable = vi.fn();
            const scope = createHomeImageScope(root, read);
            scope.add(image, descriptor, unavailable, true);
            await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
            expect(create).not.toHaveBeenCalled();
            expect(image.hasAttribute('src')).toBe(false);
            scope.dispose();
        } finally {
            Reflect.deleteProperty(URL, 'createObjectURL');
        }
    });

    it('keeps offscreen cards out of fetch until intersection and respects a four-request queue', async () => {
        const observed: Element[] = [];
        let intersect!: (element: Element) => void;
        const original = globalThis.IntersectionObserver;
        globalThis.IntersectionObserver = class {
            constructor(private callback: IntersectionObserverCallback) {
                intersect = element => this.callback([ { target: element, isIntersecting: true } as IntersectionObserverEntry ], this as never);
            }
            observe(element: Element) { observed.push(element); }
            unobserve(element: Element) { observed.splice(observed.indexOf(element), 1); }
            disconnect() { observed.length = 0; }
        } as unknown as typeof IntersectionObserver;
        try {
            const pending = deferred<Blob>();
            const read = { assertCurrent: vi.fn(), fetchImage: vi.fn(() => pending.promise) } as unknown as SessionImageRead;
            const root = document.createElement('div');
            const images = Array.from({ length: 6 }, () => document.createElement('img'));
            root.append(...images);
            const scope = createHomeImageScope(root, read);
            for (const image of images) scope.add(image, descriptor, vi.fn());
            expect(observed).toHaveLength(6);
            expect(read.fetchImage).not.toHaveBeenCalled();
            for (const image of images) intersect(image);
            expect(read.fetchImage).toHaveBeenCalledTimes(4);
            scope.dispose();
        } finally {
            globalThis.IntersectionObserver = original;
        }
    });
});

import type { BaseItemDto, UserDto } from '@jellyfin/sdk/lib/generated-client';
import { CancelledError } from '@tanstack/react-query';
import type { ApiClient } from 'jellyfin-apiclient';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('components/playback/playbackmanager', () => ({ playbackManager: {} }));
vi.mock('components/router/appRouter', () => ({ appRouter: { getRouteUrl: () => '#/nextup' } }));
vi.mock('utils/dashboard', () => ({ default: { navigate: vi.fn() } }));
vi.mock('lib/globalize', () => ({ default: { translate: (key: string) => key } }));
vi.mock('utils/jellyfin-apiclient/backdropImage', () => ({ getItemBackdropImageUrl: () => undefined }));

import { queryClient } from 'utils/query/queryClient';
import { SessionReadCancelledError, type SessionScopedHomeReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';

import { loadTvHomeDashboard } from './tvHomeDashboard';
import { loadTvHomeHero } from './tvHomeHero';
import type { HomeSessionRead } from './homeSessionRead';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function homeSession(
    overrides: Partial<SessionScopedHomeReadApi> = {},
    identityOverrides: Partial<SessionScopedHomeReadApi['identity']> = {}
) {
    let current = true;
    const identity = {
        serverId: 'server-a', profileUserId: 'user-a', sessionEpoch: 1, authorityGeneration: '1:home-a',
        ...identityOverrides
    };
    const read = {
        identity,
        assertCurrent: () => {
            if (!current) throw new SessionReadCancelledError();
        },
        getUserViews: vi.fn(async () => ({ Items: [] })),
        getResumeItems: vi.fn(async () => ({ Items: [] })),
        getNextUp: vi.fn(async () => ({ Items: [] })),
        getLatestMedia: vi.fn(async () => []),
        ...overrides
    } as unknown as SessionScopedHomeReadApi;
    const session: HomeSessionRead = {
        apiClient: { serverId: () => identity.serverId } as ApiClient,
        read,
        user: { Id: identity.profileUserId, ServerId: identity.serverId } as UserDto,
        images: { add: vi.fn(), dispose: vi.fn() },
        assertCurrent: () => read.assertCurrent()
    };
    const stale = () => {
        current = false;
    };
    return { session, stale };
}

beforeEach(() => {
    queryClient.clear();
});

describe('visible Home session read boundary', () => {
    it('does not render a late hero result after its authority changes', async () => {
        const pending = deferred<{ Items: BaseItemDto[] }>();
        const { session, stale } = homeSession({ getResumeItems: vi.fn(() => pending.promise) });
        const hero = document.createElement('div');
        hero.className = 'tvHomeHero hide';

        const load = loadTvHomeHero(hero, session);
        stale();
        pending.resolve({ Items: [{ Id: 'old-movie', Name: 'Old movie', Type: 'Movie' }] });

        await expect(load).rejects.toBeInstanceOf(SessionReadCancelledError);
        expect(hero.innerHTML).toBe('');
        expect(hero.classList.contains('hide')).toBe(true);
    });

    it('propagates a base query cancellation without rendering hero or dashboard errors', async () => {
        const cancelled = async (): Promise<never> => {
            throw new CancelledError();
        };
        const { session } = homeSession({
            getResumeItems: cancelled,
            getUserViews: cancelled
        });
        const hero = document.createElement('div');
        const dashboard = document.createElement('div');
        hero.className = 'tvHomeHero hide';
        dashboard.className = 'tvHomeDashboard hide';

        await expect(loadTvHomeHero(hero, session)).rejects.toBeInstanceOf(CancelledError);
        await expect(loadTvHomeDashboard(dashboard, session)).rejects.toBeInstanceOf(CancelledError);
        expect(hero.innerHTML).toBe('');
        expect(dashboard.innerHTML).toBe('');
    });

    it('does not turn an allSettled stale response into an empty or error dashboard', async () => {
        const pending = deferred<{ Items: BaseItemDto[] }>();
        const { session, stale } = homeSession({ getResumeItems: vi.fn(() => pending.promise) });
        const dashboard = document.createElement('div');
        dashboard.className = 'tvHomeDashboard hide';

        const load = loadTvHomeDashboard(dashboard, session);
        await vi.waitFor(() => expect(session.read.getResumeItems).toHaveBeenCalled());
        stale();
        pending.resolve({ Items: [{ Id: 'old-movie', Name: 'Old movie', Type: 'Movie' }] });

        await expect(load).rejects.toBeInstanceOf(SessionReadCancelledError);
        expect(dashboard.innerHTML).toBe('');
        expect(dashboard.classList.contains('hide')).toBe(true);
    });

    it('propagates cancellations swallowed by both nested and outer allSettled', async () => {
        const cases: Partial<SessionScopedHomeReadApi>[] = [
            {
                getResumeItems: async () => {
                    throw new CancelledError();
                }
            },
            {
                getUserViews: async () => ({ Items: [{ Id: 'library-a', CollectionType: 'movies' }] }),
                getLatestMedia: async () => {
                    throw new SessionReadCancelledError();
                }
            }
        ];

        for (const reads of cases) {
            queryClient.clear();
            const { session } = homeSession(reads);
            const dashboard = document.createElement('div');
            dashboard.className = 'tvHomeDashboard hide';

            await expect(loadTvHomeDashboard(dashboard, session)).rejects.toBeInstanceOf(CancelledError);
            expect(dashboard.innerHTML).toBe('');
            expect(dashboard.classList.contains('hide')).toBe(true);
        }
    });

    it('renders the current dashboard and preserves ordinary partial failure', async () => {
        const { session } = homeSession({
            getResumeItems: async () => {
                throw new Error('ordinary failure');
            }
        });
        const dashboard = document.createElement('div');
        dashboard.className = 'tvHomeDashboard hide';

        await loadTvHomeDashboard(dashboard, session);

        expect(dashboard.querySelector('.tvHomeDashboard__loadState--partial')).not.toBeNull();
        expect(dashboard.classList.contains('hide')).toBe(false);
    });

    it('renders image slots without remote URLs while preserving card text and fallback descriptors', async () => {
        const itemId = '5dae694ba968f2676a64ceb6934f667b';
        const item = {
            Id: itemId,
            Name: 'Current film',
            Type: 'Movie',
            BackdropImageTags: ['backdrop-tag'],
            ImageTags: { Primary: 'poster-tag' },
            UserData: { Key: itemId, PlaybackPositionTicks: 10 },
            RunTimeTicks: 100
        } as BaseItemDto;
        const { session } = homeSession({ getResumeItems: vi.fn(async () => ({ Items: [item] })) });
        const hero = document.createElement('div');
        const dashboard = document.createElement('div');

        await loadTvHomeHero(hero, session);
        await loadTvHomeDashboard(dashboard, session);

        expect(hero.textContent).toContain('Current film');
        expect(dashboard.textContent).toContain('Current film');
        expect(hero.querySelectorAll('img')).toHaveLength(2);
        expect(dashboard.querySelectorAll('img')).toHaveLength(1);
        expect([ ...hero.querySelectorAll('img'), ...dashboard.querySelectorAll('img') ]
            .every(image => !image.hasAttribute('src'))).toBe(true);
        expect(session.images.add).toHaveBeenCalledTimes(3);
        const descriptors = vi.mocked(session.images.add).mock.calls.map(([, descriptor]) => descriptor);
        expect(descriptors).toEqual([
            expect.objectContaining({ itemId, type: 'Backdrop', fillWidth: 1920, fillHeight: 1080, quality: 88 }),
            expect.objectContaining({ itemId, type: 'Primary', maxHeight: 520, quality: 90 }),
            expect.objectContaining({ itemId, type: 'Backdrop', fillWidth: 640, fillHeight: 360, quality: 84 })
        ]);
    });

    it('keeps a titled playable card and its existing placeholder when metadata has no image', async () => {
        const item = { Id: '5dae694ba968f2676a64ceb6934f667b', Name: 'No art film', Type: 'Movie' } as BaseItemDto;
        const { session } = homeSession({ getResumeItems: vi.fn(async () => ({ Items: [item] })) });
        const dashboard = document.createElement('div');

        await loadTvHomeDashboard(dashboard, session);

        expect(dashboard.querySelector('.tvHomeMediaCard__title')?.textContent).toBe('No art film');
        expect(dashboard.querySelector('.tvHomeMediaCard__placeholder')).not.toBeNull();
        expect(dashboard.querySelector('.tvHomeMediaCard__play')).not.toBeNull();
        expect(dashboard.querySelector('.tvHomeMediaCard__image')).toBeNull();
    });

    it('does not reuse Views cache across a same-user epoch and generation replacement', async () => {
        const firstViews = vi.fn(async () => ({ Items: [] }));
        const nextViews = vi.fn(async () => ({ Items: [] }));
        const first = homeSession({ getUserViews: firstViews });
        const next = homeSession({ getUserViews: nextViews }, {
            sessionEpoch: 2,
            authorityGeneration: '2:home-b'
        });

        await loadTvHomeDashboard(document.createElement('div'), first.session);
        await loadTvHomeDashboard(document.createElement('div'), next.session);

        expect(firstViews).toHaveBeenCalledOnce();
        expect(nextViews).toHaveBeenCalledOnce();
    });

    it('never logs an authenticated transport error from hero or dashboard', async () => {
        const secret = 'secret-authorization-marker';
        const failure = Object.assign(new Error('private transport detail'), {
            config: { headers: { Authorization: secret } }
        });
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { session } = homeSession({
            getResumeItems: async () => {
                throw failure;
            },
            getUserViews: async () => {
                throw failure;
            }
        });

        try {
            await loadTvHomeHero(document.createElement('div'), session);
            await loadTvHomeDashboard(document.createElement('div'), session);

            expect(log).toHaveBeenCalledTimes(2);
            expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
            expect(JSON.stringify(log.mock.calls)).not.toContain('config');
        } finally {
            log.mockRestore();
        }
    });
});

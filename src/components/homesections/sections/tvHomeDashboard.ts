import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import { CancelledError } from '@tanstack/react-query';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { UserDto } from '@jellyfin/sdk/lib/generated-client/models/user-dto';
import escapeHtml from 'escape-html';
import type { ApiClient } from 'jellyfin-apiclient';

import { appRouter } from 'components/router/appRouter';
import { JellyflixCollectionType, isAdultVideosCollectionType } from 'constants/jellyflixCollectionTypes';
import Dashboard from 'utils/dashboard';
import type { HomeImageDescriptor } from 'utils/jellyfin-apiclient/sessionImageRead';
import { getWideDescriptor } from '../homeImageScope';
import { queryClient } from 'utils/query/queryClient';
import globalize from 'lib/globalize';
import type { HomeSessionRead } from './homeSessionRead';
import { SessionReadCancelledError } from 'utils/jellyfin-apiclient/sessionReadApi';
import {
    aggregateHomeSectionResults,
    getHomeLoadState,
    type HomeLoadState,
    type HomeSectionAggregation
} from './homeLoadState';

const TV_HOME_FIELDS = [
    ItemFields.PrimaryImageAspectRatio,
    ItemFields.Overview,
    ItemFields.DateCreated,
    ItemFields.ParentId,
    ItemFields.MediaSourceCount
];

const EXCLUDED_LIBRARY_TYPES = new Set([
    'livetv',
    'playlists',
    'channels',
    'folders'
]);

const RECENT_LIBRARY_EXCLUDES = new Set([
    'livetv',
    'playlists',
    'channels',
    'folders',
    'boxsets'
]);

const HOME_PAGE_WITHOUT_RESUME_HERO_CLASS = 'homePage--withoutResumeHero';
const DASHBOARD_WITHOUT_RESUME_HERO_CLASS = 'tvHomeDashboard--withoutResumeHero';
const dashboardOwners = new WeakMap<HTMLElement, AbortController>();

type LibraryTone = 'red' | 'blue' | 'purple' | 'green' | 'orange' | 'gray';

type LibraryViewModel = {
    item: BaseItemDto;
    name: string;
    icon: string;
    tone: LibraryTone;
    adult: boolean;
};

type LibraryCountTarget = {
    libraryId: string;
    itemKind: BaseItemKind;
    chip: HTMLElement;
};

function getUserViews(session: HomeSessionRead): Promise<BaseItemDto[]> {
    const { serverId, profileUserId, sessionEpoch, authorityGeneration } = session.read.identity;
    return queryClient
        .fetchQuery({
            queryKey: [ 'Home', 'UserViews', serverId, profileUserId, sessionEpoch, authorityGeneration ],
            queryFn: ({ signal }) => session.read.getUserViews({ userId: profileUserId }, signal),
            staleTime: 1000
        })
        .then(result => {
            session.assertCurrent();
            return result.Items || [];
        });
}

function isAdultLibrary(item: BaseItemDto): boolean {
    if (isAdultVideosCollectionType(item.CollectionType)) {
        return true;
    }

    const name = (item.Name || '').toLowerCase();

    return name.includes('+18')
        || name.includes('adult')
        || name.includes('adultos')
        || name.includes('adults');
}

function getLibraryViewModel(item: BaseItemDto): LibraryViewModel {
    const name = item.Name || '';
    const collectionType = (item.CollectionType || '').toLowerCase();
    const adult = isAdultLibrary(item);

    if (adult) {
        return {
            item,
            name,
            icon: 'lock',
            tone: 'orange',
            adult: true
        };
    }

    if (collectionType === 'movies') {
        return {
            item,
            name,
            icon: 'local_movies',
            tone: 'red',
            adult: false
        };
    }

    if (collectionType === 'tvshows') {
        return {
            item,
            name,
            icon: 'live_tv',
            tone: 'blue',
            adult: false
        };
    }

    if (collectionType === 'boxsets') {
        return {
            item,
            name,
            icon: 'collections',
            tone: 'green',
            adult: false
        };
    }

    if (collectionType === JellyflixCollectionType.Courses || collectionType === 'homevideos' || name.toLowerCase().includes('curso')) {
        return {
            item,
            name,
            icon: 'school',
            tone: 'purple',
            adult: false
        };
    }

    return {
        item,
        name,
        icon: 'folder',
        tone: 'gray',
        adult: false
    };
}

function getLibraryPriority(library: LibraryViewModel): number {
    const collectionType = (library.item.CollectionType || '').toLowerCase();
    const name = library.name.toLowerCase();

    if (collectionType === 'movies') {
        return 10;
    }

    if (collectionType === 'tvshows') {
        return 20;
    }

    if (collectionType === JellyflixCollectionType.Courses || name.includes('curso')) {
        return 30;
    }

    if (library.adult) {
        return 40;
    }

    if (collectionType === 'boxsets') {
        return 50;
    }

    if (collectionType === 'homevideos' || collectionType === 'musicvideos') {
        return 60;
    }

    return 100;
}

function getProgressPercent(item: BaseItemDto): number {
    const playbackTicks = item.UserData?.PlaybackPositionTicks || 0;
    const runtimeTicks = item.RunTimeTicks || 0;

    if (!playbackTicks || !runtimeTicks) {
        return 0;
    }

    return Math.min(100, Math.max(0, Math.round((playbackTicks / runtimeTicks) * 100)));
}

function getRemainingLabel(item: BaseItemDto): string | undefined {
    const playbackTicks = item.UserData?.PlaybackPositionTicks || 0;
    const runtimeTicks = item.RunTimeTicks || 0;

    if (!playbackTicks || !runtimeTicks || playbackTicks >= runtimeTicks) {
        return undefined;
    }

    const ticksPerMinute = 600000000;
    const minutes = Math.max(1, Math.ceil((runtimeTicks - playbackTicks) / ticksPerMinute));

    return globalize.translate('HomeMinutesRemaining', minutes);
}

function getEpisodeCode(item: BaseItemDto): string | undefined {
    if (item.Type !== 'Episode') {
        return undefined;
    }

    const parts = [];

    if (item.ParentIndexNumber != null) {
        parts.push(`T${item.ParentIndexNumber}`);
    }

    if (item.IndexNumber != null) {
        parts.push(`E${item.IndexNumber}`);
    }

    return parts.join(':') || undefined;
}

function getDisplayTitle(item: BaseItemDto): string {
    if (item.Type === 'Episode' && item.SeriesName) {
        return item.SeriesName;
    }

    return item.Name || '';
}

function getResumeSubtitle(item: BaseItemDto): string {
    const parts = [
        getEpisodeCode(item),
        getRemainingLabel(item)
    ].filter(Boolean);

    if (parts.length) {
        return parts.join(' · ');
    }

    if (item.ProductionYear) {
        return item.ProductionYear.toString();
    }

    return item.Type || '';
}

function getNextUpSubtitle(item: BaseItemDto): string {
    const episodeCode = getEpisodeCode(item);

    return episodeCode ? globalize.translate('HomeNextEpisodeCode', episodeCode) : globalize.translate('NextUp');
}

function getRecentlyAddedSubtitle(item: BaseItemDto): string {
    if (item.Type === 'Episode') {
        const episodeCode = getEpisodeCode(item);
        const title = item.Name ? ` · ${item.Name}` : '';

        return [item.SeriesName, episodeCode ? `${episodeCode}${title}` : item.Name]
            .filter(Boolean)
            .join(' · ');
    }

    if (item.ProductionYear) {
        return item.ProductionYear.toString();
    }

    return item.Type || '';
}

function renderSectionHeader(title: string, subtitle?: string, actionHtml = ''): string {
    let html = '<div class="tvHomeDashboard__sectionHeader">';
    html += '<div class="tvHomeDashboard__sectionTitleGroup">';
    html += '<h2 class="tvHomeDashboard__sectionTitle">' + escapeHtml(title) + '</h2>';

    if (subtitle) {
        html += '<span class="tvHomeDashboard__sectionSubtitle">' + escapeHtml(subtitle) + '</span>';
    }

    html += '</div>';
    html += actionHtml;
    html += '</div>';

    return html;
}

function renderSectionAction(label: string, href: string): string {
    return '<a is="emby-linkbutton" class="tvHomeDashboard__sectionAction" href="' + escapeHtml(href) + '">' + escapeHtml(label) + ' ›</a>';
}

function getVisibleLibraries(libraries: BaseItemDto[]): LibraryViewModel[] {
    return libraries
        .filter(item => !EXCLUDED_LIBRARY_TYPES.has((item.CollectionType || '').toLowerCase()))
        .map(getLibraryViewModel)
        .sort((a, b) => getLibraryPriority(a) - getLibraryPriority(b) || a.name.localeCompare(b.name));
}

function renderLibrariesSection(libraries: BaseItemDto[], user: UserDto): string {
    const visibleLibraries = getVisibleLibraries(libraries);

    if (!visibleLibraries.length) {
        return '';
    }

    let adminLink = '';
    if (user.Policy?.IsAdministrator) {
        adminLink = '<button is="emby-button" type="button" class="tvHomeDashboard__sectionAction tvHomeDashboard__sectionAction--button btnTvHomeManageLibraries">' + escapeHtml(globalize.translate('ManageLibrary')) + ' ›</button>';
    }

    let html = '<section class="tvHomeDashboard__section tvHomeDashboard__section--libraries">';
    html += renderSectionHeader(globalize.translate('HeaderMyMedia'), undefined, adminLink);
    html += '<div class="tvHomeDashboard__libraryRail">';

    visibleLibraries.forEach(library => {
        const href = appRouter.getRouteUrl(library.item);
        html += '<a is="emby-linkbutton" class="tvHomeLibraryChip tvHomeLibraryChip--' + library.tone + '" href="' + escapeHtml(href) + '">';
        html += '<span class="tvHomeLibraryChip__icon material-icons ' + library.icon + '" aria-hidden="true"></span>';
        html += '<span class="tvHomeLibraryChip__content">';
        html += '<span class="tvHomeLibraryChip__name">' + escapeHtml(library.name) + '</span>';

        if (library.adult) {
            html += '<span class="tvHomeLibraryChip__badge">+18</span>';
        }

        html += '</span>';
        html += '</a>';
    });

    html += '</div>';
    html += '</section>';

    return html;
}

function renderWideCard(item: BaseItemDto, subtitle: string, images: HomeImageDescriptor[], options: {
    badge?: string;
    showProgress?: boolean;
} = {}): string {
    const href = appRouter.getRouteUrl(item);
    const descriptor = getWideDescriptor(item);
    const title = getDisplayTitle(item);
    const progressPercent = options.showProgress ? getProgressPercent(item) : 0;

    let html = '<a is="emby-linkbutton" class="tvHomeMediaCard" href="' + escapeHtml(href) + '">';
    html += '<span class="tvHomeMediaCard__imageFrame">';

    if (descriptor) {
        const imageIndex = images.push(descriptor) - 1;
        html += '<img class="tvHomeMediaCard__image" data-home-image-index="' + imageIndex + '" alt="" loading="lazy" width="640" height="360" />';
    } else {
        html += '<span class="tvHomeMediaCard__placeholder material-icons movie" aria-hidden="true"></span>';
    }

    if (options.badge) {
        html += '<span class="tvHomeMediaCard__badge">' + escapeHtml(options.badge) + '</span>';
    }

    if (options.showProgress && progressPercent > 0) {
        html += '<span class="tvHomeMediaCard__progress"><span style="width: ' + progressPercent + '%"></span></span>';
    }

    html += '<span class="tvHomeMediaCard__play" aria-hidden="true"><span class="material-icons play_arrow"></span></span>';
    html += '</span>';
    html += '<span class="tvHomeMediaCard__body">';
    html += '<span class="tvHomeMediaCard__title">' + escapeHtml(title) + '</span>';

    if (subtitle) {
        html += '<span class="tvHomeMediaCard__subtitle">' + escapeHtml(subtitle) + '</span>';
    }

    html += '</span>';
    html += '</a>';

    return html;
}

function renderRailSection(
    title: string,
    subtitle: string,
    items: BaseItemDto[],
    cardRenderer: (item: BaseItemDto) => string,
    modifier: string,
    actionHtml = ''
): string {
    if (!items.length) {
        return '';
    }

    let html = '<section class="tvHomeDashboard__section tvHomeDashboard__section--' + modifier + '">';
    html += renderSectionHeader(title, subtitle, actionHtml);
    html += '<div class="tvHomeDashboard__railViewport">';
    html += '<div class="tvHomeDashboard__rail tvHomeDashboard__rail--' + modifier + '">';
    html += items.map(item => cardRenderer(item)).join('');
    html += '</div>';
    html += '</div>';
    html += '</section>';

    return html;
}

function getResumeItems(session: HomeSessionRead): Promise<BaseItemDto[]> {
    return session.read.getResumeItems({
        userId: session.read.identity.profileUserId,
        limit: 12,
        fields: TV_HOME_FIELDS,
        imageTypeLimit: 1,
        enableImageTypes: [ ImageType.Primary, ImageType.Backdrop, ImageType.Thumb ],
        enableTotalRecordCount: false,
        mediaTypes: [ MediaType.Video ]
    }).then(result => {
        session.assertCurrent();
        return result.Items || [];
    });
}

function getNextUpItems(session: HomeSessionRead): Promise<BaseItemDto[]> {
    const oldestDateForNextUp = new Date();
    oldestDateForNextUp.setDate(oldestDateForNextUp.getDate() - 365);

    return session.read.getNextUp({
        userId: session.read.identity.profileUserId,
        limit: 12,
        fields: TV_HOME_FIELDS,
        imageTypeLimit: 1,
        enableImageTypes: [ ImageType.Primary, ImageType.Backdrop, ImageType.Banner, ImageType.Thumb ],
        enableTotalRecordCount: false,
        nextUpDateCutoff: oldestDateForNextUp.toISOString(),
        enableResumable: false,
        enableRewatching: true
    }).then(result => {
        session.assertCurrent();
        return result.Items || [];
    });
}

function getLatestItems(session: HomeSessionRead, libraries: BaseItemDto[]): Promise<HomeSectionAggregation<BaseItemDto>> {
    const { user } = session;
    const excludedIds = new Set(user.Configuration?.LatestItemsExcludes || []);
    const eligibleLibraries = libraries.filter(item => {
        if (!item.Id || excludedIds.has(item.Id)) {
            return false;
        }

        return !RECENT_LIBRARY_EXCLUDES.has((item.CollectionType || '').toLowerCase());
    });

    return Promise.allSettled(eligibleLibraries.map(library => session.read.getLatestMedia({
        userId: session.read.identity.profileUserId,
        limit: 8,
        fields: TV_HOME_FIELDS,
        imageTypeLimit: 1,
        enableImageTypes: [ ImageType.Primary, ImageType.Backdrop, ImageType.Thumb ],
        parentId: library.Id
    })))
        .then(results => {
            session.assertCurrent();
            throwIfSessionCancelled(results);
            return aggregateHomeSectionResults(results);
        })
        .then(({ items, status }) => {
            session.assertCurrent();
            const sortedItems = [...items].sort((a, b) => {
                const left = a.DateCreated ? new Date(a.DateCreated).getTime() : 0;
                const right = b.DateCreated ? new Date(b.DateCreated).getTime() : 0;

                return right - left;
            });

            return {
                items: sortedItems.slice(0, 14),
                status
            };
        });
}

function getLibraryCountTargets(elem: HTMLElement, libraries: BaseItemDto[]): LibraryCountTarget[] {
    const chips = elem.querySelectorAll<HTMLElement>('.tvHomeLibraryChip');
    return getVisibleLibraries(libraries).flatMap((library, index) => {
        const collectionType = (library.item.CollectionType || '').toLowerCase();
        let itemKind: BaseItemKind | undefined;
        if (collectionType === 'movies') itemKind = BaseItemKind.Movie;
        if (collectionType === 'tvshows') itemKind = BaseItemKind.Series;
        const libraryId = library.item.Id;
        const chip = chips[index];
        return libraryId && itemKind && chip ? [{ libraryId, itemKind, chip }] : [];
    });
}

async function populateLibraryCounts(elem: HTMLElement, owner: AbortController, session: HomeSessionRead, libraries: BaseItemDto[]): Promise<void> {
    const targets = getLibraryCountTargets(elem, libraries);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < targets.length && dashboardOwners.get(elem) === owner && !owner.signal.aborted) {
            const target = targets[nextIndex++];
            if (!elem.contains(target.chip)) return;
            try {
                session.assertCurrent();
                const result = await session.read.getItems({
                    userId: session.read.identity.profileUserId,
                    parentId: target.libraryId,
                    recursive: true,
                    includeItemTypes: [target.itemKind],
                    limit: 1,
                    enableTotalRecordCount: true,
                    enableImages: false,
                    enableUserData: false
                }, owner.signal);
                session.assertCurrent();
                if (dashboardOwners.get(elem) !== owner || owner.signal.aborted || !elem.contains(target.chip)) return;
                const count = result.TotalRecordCount;
                if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
                    const badge = document.createElement('span');
                    badge.className = 'tvHomeLibraryChip__count';
                    badge.textContent = String(count);
                    target.chip.querySelector('.tvHomeLibraryChip__content')?.append(badge);
                }
            } catch (error) {
                if (error instanceof CancelledError) return;
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(2, targets.length) }, worker));
}

function throwIfSessionCancelled(results: PromiseSettledResult<unknown>[]): void {
    const cancelled = results.find(result => result.status === 'rejected'
        && result.reason instanceof CancelledError);
    if (cancelled?.status === 'rejected') throw cancelled.reason;
}

function getSettledItems(result: PromiseSettledResult<BaseItemDto[]>): BaseItemDto[] {
    return result.status === 'fulfilled' ? result.value : [];
}

function retireDashboardOwner(elem: HTMLElement): void {
    const owner = dashboardOwners.get(elem);
    dashboardOwners.delete(elem);
    owner?.abort();
}

function assertDashboardOwner(elem: HTMLElement, owner: AbortController): void {
    if (dashboardOwners.get(elem) !== owner || owner.signal.aborted) throw new SessionReadCancelledError();
}

function setWithoutResumeHeroState(elem: HTMLElement, enabled: boolean): void {
    elem.classList.toggle(DASHBOARD_WITHOUT_RESUME_HERO_CLASS, enabled);
    elem.closest('.homePage')?.classList.toggle(HOME_PAGE_WITHOUT_RESUME_HERO_CLASS, enabled);
}

function renderLoadState(state: HomeLoadState): string {
    if (state === 'ready') {
        return '';
    }

    const messages = {
        empty: [ 'HomeEmptyTitle', 'HomeEmptyBody' ],
        partial: [ 'HomePartialTitle', 'HomePartialBody' ],
        error: [ 'HomeErrorTitle', 'HomeErrorBody' ]
    } as const;
    const role = state === 'error' ? 'alert' : 'status';
    const [ titleKey, bodyKey ] = messages[state];

    return '<section class="tvHomeDashboard__loadState tvHomeDashboard__loadState--' + state + '" role="' + role + '">'
        + '<h2>' + escapeHtml(globalize.translate(titleKey)) + '</h2>'
        + '<p>' + escapeHtml(globalize.translate(bodyKey)) + '</p>'
        + '</section>';
}

function renderDashboard(apiClient: ApiClient, user: UserDto, data: {
    libraries: BaseItemDto[];
    resumeItems: BaseItemDto[];
    nextUpItems: BaseItemDto[];
    latestItems: BaseItemDto[];
    state: HomeLoadState;
    images: HomeImageDescriptor[];
}): string {
    const { libraries, resumeItems, nextUpItems, latestItems, state, images } = data;
    let html = '<div class="tvHomeDashboard__content">';
    html += renderLoadState(state);
    html += renderLibrariesSection(libraries, user);
    html += renderRailSection(
        globalize.translate('HeaderContinueWatching'),
        globalize.translate('HomeContinueWatchingHint'),
        resumeItems,
        item => renderWideCard(item, getResumeSubtitle(item), images, { showProgress: true }),
        'resume'
    );
    html += renderRailSection(
        globalize.translate('NextUp'),
        globalize.translate('HomeNextUpHint'),
        nextUpItems,
        item => renderWideCard(item, getNextUpSubtitle(item), images, { badge: globalize.translate('NextUp').toLocaleUpperCase() }),
        'nextUp',
        renderSectionAction(globalize.translate('ViewAll'), appRouter.getRouteUrl('nextup', { serverId: apiClient.serverId() }))
    );
    html += renderRailSection(
        globalize.translate('RecentlyAdded'),
        globalize.translate('HomeRecentlyAddedHint'),
        latestItems,
        item => renderWideCard(item, getRecentlyAddedSubtitle(item), images),
        'latest'
    );
    html += '</div>';

    return html;
}

export function destroyTvHomeDashboard(elem: HTMLElement | null) {
    if (!elem) {
        return;
    }

    retireDashboardOwner(elem);
    elem.innerHTML = '';
    elem.classList.add('hide');
    setWithoutResumeHeroState(elem, false);
}

export function showUnavailableTvHomeDashboard(elem: HTMLElement | null) {
    if (!elem) return;
    retireDashboardOwner(elem);
    elem.innerHTML = renderLoadState('error');
    elem.classList.remove('hide', 'is-loading');
}

export function loadTvHomeDashboard(elem: HTMLElement | null, session: HomeSessionRead): Promise<void> {
    if (!elem) {
        return Promise.resolve();
    }

    session.assertCurrent();
    retireDashboardOwner(elem);
    const owner = new window['AbortController']();
    dashboardOwners.set(elem, owner);
    elem.classList.add('is-loading');

    return getUserViews(session)
        .then(libraries => {
            session.assertCurrent();
            assertDashboardOwner(elem, owner);
            return Promise.allSettled([
                getResumeItems(session),
                getNextUpItems(session),
                getLatestItems(session, libraries)
            ]).then(([resumeItems, nextUpItems, latestItems]) => {
                session.assertCurrent();
                assertDashboardOwner(elem, owner);
                throwIfSessionCancelled([ resumeItems, nextUpItems, latestItems ]);
                const latestSection = latestItems.status === 'fulfilled' ? latestItems.value : {
                    items: [],
                    status: 'rejected' as const
                };

                return {
                    user: session.user,
                    libraries,
                    sectionStatuses: [ resumeItems.status, nextUpItems.status, latestSection.status ],
                    resumeItems: getSettledItems(resumeItems),
                    nextUpItems: getSettledItems(nextUpItems),
                    latestItems: latestSection.items
                };
            });
        })
        .then(({ user, libraries, sectionStatuses, resumeItems, nextUpItems, latestItems }) => {
            session.assertCurrent();
            assertDashboardOwner(elem, owner);
            const hasMedia = Boolean(resumeItems.length || nextUpItems.length || latestItems.length);
            const loadState = getHomeLoadState(Boolean(getVisibleLibraries(libraries).length), sectionStatuses, hasMedia);
            const images: HomeImageDescriptor[] = [];
            elem.innerHTML = renderDashboard(session.apiClient, user, {
                libraries, resumeItems, nextUpItems, latestItems, state: loadState, images
            });
            setWithoutResumeHeroState(elem, !resumeItems.length);
            elem.classList.remove('hide');
            elem.classList.remove('is-loading');

            elem.querySelectorAll<HTMLImageElement>('.tvHomeMediaCard__image[data-home-image-index]').forEach(image => {
                const index = Number(image.dataset.homeImageIndex);
                const descriptor = images[index];
                if (!descriptor) return;
                session.images.add(image, descriptor, () => {
                    const placeholder = document.createElement('span');
                    placeholder.className = 'tvHomeMediaCard__placeholder material-icons movie';
                    placeholder.setAttribute('aria-hidden', 'true');
                    image.replaceWith(placeholder);
                });
            });

            elem.querySelector('.btnTvHomeManageLibraries')?.addEventListener('click', () => {
                try {
                    session.assertCurrent();
                    assertDashboardOwner(elem, owner);
                    void Dashboard.navigate('dashboard/libraries');
                } catch (error) {
                    if (!(error instanceof CancelledError)) throw error;
                }
            });

            void populateLibraryCounts(elem, owner, session, libraries);
        })
        .catch(err => {
            if (err instanceof CancelledError) throw err;
            session.assertCurrent();
            assertDashboardOwner(elem, owner);
            showUnavailableTvHomeDashboard(elem);
            console.error('Failed to load TV Home dashboard.');
        });
}

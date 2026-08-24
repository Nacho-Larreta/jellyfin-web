import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { UserDto } from '@jellyfin/sdk/lib/generated-client/models/user-dto';
import escapeHtml from 'escape-html';
import type { ApiClient } from 'jellyfin-apiclient';

import { appRouter } from 'components/router/appRouter';
import { JellyflixCollectionType, isAdultVideosCollectionType } from 'constants/jellyflixCollectionTypes';
import { getUserViewsQuery } from 'hooks/useUserViews';
import Dashboard from 'utils/dashboard';
import { getItemBackdropImageUrl } from 'utils/jellyfin-apiclient/backdropImage';
import { toApi } from 'utils/jellyfin-apiclient/compat';
import { queryClient } from 'utils/query/queryClient';
import globalize from 'lib/globalize';
import {
    aggregateHomeSectionResults,
    getHomeLoadState,
    type HomeLoadState,
    type HomeSectionAggregation
} from './homeLoadState';

const TV_HOME_FIELDS = [
    'PrimaryImageAspectRatio',
    'Overview',
    'ProductionYear',
    'RunTimeTicks',
    'OfficialRating',
    'CommunityRating',
    'DateCreated',
    'ParentId',
    'ParentIndexNumber',
    'IndexNumber',
    'SeriesName',
    'ParentBackdropItemId',
    'ParentBackdropImageTags',
    'ParentPrimaryImageItemId',
    'ParentPrimaryImageTag',
    'SeriesPrimaryImageTag',
    'MediaSourceCount'
].join(',');

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

type LibraryTone = 'red' | 'blue' | 'purple' | 'green' | 'orange' | 'gray';

type LibraryViewModel = {
    item: BaseItemDto;
    name: string;
    count?: number;
    icon: string;
    tone: LibraryTone;
    adult: boolean;
};

function getCurrentUser(apiClient: ApiClient): Promise<UserDto> {
    return apiClient.getCurrentUser();
}

function getUserViews(apiClient: ApiClient, userId: string): Promise<BaseItemDto[]> {
    return queryClient
        .fetchQuery(getUserViewsQuery(toApi(apiClient), userId))
        .then(result => result.Items || []);
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
            count: item.ChildCount ?? undefined,
            icon: 'lock',
            tone: 'orange',
            adult: true
        };
    }

    if (collectionType === 'movies') {
        return {
            item,
            name,
            count: item.ChildCount ?? undefined,
            icon: 'local_movies',
            tone: 'red',
            adult: false
        };
    }

    if (collectionType === 'tvshows') {
        return {
            item,
            name,
            count: item.ChildCount ?? undefined,
            icon: 'live_tv',
            tone: 'blue',
            adult: false
        };
    }

    if (collectionType === 'boxsets') {
        return {
            item,
            name,
            count: item.ChildCount ?? undefined,
            icon: 'collections',
            tone: 'green',
            adult: false
        };
    }

    if (collectionType === JellyflixCollectionType.Courses || collectionType === 'homevideos' || name.toLowerCase().includes('curso')) {
        return {
            item,
            name,
            count: item.ChildCount ?? undefined,
            icon: 'school',
            tone: 'purple',
            adult: false
        };
    }

    return {
        item,
        name,
        count: item.ChildCount ?? undefined,
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

function getWideImageUrl(apiClient: ApiClient, item: BaseItemDto): string | undefined {
    const backdropUrl = getItemBackdropImageUrl(apiClient, item, {
        fillWidth: 640,
        fillHeight: 360,
        quality: 84
    });

    if (backdropUrl) {
        return backdropUrl;
    }

    if (item.Id && item.ImageTags?.Thumb) {
        return apiClient.getScaledImageUrl(item.Id, {
            type: ImageType.Thumb,
            tag: item.ImageTags.Thumb,
            fillWidth: 640,
            fillHeight: 360,
            quality: 84
        });
    }

    if (item.Id && item.ImageTags?.Primary) {
        return apiClient.getScaledImageUrl(item.Id, {
            type: ImageType.Primary,
            tag: item.ImageTags.Primary,
            fillWidth: 640,
            fillHeight: 360,
            quality: 84
        });
    }

    return undefined;
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

        if (library.count != null) {
            html += '<span class="tvHomeLibraryChip__count">' + library.count + '</span>';
        }

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

function renderWideCard(apiClient: ApiClient, item: BaseItemDto, subtitle: string, options: {
    badge?: string;
    showProgress?: boolean;
} = {}): string {
    const href = appRouter.getRouteUrl(item);
    const imageUrl = getWideImageUrl(apiClient, item);
    const title = getDisplayTitle(item);
    const progressPercent = options.showProgress ? getProgressPercent(item) : 0;

    let html = '<a is="emby-linkbutton" class="tvHomeMediaCard" href="' + escapeHtml(href) + '">';
    html += '<span class="tvHomeMediaCard__imageFrame">';

    if (imageUrl) {
        html += '<img class="tvHomeMediaCard__image" src="' + escapeHtml(imageUrl) + '" alt="" loading="lazy" />';
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
    apiClient: ApiClient,
    title: string,
    subtitle: string,
    items: BaseItemDto[],
    cardRenderer: (apiClient: ApiClient, item: BaseItemDto) => string,
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
    html += items.map(item => cardRenderer(apiClient, item)).join('');
    html += '</div>';
    html += '</div>';
    html += '</section>';

    return html;
}

function getResumeItems(apiClient: ApiClient): Promise<BaseItemDto[]> {
    return apiClient.getResumableItems(apiClient.getCurrentUserId(), {
        Limit: 12,
        Recursive: true,
        Fields: TV_HOME_FIELDS,
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary,Backdrop,Thumb',
        EnableTotalRecordCount: false,
        MediaTypes: 'Video'
    }).then(result => result.Items || []);
}

function getNextUpItems(apiClient: ApiClient): Promise<BaseItemDto[]> {
    const oldestDateForNextUp = new Date();
    oldestDateForNextUp.setDate(oldestDateForNextUp.getDate() - 365);

    return apiClient.getNextUpEpisodes({
        Limit: 12,
        Fields: TV_HOME_FIELDS,
        UserId: apiClient.getCurrentUserId(),
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary,Backdrop,Banner,Thumb',
        EnableTotalRecordCount: false,
        NextUpDateCutoff: oldestDateForNextUp.toISOString(),
        EnableResumable: false,
        EnableRewatching: true
    }).then(result => result.Items || []);
}

function getLatestItems(apiClient: ApiClient, libraries: BaseItemDto[], user: UserDto): Promise<HomeSectionAggregation<BaseItemDto>> {
    const excludedIds = new Set(user.Configuration?.LatestItemsExcludes || []);
    const eligibleLibraries = libraries.filter(item => {
        if (!item.Id || excludedIds.has(item.Id)) {
            return false;
        }

        return !RECENT_LIBRARY_EXCLUDES.has((item.CollectionType || '').toLowerCase());
    });

    return Promise.allSettled(eligibleLibraries.map(library => apiClient.getLatestItems({
        Limit: 8,
        Fields: TV_HOME_FIELDS,
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary,Backdrop,Thumb',
        ParentId: library.Id
    })))
        .then(aggregateHomeSectionResults)
        .then(({ items, status }) => {
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

function getSettledItems(result: PromiseSettledResult<BaseItemDto[]>): BaseItemDto[] {
    return result.status === 'fulfilled' ? result.value : [];
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

function renderDashboard(apiClient: ApiClient, user: UserDto, libraries: BaseItemDto[], resumeItems: BaseItemDto[], nextUpItems: BaseItemDto[], latestItems: BaseItemDto[], state: HomeLoadState): string {
    let html = '<div class="tvHomeDashboard__content">';
    html += renderLoadState(state);
    html += renderLibrariesSection(libraries, user);
    html += renderRailSection(
        apiClient,
        globalize.translate('HeaderContinueWatching'),
        globalize.translate('HomeContinueWatchingHint'),
        resumeItems,
        (client, item) => renderWideCard(client, item, getResumeSubtitle(item), { showProgress: true }),
        'resume'
    );
    html += renderRailSection(
        apiClient,
        globalize.translate('NextUp'),
        globalize.translate('HomeNextUpHint'),
        nextUpItems,
        (client, item) => renderWideCard(client, item, getNextUpSubtitle(item), { badge: globalize.translate('NextUp').toLocaleUpperCase() }),
        'nextUp',
        renderSectionAction(globalize.translate('ViewAll'), appRouter.getRouteUrl('nextup', { serverId: apiClient.serverId() }))
    );
    html += renderRailSection(
        apiClient,
        globalize.translate('RecentlyAdded'),
        globalize.translate('HomeRecentlyAddedHint'),
        latestItems,
        (client, item) => renderWideCard(client, item, getRecentlyAddedSubtitle(item)),
        'latest'
    );
    html += '</div>';

    return html;
}

export function destroyTvHomeDashboard(elem: HTMLElement | null) {
    if (!elem) {
        return;
    }

    elem.innerHTML = '';
    elem.classList.add('hide');
    setWithoutResumeHeroState(elem, false);
}

export function loadTvHomeDashboard(elem: HTMLElement | null, apiClient: ApiClient): Promise<void> {
    if (!elem) {
        return Promise.resolve();
    }

    elem.classList.add('is-loading');

    return getCurrentUser(apiClient)
        .then(user => Promise.all([
            Promise.resolve(user),
            getUserViews(apiClient, user.Id || apiClient.getCurrentUserId())
        ]))
        .then(([user, libraries]) => Promise.allSettled([
            getResumeItems(apiClient),
            getNextUpItems(apiClient),
            getLatestItems(apiClient, libraries, user)
        ]).then(([resumeItems, nextUpItems, latestItems]) => {
            const latestSection = latestItems.status === 'fulfilled' ? latestItems.value : {
                items: [],
                status: 'rejected' as const
            };

            return {
                user,
                libraries,
                sectionStatuses: [ resumeItems.status, nextUpItems.status, latestSection.status ],
                resumeItems: getSettledItems(resumeItems),
                nextUpItems: getSettledItems(nextUpItems),
                latestItems: latestSection.items
            };
        }))
        .then(({ user, libraries, sectionStatuses, resumeItems, nextUpItems, latestItems }) => {
            const hasMedia = Boolean(resumeItems.length || nextUpItems.length || latestItems.length);
            const loadState = getHomeLoadState(Boolean(getVisibleLibraries(libraries).length), sectionStatuses, hasMedia);
            elem.innerHTML = renderDashboard(apiClient, user, libraries, resumeItems, nextUpItems, latestItems, loadState);
            setWithoutResumeHeroState(elem, !resumeItems.length);
            elem.classList.remove('hide');
            elem.classList.remove('is-loading');

            elem.querySelector('.btnTvHomeManageLibraries')?.addEventListener('click', () => {
                void Dashboard.navigate('dashboard/libraries');
            });
        })
        .catch(err => {
            elem.innerHTML = renderLoadState('error');
            elem.classList.remove('hide');
            elem.classList.remove('is-loading');
            console.error('Failed to load TV Home dashboard.', err);
        });
}

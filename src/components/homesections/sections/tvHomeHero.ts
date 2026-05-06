import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { ApiClient } from 'jellyfin-apiclient';
import escapeHtml from 'escape-html';

import { playbackManager } from 'components/playback/playbackmanager';
import { appRouter } from 'components/router/appRouter';
import datetime from 'scripts/datetime';
import globalize from 'lib/globalize';
import { getItemBackdropImageUrl } from 'utils/jellyfin-apiclient/backdropImage';

const RESUME_HERO_FIELDS = [
    'PrimaryImageAspectRatio',
    'Overview',
    'Genres',
    'ProductionYear',
    'RunTimeTicks',
    'OfficialRating',
    'CommunityRating',
    'ParentId',
    'MediaSourceCount'
].join(',');

function getResumeItem(apiClient: ApiClient): Promise<BaseItemDto | undefined> {
    return apiClient.getResumableItems(apiClient.getCurrentUserId(), {
        Limit: 1,
        Recursive: true,
        Fields: RESUME_HERO_FIELDS,
        ImageTypeLimit: 1,
        EnableImageTypes: 'Primary,Backdrop,Thumb',
        EnableTotalRecordCount: false,
        MediaTypes: 'Video'
    }).then(result => result.Items?.[0]);
}

function getPrimaryImageUrl(apiClient: ApiClient, item: BaseItemDto): string | undefined {
    if (item.Id && item.ImageTags?.Primary) {
        return apiClient.getScaledImageUrl(item.Id, {
            type: ImageType.Primary,
            tag: item.ImageTags.Primary,
            maxHeight: 520,
            quality: 90
        });
    }

    if (item.SeriesId && item.SeriesPrimaryImageTag) {
        return apiClient.getScaledImageUrl(item.SeriesId, {
            type: ImageType.Primary,
            tag: item.SeriesPrimaryImageTag,
            maxHeight: 520,
            quality: 90
        });
    }

    if (item.ParentPrimaryImageItemId && item.ParentPrimaryImageTag) {
        return apiClient.getScaledImageUrl(item.ParentPrimaryImageItemId, {
            type: ImageType.Primary,
            tag: item.ParentPrimaryImageTag,
            maxHeight: 520,
            quality: 90
        });
    }

    return undefined;
}

function getHeroTitle(item: BaseItemDto): string {
    if (item.Type === 'Episode' && item.SeriesName) {
        return item.SeriesName;
    }

    return item.Name || '';
}

function getEpisodeLabel(item: BaseItemDto): string | undefined {
    if (item.Type !== 'Episode') {
        return undefined;
    }

    const parts = [];
    if (item.ParentIndexNumber != null) {
        parts.push(`S${String(item.ParentIndexNumber).padStart(2, '0')}`);
    }

    if (item.IndexNumber != null) {
        parts.push(`E${String(item.IndexNumber).padStart(2, '0')}`);
    }

    if (item.Name) {
        parts.push(item.Name);
    }

    return parts.join(' - ') || undefined;
}

function getEpisodeCode(item: BaseItemDto): string | undefined {
    if (item.Type !== 'Episode') {
        return undefined;
    }

    const parts = [];

    if (item.ParentIndexNumber != null) {
        parts.push(`S${item.ParentIndexNumber}`);
    }

    if (item.IndexNumber != null) {
        parts.push(`E${item.IndexNumber}`);
    }

    return parts.join('·') || undefined;
}

function getRemainingLabel(item: BaseItemDto): string | undefined {
    const playbackTicks = item.UserData?.PlaybackPositionTicks || 0;
    const runtimeTicks = item.RunTimeTicks || 0;

    if (!playbackTicks || !runtimeTicks || playbackTicks >= runtimeTicks) {
        return undefined;
    }

    const ticksPerMinute = 600000000;
    const minutes = Math.max(1, Math.ceil((runtimeTicks - playbackTicks) / ticksPerMinute));

    return `${minutes} min restantes`;
}

function getMetadataHtml(item: BaseItemDto): string {
    let html = '';

    if (item.CommunityRating) {
        html += '<span class="tvHomeHero__metadataItem tvHomeHero__metadataItem--match">' + item.CommunityRating.toFixed(1) + '/10</span>';
    }

    if (item.ProductionYear) {
        html += '<span class="tvHomeHero__metadataItem">' + item.ProductionYear + '</span>';
    }

    if (item.OfficialRating) {
        html += '<span class="tvHomeHero__metadataItem tvHomeHero__metadataItem--chip">' + escapeHtml(item.OfficialRating) + '</span>';
    }

    if (item.RunTimeTicks) {
        html += '<span class="tvHomeHero__metadataItem">' + escapeHtml(datetime.getDisplayDuration(item.RunTimeTicks)) + '</span>';
    }

    if (item.MediaSourceCount && item.MediaSourceCount > 1) {
        html += '<span class="tvHomeHero__metadataItem tvHomeHero__metadataItem--chip">' + item.MediaSourceCount + ' versiones</span>';
    }

    return html;
}

function getProgressPercent(item: BaseItemDto): number {
    const playbackTicks = item.UserData?.PlaybackPositionTicks || 0;
    const runtimeTicks = item.RunTimeTicks || 0;

    if (!playbackTicks || !runtimeTicks) {
        return 0;
    }

    return Math.min(100, Math.max(0, Math.round((playbackTicks / runtimeTicks) * 100)));
}

function getPlayableItemId(item: BaseItemDto): string | undefined {
    return item.Type === 'Program' ? item.ChannelId || undefined : item.Id || undefined;
}

function playItem(item: BaseItemDto, serverId: string) {
    const playableItemId = getPlayableItemId(item);
    if (!playableItemId) {
        return;
    }

    void playbackManager.play({
        ids: [playableItemId],
        startPositionTicks: item.UserData?.PlaybackPositionTicks || undefined,
        serverId
    });
}

function getHeroHtml(apiClient: ApiClient, item: BaseItemDto): string {
    const backdropUrl = getItemBackdropImageUrl(apiClient, item, {
        fillWidth: 1920,
        fillHeight: 1080,
        quality: 88
    });
    const primaryUrl = getPrimaryImageUrl(apiClient, item);
    const title = getHeroTitle(item);
    const episodeLabel = getEpisodeLabel(item);
    const episodeCode = getEpisodeCode(item);
    const metadataHtml = getMetadataHtml(item);
    const progressPercent = getProgressPercent(item);
    const remainingLabel = getRemainingLabel(item);
    const overview = item.Overview || '';
    const detailsUrl = appRouter.getRouteUrl(item);

    let html = '<section class="tvHomeHero__shell" aria-label="' + escapeHtml(globalize.translate('HeaderContinueWatching')) + '">';

    if (backdropUrl) {
        html += '<img class="tvHomeHero__backdrop" src="' + escapeHtml(backdropUrl) + '" alt="" loading="eager" />';
    }

    html += '<div class="tvHomeHero__shade tvHomeHero__shade--side"></div>';
    html += '<div class="tvHomeHero__shade tvHomeHero__shade--bottom"></div>';

    html += '<div class="tvHomeHero__content">';
    html += '<div class="tvHomeHero__eyebrow"><span class="tvHomeHero__eyebrowDot"></span><span>' + escapeHtml(globalize.translate('HeaderContinueWatching')) + '</span></div>';
    html += '<h1 class="tvHomeHero__title">' + escapeHtml(title) + '</h1>';

    if (metadataHtml) {
        html += '<div class="tvHomeHero__metadata">' + metadataHtml + '</div>';
    }

    if (episodeLabel) {
        html += '<div class="tvHomeHero__episode">' + escapeHtml(episodeLabel) + '</div>';
    }

    if (overview) {
        html += '<p class="tvHomeHero__overview">' + escapeHtml(overview) + '</p>';
    }

    html += '<div class="tvHomeHero__progressGroup">';
    html += '<progress class="tvHomeHero__progress" max="100" value="' + progressPercent + '" aria-label="' + escapeHtml(globalize.translate('Played')) + '"></progress>';
    html += '<span class="tvHomeHero__progressText">' + escapeHtml(remainingLabel || `${progressPercent}%`) + '</span>';
    html += '</div>';

    html += '<div class="tvHomeHero__actions">';
    html += '<button is="emby-button" type="button" class="tvHomeHero__button tvHomeHero__button--primary btnTvHomeHeroPlay">';
    html += '<span class="material-icons play_arrow" aria-hidden="true"></span>';
    html += '<span>' + escapeHtml(globalize.translate(item.UserData?.PlaybackPositionTicks ? 'ButtonResume' : 'Play')) + '</span>';
    html += '</button>';
    html += '<a is="emby-linkbutton" class="tvHomeHero__button tvHomeHero__button--secondary" href="' + escapeHtml(detailsUrl) + '">';
    html += '<span class="material-icons info_outline" aria-hidden="true"></span>';
    html += '<span>' + escapeHtml(globalize.translate('ButtonInfo')) + '</span>';
    html += '</a>';
    html += '</div>';
    html += '</div>';

    if (primaryUrl) {
        html += '<div class="tvHomeHero__posterFrame">';
        html += '<img class="tvHomeHero__poster" src="' + escapeHtml(primaryUrl) + '" alt="" loading="eager" />';
        html += '</div>';
    }

    if (episodeCode) {
        html += '<div class="tvHomeHero__libraryTag">En tu biblioteca · ' + escapeHtml(episodeCode) + '</div>';
    }

    html += '</section>';

    return html;
}

export function destroyTvHomeHero(elem: HTMLElement) {
    elem.innerHTML = '';
    elem.classList.add('hide');
}

export function loadTvHomeHero(elem: HTMLElement | null, apiClient: ApiClient): Promise<void> {
    if (!elem) {
        return Promise.resolve();
    }

    return getResumeItem(apiClient)
        .then(item => {
            if (!item) {
                destroyTvHomeHero(elem);
                return;
            }

            elem.innerHTML = getHeroHtml(apiClient, item);
            elem.classList.remove('hide');

            const playButton = elem.querySelector('.btnTvHomeHeroPlay');
            playButton?.addEventListener('click', () => {
                playItem(item, apiClient.serverId());
            });
        })
        .catch(err => {
            console.error('[tvHomeHero] Failed to load resume hero', err);
            destroyTvHomeHero(elem);
        });
}

import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { CardShape } from 'components/cardbuilder/utils/shape';
import { Section } from '../types';
import { CardOptions } from 'types/cardOptions';
import { LIVETV_CARD_OPTIONS } from '../constants/liveTvCardOptions';
import { SEARCH_SECTIONS_SORT_ORDER } from '../constants/sectionSortOrder';
import type { ApiClient } from 'jellyfin-apiclient';

interface SearchImageOptions {
    fillWidth?: number;
    fillHeight?: number;
    quality?: number;
}

export const isMovies = (collectionType: string) =>
    collectionType === CollectionType.Movies;

export const isTVShows = (collectionType: string) =>
    collectionType === CollectionType.Tvshows;

export const isMusic = (collectionType: string) =>
    collectionType === CollectionType.Music;

export const isLivetv = (collectionType: string) =>
    collectionType === CollectionType.Livetv;

export function addSection(
    sections: Section[],
    title: string,
    items: BaseItemDto[] | null | undefined,
    cardOptions?: CardOptions
) {
    if (items && items?.length > 0) {
        sections.push({ title, items, cardOptions });
    }
}

export function sortSections(sections: Section[]) {
    return sections.sort((a, b) => {
        const indexA = SEARCH_SECTIONS_SORT_ORDER.indexOf(a.title);
        const indexB = SEARCH_SECTIONS_SORT_ORDER.indexOf(b.title);

        if (indexA > indexB) {
            return 1;
        } else if (indexA < indexB) {
            return -1;
        } else {
            return 0;
        }
    });
}

export function getCardOptionsFromType(type: BaseItemKind) {
    switch (type) {
        case BaseItemKind.Movie:
        case BaseItemKind.Series:
        case BaseItemKind.MusicAlbum:
            return {
                showYear: true
            };
        case BaseItemKind.Episode:
            return {
                coverImage: true,
                showParentTitle: true
            };
        case BaseItemKind.MusicArtist:
            return {
                coverImage: true
            };
        case BaseItemKind.Audio:
            return {
                showParentTitle: true,
                shape: CardShape.SquareOverflow
            };
        case BaseItemKind.LiveTvProgram:
            return LIVETV_CARD_OPTIONS;
        default:
            return {};
    }
}

export function getTitleFromType(type: BaseItemKind) {
    switch (type) {
        case BaseItemKind.Movie:
            return 'Movies';
        case BaseItemKind.Series:
            return 'Shows';
        case BaseItemKind.Episode:
            return 'Episodes';
        case BaseItemKind.Playlist:
            return 'Playlists';
        case BaseItemKind.MusicAlbum:
            return 'Albums';
        case BaseItemKind.Audio:
            return 'Songs';
        case BaseItemKind.LiveTvProgram:
            return 'Programs';
        case BaseItemKind.TvChannel:
            return 'Channels';
        case BaseItemKind.PhotoAlbum:
            return 'HeaderPhotoAlbums';
        case BaseItemKind.Photo:
            return 'Photos';
        case BaseItemKind.AudioBook:
            return 'HeaderAudioBooks';
        case BaseItemKind.Book:
            return 'Books';
        case BaseItemKind.BoxSet:
            return 'Collections';
        default:
            return '';
    }
}

export function getItemTypesFromCollectionType(collectionType: CollectionType | undefined) {
    switch (collectionType) {
        case CollectionType.Movies:
            return [ BaseItemKind.Movie ];
        case CollectionType.Tvshows:
            return [
                BaseItemKind.Series,
                BaseItemKind.Episode
            ];
        case CollectionType.Music:
            return [
                BaseItemKind.Playlist,
                BaseItemKind.MusicAlbum,
                BaseItemKind.Audio
            ];
        default:
            return [
                BaseItemKind.Movie,
                BaseItemKind.Series,
                BaseItemKind.Episode,
                BaseItemKind.Playlist,
                BaseItemKind.MusicAlbum,
                BaseItemKind.Audio,
                BaseItemKind.TvChannel,
                BaseItemKind.PhotoAlbum,
                BaseItemKind.Photo,
                BaseItemKind.AudioBook,
                BaseItemKind.Book,
                BaseItemKind.BoxSet
            ];
    }
}

export function getSearchItemImageUrl(
    apiClient: ApiClient | undefined,
    item: BaseItemDto,
    options: SearchImageOptions = {}
) {
    if (!apiClient) return undefined;

    if (item.Id && item.ImageTags?.Primary) {
        return apiClient.getScaledImageUrl(item.Id, {
            type: ImageType.Primary,
            tag: item.ImageTags.Primary,
            quality: 96,
            ...options
        });
    }

    if (item.SeriesId && item.SeriesPrimaryImageTag) {
        return apiClient.getScaledImageUrl(item.SeriesId, {
            type: ImageType.Primary,
            tag: item.SeriesPrimaryImageTag,
            quality: 96,
            ...options
        });
    }

    if (item.ParentPrimaryImageItemId && item.ParentPrimaryImageTag) {
        return apiClient.getScaledImageUrl(item.ParentPrimaryImageItemId, {
            type: ImageType.Primary,
            tag: item.ParentPrimaryImageTag,
            quality: 96,
            ...options
        });
    }

    if (item.AlbumId && item.AlbumPrimaryImageTag) {
        return apiClient.getScaledImageUrl(item.AlbumId, {
            type: ImageType.Primary,
            tag: item.AlbumPrimaryImageTag,
            quality: 96,
            ...options
        });
    }

    return undefined;
}

export function getSearchItemInitials(item: BaseItemDto) {
    return (item.Name || '?')
        .split(' ')
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0]?.toUpperCase())
        .join('');
}

export function getSearchItemTypeLabel(item: BaseItemDto) {
    switch (item.Type) {
        case BaseItemKind.Movie:
            return 'Película';
        case BaseItemKind.Series:
            return 'Series';
        case BaseItemKind.Episode:
            return 'Episodio';
        case BaseItemKind.Person:
            return 'Persona';
        case BaseItemKind.MusicAlbum:
            return 'Álbum';
        case BaseItemKind.Audio:
            return 'Canción';
        case BaseItemKind.MusicArtist:
            return 'Artista';
        case BaseItemKind.BoxSet:
            return 'Colección';
        case BaseItemKind.TvChannel:
            return 'Canal';
        default:
            return item.Type || 'Ítem';
    }
}

export function getSearchItemSubtitle(item: BaseItemDto) {
    const parts = [
        getSearchItemTypeLabel(item),
        item.ProductionYear,
        item.SeriesName,
        item.Album,
        item.Artists?.join(', ')
    ].filter(Boolean);

    return parts.join(' · ');
}

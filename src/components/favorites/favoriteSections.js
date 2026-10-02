import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';

import { getBackdropShape, getPortraitShape, getSquareShape } from 'components/cardbuilder/utils/shape';

const common = { showTitle: true, overlayPlayButton: true, overlayText: false, centerText: true };

export function getFavoriteSections() {
    const portrait = getPortraitShape(true);
    const backdrop = getBackdropShape(true);
    const square = getSquareShape(true);
    return [
        { ...common, name: 'Movies', types: 'Movie', shape: portrait, showYear: true },
        { ...common, name: 'Shows', types: 'Series', shape: portrait, showYear: true },
        { ...common, name: 'HeaderSeasons', types: BaseItemKind.Season, shape: portrait, showParentTitle: true },
        { ...common, name: 'Episodes', types: 'Episode', shape: backdrop, preferThumb: false, showParentTitle: true },
        { ...common, name: 'HeaderVideos', types: 'Video', shape: backdrop, preferThumb: true },
        { ...common, name: 'MusicVideos', types: 'MusicVideo', shape: backdrop, preferThumb: true },
        { ...common, name: 'Collections', types: 'BoxSet', shape: portrait },
        { ...common, name: 'Playlists', types: 'Playlist', shape: square, preferThumb: false, showParentTitle: false, coverImage: true },
        { ...common, name: 'People', types: 'Person', shape: portrait, preferThumb: false, showParentTitle: false, coverImage: true },
        { ...common, name: 'Artists', types: 'MusicArtist', shape: square, preferThumb: false, showParentTitle: false, coverImage: true },
        { ...common, name: 'Albums', types: 'MusicAlbum', shape: square, preferThumb: false, showParentTitle: true, coverImage: true },
        { ...common, name: 'Songs', types: 'Audio', shape: square, preferThumb: false, showParentTitle: true,
            overlayPlayButton: false, overlayMoreButton: true, action: 'instantmix', coverImage: true },
        { ...common, name: 'Books', types: 'Book', shape: portrait, showYear: true },
        { ...common, name: 'Channels', types: 'LiveTVChannel', shape: backdrop },
        { ...common, name: 'HeaderPhotoAlbums', types: 'PhotoAlbum', shape: backdrop },
        { ...common, name: 'Photos', types: 'Photo', shape: backdrop }
    ];
}

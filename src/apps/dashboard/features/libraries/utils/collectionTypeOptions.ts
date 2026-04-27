import globalize from 'lib/globalize';
import { JellyflixCollectionType } from 'constants/jellyflixCollectionTypes';

const getCollectionTypeOptions = () => {
    return [{
        name: '',
        value: ''
    }, {
        name: globalize.translate('Movies'),
        value: 'movies'
    }, {
        name: globalize.translate('TabMusic'),
        value: 'music'
    }, {
        name: globalize.translate('Shows'),
        value: 'tvshows'
    }, {
        name: globalize.translate('Books'),
        value: 'books'
    }, {
        name: globalize.translate('HomeVideosPhotos'),
        value: 'homevideos'
    }, {
        name: globalize.translate('MusicVideos'),
        value: 'musicvideos'
    }, {
        name: globalize.translate('Courses'),
        value: JellyflixCollectionType.Courses
    }, {
        name: globalize.translate('AdultVideos'),
        value: JellyflixCollectionType.AdultVideos
    }, {
        name: globalize.translate('MixedMoviesShows'),
        value: 'mixed'
    }];
};

export default getCollectionTypeOptions;

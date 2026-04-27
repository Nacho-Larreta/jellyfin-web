import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import React, { type FC } from 'react';
import useCurrentTab from 'hooks/useCurrentTab';
import Page from 'components/Page';
import PageTabContent from '../../components/library/PageTabContent';
import { JellyflixCollectionType } from 'constants/jellyflixCollectionTypes';
import { LibraryTab } from 'types/libraryTab';
import { LibraryTabContent, LibraryTabMapping } from 'types/libraryTabContent';

const videosTabContent: LibraryTabContent = {
    viewType: LibraryTab.Videos,
    collectionType: JellyflixCollectionType.Courses,
    isBtnPlayAllEnabled: true,
    isBtnShuffleEnabled: true,
    itemType: [BaseItemKind.Video]
};

const foldersTabContent: LibraryTabContent = {
    viewType: LibraryTab.Folders,
    collectionType: JellyflixCollectionType.Courses,
    isBtnPlayAllEnabled: true,
    isBtnShuffleEnabled: true,
    itemType: [BaseItemKind.Folder, BaseItemKind.Video]
};

const favoritesTabContent: LibraryTabContent = {
    viewType: LibraryTab.Favorites,
    collectionType: JellyflixCollectionType.Courses,
    itemType: [BaseItemKind.Video]
};

const genresTabContent: LibraryTabContent = {
    viewType: LibraryTab.Genres,
    collectionType: JellyflixCollectionType.Courses,
    itemType: [BaseItemKind.Video]
};

const coursesTabMapping: LibraryTabMapping = {
    0: videosTabContent,
    1: foldersTabContent,
    2: favoritesTabContent,
    3: genresTabContent
};

const Courses: FC = () => {
    const { libraryId, activeTab } = useCurrentTab();
    const currentTab = coursesTabMapping[activeTab] ?? coursesTabMapping[0];

    return (
        <Page
            id='courses'
            className='mainAnimatedPage libraryPage backdropPage collectionEditorPage pageWithAbsoluteTabs withTabs'
            backDropType='video'
        >
            <PageTabContent
                key={`${currentTab.viewType} - ${libraryId}`}
                currentTab={currentTab}
                parentId={libraryId}
            />
        </Page>
    );
};

export default Courses;

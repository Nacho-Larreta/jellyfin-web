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
    collectionType: JellyflixCollectionType.AdultVideos,
    isBtnPlayAllEnabled: true,
    isBtnShuffleEnabled: true,
    itemType: [BaseItemKind.Video]
};

const foldersTabContent: LibraryTabContent = {
    viewType: LibraryTab.Folders,
    collectionType: JellyflixCollectionType.AdultVideos,
    isBtnPlayAllEnabled: true,
    isBtnShuffleEnabled: true,
    itemType: [BaseItemKind.Folder, BaseItemKind.Video]
};

const favoritesTabContent: LibraryTabContent = {
    viewType: LibraryTab.Favorites,
    collectionType: JellyflixCollectionType.AdultVideos,
    itemType: [BaseItemKind.Video]
};

const adultVideosTabMapping: LibraryTabMapping = {
    0: videosTabContent,
    1: foldersTabContent,
    2: favoritesTabContent
};

const AdultVideos: FC = () => {
    const { libraryId, activeTab } = useCurrentTab();
    const currentTab = adultVideosTabMapping[activeTab] ?? adultVideosTabMapping[0];

    return (
        <Page
            id='adultvideos'
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

export default AdultVideos;

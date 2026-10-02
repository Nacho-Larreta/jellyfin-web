import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { useQuery } from '@tanstack/react-query';
import { useApi } from 'hooks/useApi';
import { type SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { addSection, isLivetv } from '../utils/search';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { LIVETV_CARD_OPTIONS } from '../constants/liveTvCardOptions';
import { CardShape } from 'components/cardbuilder/utils/shape';
import { Section } from '../types';
import { fetchItemsByType } from './fetchItemsByType';

const fetchLiveTv = (api: SessionScopedReadApi, userId: string | undefined, searchTerm: string | undefined, signal: AbortSignal) => {
    const sections: Section[] = [];

    // Movies row
    const movies = fetchItemsByType(
        api,
        userId,
        {
            includeItemTypes: [ BaseItemKind.LiveTvProgram ],
            isMovie: true,
            searchTerm
        },
        { signal }
    ).then(moviesData => {
        addSection(sections, 'Movies', moviesData.Items, {
            ...LIVETV_CARD_OPTIONS,
            shape: CardShape.PortraitOverflow
        });
    });

    // Episodes row
    const episodes = fetchItemsByType(
        api,
        userId,
        {
            includeItemTypes: [ BaseItemKind.LiveTvProgram ],
            isMovie: false,
            isSeries: true,
            isSports: false,
            isKids: false,
            isNews: false,
            searchTerm
        },
        { signal }
    ).then(episodesData => {
        addSection(sections, 'Episodes', episodesData.Items, {
            ...LIVETV_CARD_OPTIONS
        });
    });

    // Sports row
    const sports = fetchItemsByType(
        api,
        userId,
        {
            includeItemTypes: [ BaseItemKind.LiveTvProgram ],
            isSports: true,
            searchTerm
        },
        { signal }
    ).then(sportsData => {
        addSection(sections, 'Sports', sportsData.Items, {
            ...LIVETV_CARD_OPTIONS
        });
    });

    // Kids row
    const kids = fetchItemsByType(
        api,
        userId,
        {
            includeItemTypes: [ BaseItemKind.LiveTvProgram ],
            isKids: true,
            searchTerm
        },
        { signal }
    ).then(kidsData => {
        addSection(sections, 'Kids', kidsData.Items, {
            ...LIVETV_CARD_OPTIONS
        });
    });

    // News row
    const news = fetchItemsByType(
        api,
        userId,
        {
            includeItemTypes: [ BaseItemKind.LiveTvProgram ],
            isNews: true,
            searchTerm
        },
        { signal }
    ).then(newsData => {
        addSection(sections, 'News', newsData.Items, {
            ...LIVETV_CARD_OPTIONS
        });
    });

    // Programs row
    const programs = fetchItemsByType(
        api,
        userId,
        {
            includeItemTypes: [ BaseItemKind.LiveTvProgram ],
            isMovie: false,
            isSeries: false,
            isSports: false,
            isKids: false,
            isNews: false,
            searchTerm
        },
        { signal }
    ).then(programsData => {
        addSection(sections, 'Programs', programsData.Items, {
            ...LIVETV_CARD_OPTIONS
        });
    });

    // Channels row
    const channels = fetchItemsByType(
        api,
        userId,
        {
            includeItemTypes: [ BaseItemKind.TvChannel ],
            searchTerm
        },
        { signal }
    ).then(channelsData => {
        addSection(sections, 'Channels', channelsData.Items);
    });

    return Promise.all([ movies, episodes, sports, kids, news, programs, channels ]).then(() => sections);
};

export const useLiveTvSearch = (
    parentId?: string,
    collectionType?: CollectionType,
    searchTerm?: string
) => {
    const { sessionScopedReadApi, sessionQueryIdentity, user } = useApi();
    const api = sessionScopedReadApi;
    const userId = user?.Id;

    return useQuery({
        queryKey: ['Search', sessionQueryIdentity, 'LiveTv', collectionType, parentId, searchTerm],
        queryFn: async ({ signal }) => {
            const sections = await fetchLiveTv(api!, userId!, searchTerm, signal);
            sessionScopedReadApi!.assertCurrent();
            return sections;
        },
        enabled: !!api && !!sessionQueryIdentity && userId === sessionQueryIdentity.profileUserId
            && !!collectionType && !!isLivetv(collectionType)
    });
};

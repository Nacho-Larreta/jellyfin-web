import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import Button from '@mui/material/Button/Button';
import Icon from '@mui/material/Icon';
import { Theme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import React, { useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

import { MetaView } from 'apps/experimental/constants/metaView';
import { useAncestors } from 'apps/experimental/features/libraries/hooks/api/useAncestors';
import { isDetailsPath, isLibraryPath } from 'apps/experimental/features/libraries/utils/path';
import { appRouter } from 'components/router/appRouter';
import { JellyflixCollectionType } from 'constants/jellyflixCollectionTypes';
import { useApi } from 'hooks/useApi';
import useCurrentTab from 'hooks/useCurrentTab';
import { useUserViews } from 'hooks/useUserViews';
import { useWebConfig } from 'hooks/useWebConfig';
import globalize from 'lib/globalize';

const MAX_USER_VIEWS_MD = 3;
const MAX_USER_VIEWS_LG = 5;
const MAX_USER_VIEWS_XL = 8;

const HOME_PATH = '/home';
const LIST_PATH = '/list';
const PRIMARY_COLLECTION_TYPES = [
    CollectionType.Movies,
    CollectionType.Tvshows,
    JellyflixCollectionType.Courses,
    JellyflixCollectionType.AdultVideos
];

const getViewRoute = (view: BaseItemDto) => appRouter.getRouteUrl(view, { context: view.CollectionType }).substring(1);

const isCollectionView = (view: BaseItemDto, collectionType: string) => (
    view.CollectionType === collectionType
        || getViewRoute(view).includes(`collectionType=${collectionType}`)
);

const findCollectionView = (views: BaseItemDto[] | undefined, collectionType: string) => (
    views?.find(view => isCollectionView(view, collectionType))
);

const getRecentlyAddedRoute = (view: BaseItemDto | undefined) => {
    if (!view) return '/home';

    const route = getViewRoute(view);
    const separator = route.includes('?') ? '&' : '?';
    return `${route}${separator}tab=1`;
};

const getCurrentUserView = (
    userViews: BaseItemDto[] | undefined,
    pathname: string,
    libraryId: string | null,
    collectionType: string | null,
    tab: number
) => {
    const isUserViewPath = isDetailsPath(pathname) || isLibraryPath(pathname) || [HOME_PATH, LIST_PATH].includes(pathname);
    if (!isUserViewPath) return undefined;

    if (collectionType === CollectionType.Livetv) {
        return userViews?.find(({ CollectionType: type }) => type === CollectionType.Livetv);
    }

    if (pathname === HOME_PATH && tab === 1) {
        return MetaView.Favorites;
    }

    // eslint-disable-next-line sonarjs/different-types-comparison
    return userViews?.find(({ Id: id }) => id === libraryId);
};

const UserViewNav = () => {
    const location = useLocation();
    const [ searchParams ] = useSearchParams();
    const itemId = searchParams.get('id') || undefined;
    const libraryId = searchParams.get('topParentId') || searchParams.get('parentId');
    const collectionType = searchParams.get('collectionType');
    const { activeTab } = useCurrentTab();
    const webConfig = useWebConfig();

    const isExtraLargeScreen = useMediaQuery((t: Theme) => t.breakpoints.up('xl'));
    const isLargeScreen = useMediaQuery((t: Theme) => t.breakpoints.up('lg'));
    const maxViews = useMemo(() => {
        let _maxViews = MAX_USER_VIEWS_MD;
        if (isExtraLargeScreen) _maxViews = MAX_USER_VIEWS_XL;
        else if (isLargeScreen) _maxViews = MAX_USER_VIEWS_LG;

        const customLinks = (webConfig.menuLinks || []).length;

        return _maxViews - customLinks;
    }, [ isExtraLargeScreen, isLargeScreen, webConfig.menuLinks ]);

    const { user } = useApi();
    const {
        data: userViews,
        isPending
    } = useUserViews(user?.Id);

    const {
        data: ancestors
    } = useAncestors({ itemId });

    const ancestorLibraryId = useMemo(() => {
        return ancestors?.find(ancestor => ancestor.Type === BaseItemKind.CollectionFolder)?.Id || null;
    }, [ ancestors ]);

    const primaryViews = useMemo(() => (
        userViews?.Items?.slice(0, maxViews)
    ), [ maxViews, userViews ]);

    const moviesView = useMemo(() => (
        findCollectionView(primaryViews, CollectionType.Movies)
            || findCollectionView(userViews?.Items, CollectionType.Movies)
    ), [ primaryViews, userViews ]);

    const seriesView = useMemo(() => (
        findCollectionView(primaryViews, CollectionType.Tvshows)
            || findCollectionView(userViews?.Items, CollectionType.Tvshows)
    ), [ primaryViews, userViews ]);

    const coursesView = useMemo(() => (
        findCollectionView(primaryViews, JellyflixCollectionType.Courses)
            || findCollectionView(userViews?.Items, JellyflixCollectionType.Courses)
    ), [ primaryViews, userViews ]);

    const adultVideosView = useMemo(() => (
        findCollectionView(primaryViews, JellyflixCollectionType.AdultVideos)
            || findCollectionView(userViews?.Items, JellyflixCollectionType.AdultVideos)
    ), [ primaryViews, userViews ]);

    const currentUserView = useMemo(() => (
        getCurrentUserView(userViews?.Items, location.pathname, libraryId || ancestorLibraryId, collectionType, activeTab)
    ), [ activeTab, collectionType, libraryId, ancestorLibraryId, location.pathname, userViews ]);
    const isHomeActive = location.pathname === HOME_PATH && activeTab !== 1 && !currentUserView;
    const isMyListActive = currentUserView?.Id === MetaView.Favorites.Id;

    if (isPending) return null;

    return (
        <>
            <Button
                variant='text'
                color='inherit'
                className={isHomeActive ? 'jellyflixToolbarNavItemActive' : undefined}
                component={Link}
                to='/home'
            >
                {globalize.translate('Home')}
            </Button>

            {moviesView && (
                <Button
                    key={moviesView.Id}
                    variant='text'
                    color={(moviesView.Id === currentUserView?.Id) ? 'primary' : 'inherit'}
                    className={(moviesView.Id === currentUserView?.Id) ? 'jellyflixToolbarNavItemActive' : undefined}
                    component={Link}
                    to={getViewRoute(moviesView)}
                >
                    {globalize.translate('Movies')}
                </Button>
            )}

            {seriesView && (
                <Button
                    key={seriesView.Id}
                    variant='text'
                    color={(seriesView.Id === currentUserView?.Id) ? 'primary' : 'inherit'}
                    className={(seriesView.Id === currentUserView?.Id) ? 'jellyflixToolbarNavItemActive' : undefined}
                    component={Link}
                    to={getViewRoute(seriesView)}
                >
                    {globalize.translate('Series')}
                </Button>
            )}

            {coursesView && (
                <Button
                    key={coursesView.Id}
                    variant='text'
                    color={(coursesView.Id === currentUserView?.Id) ? 'primary' : 'inherit'}
                    className={(coursesView.Id === currentUserView?.Id) ? 'jellyflixToolbarNavItemActive' : undefined}
                    component={Link}
                    to={getViewRoute(coursesView)}
                >
                    {globalize.translate('Courses')}
                </Button>
            )}

            {adultVideosView && (
                <Button
                    key={adultVideosView.Id}
                    variant='text'
                    color={(adultVideosView.Id === currentUserView?.Id) ? 'primary' : 'inherit'}
                    className={(adultVideosView.Id === currentUserView?.Id) ? 'jellyflixToolbarNavItemActive' : undefined}
                    component={Link}
                    to={getViewRoute(adultVideosView)}
                >
                    {globalize.translate('AdultVideos')}
                </Button>
            )}

            <Button
                variant='text'
                color={isMyListActive ? 'primary' : 'inherit'}
                className={isMyListActive ? 'jellyflixToolbarNavItemActive' : undefined}
                component={Link}
                to='/home?tab=1'
            >
                Mi lista
            </Button>

            <Button
                variant='text'
                color='inherit'
                component={Link}
                to={getRecentlyAddedRoute(moviesView || seriesView)}
            >
                Recién agregado
            </Button>

            {webConfig.menuLinks?.map(link => (
                <Button
                    key={link.name}
                    variant='text'
                    color='inherit'
                    startIcon={<Icon>{link.icon || 'link'}</Icon>}
                    component='a'
                    href={link.url}
                    target='_blank'
                    rel='noopener noreferrer'
                >
                    {link.name}
                </Button>
            ))}
            {primaryViews?.filter(view => (
                !PRIMARY_COLLECTION_TYPES.some(primaryCollectionType => isCollectionView(view, primaryCollectionType))
            )).map(link => (
                <Button
                    key={link.Id}
                    variant='text'
                    color='inherit'
                    component={Link}
                    to={getViewRoute(link)}
                    sx={{ display: { xs: 'none', xl: 'inline-flex' } }}
                >
                    {link.Name}
                </Button>
            ))}
        </>
    );
};

export default UserViewNav;

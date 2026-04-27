import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import globalize from '../../../../lib/globalize';
import confirm from '../../../../components/confirm/confirm';
import UserCardBox from '../../../../components/dashboard/users/UserCardBox';
import SectionTitleContainer from '../../../../elements/SectionTitleContainer';
import '../../../../elements/emby-button/emby-button';
import '../../../../elements/emby-button/paper-icon-button-light';
import '../../../../components/cardbuilder/card.scss';
import '../../../../components/indicators/indicators.scss';
import '../../../../styles/flexstyles.scss';
import Page from '../../../../components/Page';
import { useLocation, useNavigate } from 'react-router-dom';
import Toast from 'apps/dashboard/components/Toast';
import { useUsers } from 'hooks/useUsers';
import Loading from 'components/loading/LoadingComponent';
import { useDeleteUser } from 'apps/dashboard/features/users/api/useDeleteUser';
import dom from 'utils/dom';
import { UserTab } from 'apps/dashboard/features/users/constants/userTab';
import { useApi } from 'hooks/useApi';
import { getSecondaryProfileUserIds } from 'lib/profileSelector/api';

type MenuEntry = {
    name?: string;
    id?: string;
    icon?: string;
};

const normalizeUserId = (userId?: string | null) => (userId || '').replace(/-/g, '').toLowerCase();

const UserProfiles = () => {
    const location = useLocation();
    const [ isSettingsSavedToastOpen, setIsSettingsSavedToastOpen ] = useState(false);
    const element = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();
    const { __legacyApiClient__ } = useApi();
    const { data: users, isPending } = useUsers();
    const {
        data: secondaryProfileUserIds = [],
        isPending: isSecondaryProfileUserIdsPending
    } = useQuery({
        queryKey: [ 'ProfileSelectors', 'SecondaryProfileUserIds', __legacyApiClient__?.serverId() ],
        queryFn: () => getSecondaryProfileUserIds(__legacyApiClient__!),
        enabled: !!__legacyApiClient__
    });
    const deleteUser = useDeleteUser();

    const handleToastClose = useCallback(() => {
        setIsSettingsSavedToastOpen(false);
    }, []);

    const confirmDeleteUser = useCallback((id: string, username?: string | null) => {
        const title = username ? globalize.translate('DeleteName', username) : globalize.translate('DeleteUser');
        const text = globalize.translate('DeleteUserConfirmation');

        confirm({
            title,
            text,
            confirmText: globalize.translate('Delete'),
            primary: 'delete'
        }).then(function () {
            deleteUser.mutate({
                userId: id
            });
        }).catch(() => {
            // confirm dialog closed
        });
    }, [ deleteUser ]);

    const handleUserMenuAction = useCallback((id: string, userId: string, username?: string | null) => {
        switch (id) {
            case 'open':
                navigate(`/dashboard/users/${userId}/${UserTab.Profile}`);
                break;

            case 'access':
                navigate(`/dashboard/users/${userId}/${UserTab.Access}`);
                break;

            case 'parentalcontrol':
                navigate(`/dashboard/users/${userId}/${UserTab.ParentalControl}`);
                break;

            case 'delete':
                confirmDeleteUser(userId, username);
                break;
        }
    }, [ confirmDeleteUser, navigate ]);

    const showUserMenu = useCallback((elem: HTMLElement) => {
        const card = dom.parentWithClass(elem, 'card');
        const userId = card?.getAttribute('data-userid');
        const username = card?.getAttribute('data-username');

        if (!userId) {
            console.error('Unexpected null user id');
            return;
        }

        const menuItems: MenuEntry[] = [];

        menuItems.push({
            name: globalize.translate('ButtonEditUser'),
            id: 'open',
            icon: 'mode_edit'
        });
        menuItems.push({
            name: globalize.translate('ButtonLibraryAccess'),
            id: 'access',
            icon: 'lock'
        });
        menuItems.push({
            name: globalize.translate('ButtonParentalControl'),
            id: 'parentalcontrol',
            icon: 'person'
        });
        menuItems.push({
            name: globalize.translate('Delete'),
            id: 'delete',
            icon: 'delete'
        });

        import('../../../../components/actionSheet/actionSheet').then(({ default: actionsheet }) => {
            actionsheet.show({
                items: menuItems,
                positionTo: card,
                callback: (id: string) => handleUserMenuAction(id, userId, username)
            }).catch(() => {
                // action sheet closed
            });
        }).catch(err => {
            console.error('[userprofiles] failed to load action sheet', err);
        });
    }, [ handleUserMenuAction ]);

    useEffect(() => {
        const page = element.current;

        if (location.state?.openSavedToast) {
            setIsSettingsSavedToastOpen(true);
            window.history.replaceState({}, '');
        }

        if (!page) {
            console.error('Unexpected null reference');
            return;
        }

        const onPageClick = function (e: MouseEvent) {
            const btnUserMenu = dom.parentWithClass(e.target as HTMLElement, 'btnUserMenu');

            if (btnUserMenu) {
                showUserMenu(btnUserMenu);
            }
        };

        const onAddUserClick = function() {
            navigate('/dashboard/users/add');
        };

        page.addEventListener('click', onPageClick);
        (page.querySelector('#btnAddUser') as HTMLButtonElement).addEventListener('click', onAddUserClick);

        return () => {
            page.removeEventListener('click', onPageClick);
            (page.querySelector('#btnAddUser') as HTMLButtonElement).removeEventListener('click', onAddUserClick);
        };
    }, [ navigate, location.state?.openSavedToast, showUserMenu ]);

    if (isPending || (!!__legacyApiClient__ && isSecondaryProfileUserIdsPending)) {
        return <Loading />;
    }

    const secondaryProfileUserIdSet = new Set(secondaryProfileUserIds.map(normalizeUserId));
    const visibleUsers = users?.filter(user => !secondaryProfileUserIdSet.has(normalizeUserId(user.Id)));

    return (
        <Page
            id='userProfilesPage'
            className='mainAnimatedPage type-interior userProfilesPage fullWidthContent'
            title={globalize.translate('HeaderUsers')}
        >
            <Toast
                open={isSettingsSavedToastOpen}
                onClose={handleToastClose}
                message={globalize.translate('SettingsSaved')}
            />
            <div ref={element} className='content-primary'>
                <div className='verticalSection'>
                    <SectionTitleContainer
                        title={globalize.translate('HeaderUsers')}
                        isBtnVisible={true}
                        btnId='btnAddUser'
                        btnClassName='fab submit sectionTitleButton'
                        btnTitle='ButtonAddUser'
                        btnIcon='add'
                    />
                </div>

                <div className='localUsers itemsContainer vertical-wrap'>
                    {visibleUsers?.map(user => {
                        return <UserCardBox key={user.Id} user={user} />;
                    })}
                </div>
            </div>
        </Page>

    );
};

export default UserProfiles;

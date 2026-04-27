import ExpandMore from '@mui/icons-material/ExpandMore';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import React, { useCallback, useState } from 'react';

import UserAvatar from 'components/UserAvatar';
import { useApi } from 'hooks/useApi';
import globalize from 'lib/globalize';
import { getCurrentProfileSelector } from 'lib/profileSelector/api';
import { getProfileAvatarGradientForUser } from 'lib/profileSelector/colors';

import AppUserMenu, { ID } from './AppUserMenu';

const UserMenuButton = () => {
    const { __legacyApiClient__, user } = useApi();

    const [ userMenuAnchorEl, setUserMenuAnchorEl ] = useState<null | HTMLElement>(null);
    const isUserMenuOpen = Boolean(userMenuAnchorEl);
    const { data: profileSelector } = useQuery({
        queryKey: [ 'ProfileSelector', 'Current', __legacyApiClient__?.serverId(), user?.Id ],
        queryFn: () => getCurrentProfileSelector(__legacyApiClient__!),
        enabled: !!__legacyApiClient__ && !!user?.Id
    });

    const profileGradient = getProfileAvatarGradientForUser(profileSelector, user?.Id);

    const onUserButtonClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
        setUserMenuAnchorEl(event.currentTarget);
    }, [ setUserMenuAnchorEl ]);

    const onUserMenuClose = useCallback(() => {
        setUserMenuAnchorEl(null);
    }, [ setUserMenuAnchorEl ]);

    return (
        <>
            <Tooltip title={globalize.translate('UserMenu')}>
                <IconButton
                    size='large'
                    aria-label={globalize.translate('UserMenu')}
                    aria-controls={ID}
                    aria-haspopup='true'
                    onClick={onUserButtonClick}
                    color='inherit'
                    sx={{
                        p: 0,
                        ml: 0,
                        gap: 1,
                        borderRadius: '4px',
                        '& .MuiAvatar-root': {
                            borderRadius: '4px',
                            fontSize: '0.9rem',
                            fontWeight: 800
                        },
                        '& .MuiSvgIcon-root': {
                            color: 'rgba(255, 255, 255, 0.7)',
                            fontSize: '1rem'
                        }
                    }}
                >
                    <UserAvatar
                        user={user}
                        size={32}
                        profileGradient={profileGradient}
                    />
                    <ExpandMore aria-hidden />
                </IconButton>
            </Tooltip>

            <AppUserMenu
                open={isUserMenuOpen}
                anchorEl={userMenuAnchorEl}
                onMenuClose={onUserMenuClose}
                profileGradient={profileGradient}
                profileSelector={profileSelector}
            />
        </>
    );
};

export default UserMenuButton;

import ArrowBack from '@mui/icons-material/ArrowBack';
import MenuIcon from '@mui/icons-material/Menu';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import React, { type FC, type PropsWithChildren, ReactNode } from 'react';

import { appRouter } from 'components/router/appRouter';
import { useApi } from 'hooks/useApi';
import globalize from 'lib/globalize';

import UserMenuButton from './UserMenuButton';

interface AppToolbarProps {
    buttons?: ReactNode
    isDrawerAvailable: boolean
    isDrawerOpen: boolean
    onDrawerButtonClick?: (event: React.MouseEvent<HTMLElement>) => void
    isBackButtonAvailable?: boolean
    isUserMenuAvailable?: boolean
}

const onBackButtonClick = () => {
    appRouter.back()
        .catch(err => {
            console.error('[AppToolbar] error calling appRouter.back', err);
        });
};

const AppToolbar: FC<PropsWithChildren<AppToolbarProps>> = ({
    buttons,
    children,
    isDrawerAvailable,
    isDrawerOpen,
    onDrawerButtonClick = () => { /* no-op */ },
    isBackButtonAvailable = false,
    isUserMenuAvailable = true
}) => {
    const { user } = useApi();
    const isUserLoggedIn = Boolean(user);

    return (
        <Toolbar
            variant='dense'
            sx={{
                flexWrap: {
                    xs: 'nowrap',
                    lg: 'nowrap'
                },
                alignItems: 'center',
                minHeight: {
                    xs: '64px',
                    md: '68px'
                },
                height: {
                    xs: '64px',
                    md: '68px'
                },
                width: '100%',
                boxSizing: 'border-box',
                pl: {
                    xs: 'max(18px, env(safe-area-inset-left))',
                    sm: 'max(36px, env(safe-area-inset-left))',
                    lg: 'max(56px, env(safe-area-inset-left))'
                },
                pr: {
                    xs: 'max(18px, env(safe-area-inset-right))',
                    sm: 'max(36px, env(safe-area-inset-right))',
                    lg: 'max(56px, env(safe-area-inset-right))'
                },
                gap: {
                    xs: 2,
                    md: '36px'
                }
            }}
        >
            {isUserLoggedIn && isDrawerAvailable && (
                <Tooltip title={globalize.translate(isDrawerOpen ? 'MenuClose' : 'MenuOpen')}>
                    <IconButton
                        size='large'
                        edge='start'
                        color='inherit'
                        aria-label={globalize.translate(isDrawerOpen ? 'MenuClose' : 'MenuOpen')}
                        onClick={onDrawerButtonClick}
                    >
                        <MenuIcon />
                    </IconButton>
                </Tooltip>
            )}

            {isBackButtonAvailable && (
                <Tooltip title={globalize.translate('ButtonBack')}>
                    <IconButton
                        size='large'
                        // Set the edge if the drawer button is not shown
                        edge={!(isUserLoggedIn && isDrawerAvailable) ? 'start' : undefined}
                        color='inherit'
                        aria-label={globalize.translate('ButtonBack')}
                        onClick={onBackButtonClick}
                    >
                        <ArrowBack />
                    </IconButton>
                </Tooltip>
            )}

            {children}

            <Box
                sx={{
                    display: 'flex',
                    flexGrow: 1,
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: '18px',
                    minWidth: 0,
                    '& .MuiIconButton-root': {
                        p: '6px',
                        color: '#fff'
                    },
                    '& .MuiSvgIcon-root': {
                        fontSize: '1.75rem'
                    }
                }}
            >
                {buttons}
            </Box>

            {isUserLoggedIn && isUserMenuAvailable && (
                <Box sx={{ flexGrow: 0 }}>
                    <UserMenuButton />
                </Box>
            )}
        </Toolbar>
    );
};

export default AppToolbar;

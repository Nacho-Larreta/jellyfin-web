import React, { StrictMode, useCallback, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import { type Theme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { Outlet, useLocation } from 'react-router-dom';

import AppBody from 'components/AppBody';
import CustomCss from 'components/CustomCss';
import ElevationScroll from 'components/ElevationScroll';
import ThemeCss from 'components/ThemeCss';
import { useApi } from 'hooks/useApi';

import AppToolbar from './components/AppToolbar';
import AppDrawer, { isDrawerPath } from './components/drawers/AppDrawer';

import './AppOverrides.scss';

export const Component = () => {
    const [ isDrawerActive, setIsDrawerActive ] = useState(false);
    const { user } = useApi();
    const location = useLocation();

    const isMediumScreen = useMediaQuery((t: Theme) => t.breakpoints.up('md'));
    const isDrawerAvailable = isDrawerPath(location.pathname) && Boolean(user) && !isMediumScreen;
    const isDrawerOpen = isDrawerActive && isDrawerAvailable;

    const onToggleDrawer = useCallback(() => {
        setIsDrawerActive(!isDrawerActive);
    }, [ isDrawerActive, setIsDrawerActive ]);

    return (
        <>
            <Box sx={{ position: 'relative', display: 'flex', height: '100%' }}>
                <StrictMode>
                    <ElevationScroll
                        elevate={false}
                        threshold={60}
                    >
                        <AppBar
                            position='fixed'
                            sx={{
                                left: 0,
                                right: 0,
                                width: '100vw',
                                height: {
                                    xs: '64px',
                                    md: '68px'
                                },
                                ml: 0,
                                color: '#fff',
                                background: 'linear-gradient(180deg, rgba(0, 0, 0, 0.7) 0%, rgba(0, 0, 0, 0) 100%)',
                                borderBottom: '1px solid transparent',
                                boxShadow: 'none',
                                transition: 'background 250ms cubic-bezier(0.4, 0, 0.2, 1), border-color 250ms cubic-bezier(0.4, 0, 0.2, 1)',
                                '&.MuiAppBar-colorDefault': {
                                    background: 'rgba(20, 20, 20, 0.96)',
                                    borderBottomColor: 'rgba(255, 255, 255, 0.06)',
                                    boxShadow: 'none'
                                },
                                '&.MuiAppBar-colorTransparent': {
                                    background: 'linear-gradient(180deg, rgba(0, 0, 0, 0.7) 0%, rgba(0, 0, 0, 0) 100%)',
                                    borderBottomColor: 'transparent',
                                    boxShadow: 'none'
                                }
                            }}
                        >
                            <AppToolbar
                                isDrawerAvailable={!isMediumScreen && isDrawerAvailable}
                                isDrawerOpen={isDrawerOpen}
                                onDrawerButtonClick={onToggleDrawer}
                            />
                        </AppBar>
                    </ElevationScroll>

                    {
                        isDrawerAvailable && (
                            <AppDrawer
                                open={isDrawerOpen}
                                onClose={onToggleDrawer}
                                onOpen={onToggleDrawer}
                            />
                        )
                    }
                </StrictMode>

                <Box
                    component='main'
                    sx={{
                        width: '100%',
                        flexGrow: 1
                    }}
                >
                    <AppBody>
                        <Outlet />
                    </AppBody>
                </Box>
            </Box>
            <ThemeCss />
            <CustomCss />
        </>
    );
};

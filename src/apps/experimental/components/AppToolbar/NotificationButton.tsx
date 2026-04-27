import Badge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import React, { type FC, useCallback, useState } from 'react';

import globalize from 'lib/globalize';

import { JellyflixBellIcon } from './JellyflixIcons';
import NotificationMenu, { ID } from './menus/NotificationMenu';

const NotificationButton: FC = () => {
    const notificationCount = 0;
    const [ notificationMenuAnchorEl, setNotificationMenuAnchorEl ] = useState<null | HTMLElement>(null);
    const isNotificationMenuOpen = Boolean(notificationMenuAnchorEl);

    const onNotificationButtonClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
        setNotificationMenuAnchorEl(event.currentTarget);
    }, [ setNotificationMenuAnchorEl ]);

    const onNotificationMenuClose = useCallback(() => {
        setNotificationMenuAnchorEl(null);
    }, [ setNotificationMenuAnchorEl ]);

    return (
        <>
            <Tooltip title={globalize.translate('Alerts')}>
                <IconButton
                    size='large'
                    aria-label={globalize.translate('Alerts')}
                    aria-controls={ID}
                    aria-haspopup='true'
                    aria-expanded={isNotificationMenuOpen}
                    onClick={onNotificationButtonClick}
                    color='inherit'
                >
                    <Badge
                        variant='dot'
                        invisible={notificationCount === 0}
                        sx={{
                            '& .MuiBadge-badge': {
                                top: 4,
                                right: 4,
                                minWidth: 7,
                                width: 7,
                                height: 7,
                                borderRadius: '50%',
                                backgroundColor: '#E50914'
                            }
                        }}
                    >
                        <JellyflixBellIcon />
                    </Badge>
                </IconButton>
            </Tooltip>

            <NotificationMenu
                open={isNotificationMenuOpen}
                anchorEl={notificationMenuAnchorEl}
                onMenuClose={onNotificationMenuClose}
            />
        </>
    );
};

export default NotificationButton;

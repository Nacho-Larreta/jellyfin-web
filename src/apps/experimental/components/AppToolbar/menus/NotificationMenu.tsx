import NotificationsNone from '@mui/icons-material/NotificationsNone';
import type { MenuProps } from '@mui/material/Menu';
import React, { type FC } from 'react';

import globalize from 'lib/globalize';

import { ToolbarEmptyMenuItem, ToolbarMenu } from './ToolbarMenu';

export const ID = 'app-notification-menu';

interface NotificationMenuProps extends MenuProps {
    onMenuClose: () => void
}

const NotificationMenu: FC<NotificationMenuProps> = ({
    anchorEl,
    open,
    onMenuClose
}) => (
    <ToolbarMenu
        anchorEl={anchorEl}
        id={ID}
        open={open}
        onClose={onMenuClose}
    >
        <ToolbarEmptyMenuItem
            icon={<NotificationsNone />}
            title={globalize.translate('ToolbarAlertsEmptyTitle')}
            description={globalize.translate('ToolbarAlertsEmptyDescription')}
        />
    </ToolbarMenu>
);

export default NotificationMenu;

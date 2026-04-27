import Warning from '@mui/icons-material/Warning';
import Cast from '@mui/icons-material/Cast';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import type { MenuProps } from '@mui/material/Menu';
import React, { FC, useCallback, useEffect, useState } from 'react';

import globalize from 'lib/globalize';
import { playbackManager } from 'components/playback/playbackmanager';
import { pluginManager } from 'components/pluginManager';
import type { PlayTarget } from 'types/playTarget';

import PlayTargetIcon from '../../PlayTargetIcon';
import { ToolbarEmptyMenuItem, ToolbarMenu, TOOLBAR_MENU_ITEM_SX } from './ToolbarMenu';

interface RemotePlayMenuProps extends MenuProps {
    onMenuClose: () => void
}

export const ID = 'app-remote-play-menu';

const RemotePlayTargetMenuItem: FC<{
    onPlayTargetClick: (target: PlayTarget) => void;
    target: PlayTarget;
}> = ({
    onPlayTargetClick,
    target
}) => {
    const onClick = useCallback(() => {
        onPlayTargetClick(target);
    }, [ onPlayTargetClick, target ]);

    return (
        <MenuItem
            key={target.id}
            onClick={onClick}
            sx={TOOLBAR_MENU_ITEM_SX}
        >
            <ListItemIcon>
                <PlayTargetIcon target={target} />
            </ListItemIcon>
            <ListItemText
                primary={target.appName ? `${target.name} - ${target.appName}` : target.name}
                secondary={target.user?.Name}
            />
        </MenuItem>
    );
};

const RemotePlayMenu: FC<RemotePlayMenuProps> = ({
    anchorEl,
    open,
    onMenuClose
}) => {
    // TODO: Add other checks for support (Android app, secure context, etc)
    const isChromecastPluginLoaded = !!pluginManager.plugins.find(plugin => plugin.id === 'chromecast');
    const [ playbackTargets, setPlaybackTargets ] = useState<PlayTarget[]>([]);

    const onPlayTargetClick = useCallback((target: PlayTarget) => {
        playbackManager.trySetActivePlayer(target.playerName, target);
        onMenuClose();
    }, [ onMenuClose ]);

    useEffect(() => {
        const fetchPlaybackTargets = async () => {
            setPlaybackTargets(
                await playbackManager.getTargets()
            );
        };

        if (open) {
            fetchPlaybackTargets()
                .catch(err => {
                    console.error('[AppRemotePlayMenu] unable to get playback targets', err);
                });
        }
    }, [ open, setPlaybackTargets ]);

    return (
        <ToolbarMenu
            anchorEl={anchorEl}
            id={ID}
            open={open}
            onClose={onMenuClose}
        >
            {!isChromecastPluginLoaded && (
                <MenuItem
                    disabled
                    sx={TOOLBAR_MENU_ITEM_SX}
                >
                    <ListItemIcon>
                        <Warning />
                    </ListItemIcon>
                    <ListItemText>
                        {globalize.translate('GoogleCastUnsupported')}
                    </ListItemText>
                </MenuItem>
            )}

            {!isChromecastPluginLoaded && playbackTargets.length > 0 && (
                <Divider />
            )}

            {isChromecastPluginLoaded && playbackTargets.length === 0 && (
                <ToolbarEmptyMenuItem
                    icon={<Cast />}
                    title={globalize.translate('ToolbarCastNoDevicesTitle')}
                    description={globalize.translate('ToolbarCastNoDevicesDescription')}
                />
            )}

            {playbackTargets.map(target => (
                <RemotePlayTargetMenuItem
                    key={target.id}
                    onPlayTargetClick={onPlayTargetClick}
                    target={target}
                />
            ))}
        </ToolbarMenu>
    );
};

export default RemotePlayMenu;

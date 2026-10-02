import Check from '@mui/icons-material/Check';
import Close from '@mui/icons-material/Close';
import SettingsRemote from '@mui/icons-material/SettingsRemote';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import type { MenuProps } from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import dialog from 'components/dialog/dialog';
import { playbackManager } from 'components/playback/playbackmanager';
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { enable, isEnabled } from 'scripts/autocast';
import globalize from 'lib/globalize';

import { ToolbarMenu, TOOLBAR_MENU_ITEM_SX } from './ToolbarMenu';

interface RemotePlayActiveMenuProps extends MenuProps {
    onMenuClose: () => void
    playerInfo: {
        name: string
        isLocalPlayer: boolean
        id?: string
        deviceName?: string
        playableMediaTypes?: string[]
        supportedCommands?: string[]
    } | null
}

export const ID = 'app-remote-play-active-menu';

const RemotePlayActiveMenu: FC<RemotePlayActiveMenuProps> = ({
    anchorEl,
    open,
    onMenuClose,
    playerInfo
}) => {
    const [ isDisplayMirrorEnabled, setIsDisplayMirrorEnabled ] = useState(playbackManager.enableDisplayMirroring());
    const isDisplayMirrorSupported = playerInfo?.supportedCommands && playerInfo.supportedCommands.indexOf('DisplayContent') !== -1;
    const toggleDisplayMirror = useCallback(() => {
        playbackManager.enableDisplayMirroring(!isDisplayMirrorEnabled);
        setIsDisplayMirrorEnabled(!isDisplayMirrorEnabled);
    }, [ isDisplayMirrorEnabled, setIsDisplayMirrorEnabled ]);

    const [ autoCast, setAutoCast ] = useState<{ status: 'loading' | 'ready' | 'pending' | 'error'; enabled: boolean }>({
        status: 'loading', enabled: false
    });
    const autoCastRead = useRef(0);
    const autoCastActive = useRef(false);
    const refreshAutoCast = useCallback(async () => {
        const read = ++autoCastRead.current;
        setAutoCast({ status: 'loading', enabled: false });
        const enabled = await isEnabled();
        if (read === autoCastRead.current && autoCastActive.current) {
            setAutoCast(enabled === null ? { status: 'error', enabled: false } : { status: 'ready', enabled });
        }
    }, []);
    useEffect(() => {
        autoCastActive.current = open;
        if (open) void refreshAutoCast();
        return () => {
            autoCastActive.current = false;
        };
    }, [ open, playerInfo?.id, refreshAutoCast ]);
    const toggleAutoCast = useCallback(async () => {
        if (autoCast.status === 'error') {
            await refreshAutoCast();
            return;
        }
        if (autoCast.status !== 'ready') return;
        const read = autoCastRead.current;
        setAutoCast({ ...autoCast, status: 'pending' });
        const saved = await enable(!autoCast.enabled);
        if (read !== autoCastRead.current || !autoCastActive.current) return;
        if (saved) await refreshAutoCast();
        else setAutoCast({ status: 'error', enabled: false });
    }, [ autoCast, refreshAutoCast ]);

    const remotePlayerName = playerInfo?.deviceName || playerInfo?.name;

    const disconnectRemotePlayer = useCallback(() => {
        if (playbackManager.getSupportedCommands().indexOf('EndSession') !== -1) {
            dialog.show({
                buttons: [
                    {
                        name: globalize.translate('Yes'),
                        id: 'yes'
                    }, {
                        name: globalize.translate('No'),
                        id: 'no'
                    }
                ],
                text: globalize.translate('ConfirmEndPlayerSession', remotePlayerName)
            }).then(id => {
                onMenuClose();

                if (id === 'yes') {
                    playbackManager.getCurrentPlayer().endSession();
                }
                playbackManager.setDefaultPlayerActive();
            }).catch(() => {
            // Dialog closed
            });
        } else {
            onMenuClose();
            playbackManager.setDefaultPlayerActive();
        }
    }, [ onMenuClose, remotePlayerName ]);

    return (
        <ToolbarMenu
            anchorEl={anchorEl}
            id={ID}
            open={open}
            onClose={onMenuClose}
            slotProps={{
                list: {
                    'aria-labelledby': 'remote-play-active-subheader',
                    subheader: (
                        <ListSubheader component='div' id='remote-play-active-subheader'>
                            {remotePlayerName}
                        </ListSubheader>
                    )
                }
            }}
        >
            {isDisplayMirrorSupported && (
                <MenuItem
                    onClick={toggleDisplayMirror}
                    sx={TOOLBAR_MENU_ITEM_SX}
                >
                    {isDisplayMirrorEnabled && (
                        <ListItemIcon>
                            <Check />
                        </ListItemIcon>
                    )}
                    <ListItemText inset={!isDisplayMirrorEnabled}>
                        {globalize.translate('EnableDisplayMirroring')}
                    </ListItemText>
                </MenuItem>
            )}

            <MenuItem
                onClick={toggleAutoCast}
                disabled={autoCast.status === 'loading' || autoCast.status === 'pending'}
                role='menuitemcheckbox'
                aria-checked={autoCast.status === 'ready' ? autoCast.enabled : false}
                aria-busy={autoCast.status === 'loading' || autoCast.status === 'pending'}
                sx={TOOLBAR_MENU_ITEM_SX}
            >
                {autoCast.status === 'ready' && autoCast.enabled && (
                    <ListItemIcon>
                        <Check />
                    </ListItemIcon>
                )}
                <ListItemText
                    inset={autoCast.status !== 'ready' || !autoCast.enabled}
                    secondary={autoCast.status === 'error' ? `${globalize.translate('HeaderError')} · ${globalize.translate('Retry')}` : undefined}
                >
                    {globalize.translate('EnableAutoCast')}
                </ListItemText>
            </MenuItem>

            <Divider />

            <MenuItem
                component={Link}
                to='/queue'
                onClick={onMenuClose}
                sx={TOOLBAR_MENU_ITEM_SX}
            >
                <ListItemIcon>
                    <SettingsRemote />
                </ListItemIcon>
                <ListItemText>
                    {globalize.translate('HeaderRemoteControl')}
                </ListItemText>
            </MenuItem>
            <Divider />
            <MenuItem
                onClick={disconnectRemotePlayer}
                sx={TOOLBAR_MENU_ITEM_SX}
            >
                <ListItemIcon>
                    <Close />
                </ListItemIcon>
                <ListItemText>
                    {globalize.translate('Disconnect')}
                </ListItemText>
            </MenuItem>
        </ToolbarMenu>
    );
};

export default RemotePlayActiveMenu;

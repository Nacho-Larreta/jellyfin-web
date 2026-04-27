import { SyncPlayUserAccessType } from '@jellyfin/sdk/lib/generated-client/models/sync-play-user-access-type';
import type { GroupInfoDto } from '@jellyfin/sdk/lib/generated-client/models/group-info-dto';
import GroupAdd from '@mui/icons-material/GroupAdd';
import PersonAdd from '@mui/icons-material/PersonAdd';
import PersonOff from '@mui/icons-material/PersonOff';
import PersonRemove from '@mui/icons-material/PersonRemove';
import PlayCircle from '@mui/icons-material/PlayCircle';
import StopCircle from '@mui/icons-material/StopCircle';
import Tune from '@mui/icons-material/Tune';
import Divider from '@mui/material/Divider';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import type { MenuProps } from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import React, { FC, useCallback } from 'react';

import SyncPlayGroupListItem from 'apps/experimental/features/syncPlay/components/SyncPlayGroupListItem';
import { useCreateSyncPlayGroup } from 'apps/experimental/features/syncPlay/hooks/api/useCreateSyncPlayGroup';
import { useJoinSyncPlayGroup } from 'apps/experimental/features/syncPlay/hooks/api/useJoinSyncPlayGroup';
import { useLeaveSyncPlayGroup } from 'apps/experimental/features/syncPlay/hooks/api/useLeaveSyncPlayGroup';
import { useSyncPlayGroups } from 'apps/experimental/features/syncPlay/hooks/api/useSyncPlayGroups';
import { useSyncPlay } from 'apps/experimental/features/syncPlay/hooks/useSyncPlay';
import { useApi } from 'hooks/useApi';
import globalize from 'lib/globalize';

import { ToolbarMenu, TOOLBAR_MENU_ITEM_SX } from './ToolbarMenu';

export const ID = 'app-sync-play-menu';

interface SyncPlayMenuProps extends MenuProps {
    onMenuClose: () => void
}

const SyncPlayGroupMenuItem: FC<{
    group: GroupInfoDto;
    onGroupJoinClick: (groupId: string) => void;
}> = ({
    group,
    onGroupJoinClick
}) => {
    const onClick = useCallback(() => {
        if (group.GroupId) {
            onGroupJoinClick(group.GroupId);
        }
    }, [ group.GroupId, onGroupJoinClick ]);

    return (
        <ListItem
            sx={{
                color: '#fff',
                px: 2.25,
                py: 1.1
            }}
        >
            <SyncPlayGroupListItem
                group={group}
                button={{
                    onClick,
                    tooltip: globalize.translate('LabelSyncPlayJoinGroup'),
                    Icon: PersonAdd
                }}
            />
        </ListItem>
    );
};

const SyncPlayMenu: FC<SyncPlayMenuProps> = ({
    anchorEl,
    open,
    onMenuClose
}) => {
    const { __legacyApiClient__, user } = useApi();
    const {
        isActive: isSyncPlayEnabled,
        currentGroup,
        syncPlay
    } = useSyncPlay();
    const { data: groups } = useSyncPlayGroups();

    const createSyncPlayGroup = useCreateSyncPlayGroup();
    const joinSyncPlayGroup = useJoinSyncPlayGroup();
    const leaveSyncPlayGroup = useLeaveSyncPlayGroup();

    const onGroupAddClick = useCallback(() => {
        createSyncPlayGroup.mutate({
            newGroupRequestDto: {
                GroupName: globalize.translate('SyncPlayGroupDefaultTitle', user?.Name ?? '')
            }
        }, {
            onSettled: onMenuClose
        });
    }, [ createSyncPlayGroup, onMenuClose, user ]);

    const onGroupLeaveClick = useCallback(() => {
        leaveSyncPlayGroup.mutate(undefined, {
            onSettled: onMenuClose
        });
    }, [ leaveSyncPlayGroup, onMenuClose ]);

    const onGroupJoinClick = useCallback((GroupId: string) => {
        joinSyncPlayGroup.mutate({
            joinGroupRequestDto: {
                GroupId
            }
        }, {
            onSettled: onMenuClose
        });
    }, [ joinSyncPlayGroup, onMenuClose ]);

    const onGroupSettingsClick = useCallback(async () => {
        if (!syncPlay) return;

        // TODO: Rewrite settings UI
        const SyncPlaySettingsEditor = (await import('../../../../../plugins/syncPlay/ui/settings/SettingsEditor')).default;
        new SyncPlaySettingsEditor(
            __legacyApiClient__,
            syncPlay.Manager.getTimeSyncCore(),
            {
                groupInfo: currentGroup
            })
            .embed()
            .catch(err => {
                if (err) {
                    console.error('[SyncPlayMenu] Error creating SyncPlay settings editor', err);
                }
            });

        onMenuClose();
    }, [ __legacyApiClient__, currentGroup, onMenuClose, syncPlay ]);

    const onStartGroupPlaybackClick = useCallback(() => {
        if (__legacyApiClient__) {
            syncPlay?.Manager.resumeGroupPlayback(__legacyApiClient__);
            onMenuClose();
        }
    }, [ __legacyApiClient__, onMenuClose, syncPlay ]);

    const onStopGroupPlaybackClick = useCallback(() => {
        if (__legacyApiClient__) {
            syncPlay?.Manager.haltGroupPlayback(__legacyApiClient__);
            onMenuClose();
        }
    }, [ __legacyApiClient__, onMenuClose, syncPlay ]);

    const menuItems = [];
    if (isSyncPlayEnabled) {
        if (!syncPlay?.Manager.isPlaylistEmpty() && !syncPlay?.Manager.isPlaybackActive()) {
            menuItems.push(
                <MenuItem
                    key='sync-play-start-playback'
                    onClick={onStartGroupPlaybackClick}
                    sx={TOOLBAR_MENU_ITEM_SX}
                >
                    <ListItemIcon>
                        <PlayCircle />
                    </ListItemIcon>
                    <ListItemText primary={globalize.translate('LabelSyncPlayResumePlayback')} />
                </MenuItem>
            );
        } else if (syncPlay?.Manager.isPlaybackActive()) {
            menuItems.push(
                <MenuItem
                    key='sync-play-stop-playback'
                    onClick={onStopGroupPlaybackClick}
                    sx={TOOLBAR_MENU_ITEM_SX}
                >
                    <ListItemIcon>
                        <StopCircle />
                    </ListItemIcon>
                    <ListItemText primary={globalize.translate('LabelSyncPlayHaltPlayback')} />
                </MenuItem>
            );
        }

        menuItems.push(
            <MenuItem
                key='sync-play-settings'
                onClick={onGroupSettingsClick}
                sx={TOOLBAR_MENU_ITEM_SX}
            >
                <ListItemIcon>
                    <Tune />
                </ListItemIcon>
                <ListItemText
                    primary={globalize.translate('Settings')}
                />
            </MenuItem>
        );
    } else if (!groups?.length && user?.Policy?.SyncPlayAccess !== SyncPlayUserAccessType.CreateAndJoinGroups) {
        menuItems.push(
            <MenuItem
                key='sync-play-unavailable'
                disabled
                sx={TOOLBAR_MENU_ITEM_SX}
            >
                <ListItemIcon>
                    <PersonOff />
                </ListItemIcon>
                <ListItemText primary={globalize.translate('LabelSyncPlayNoGroups')} />
            </MenuItem>
        );
    } else {
        if (groups && groups.length > 0) {
            groups.forEach(group => {
                menuItems.push(
                    <SyncPlayGroupMenuItem
                        key={group.GroupId}
                        group={group}
                        onGroupJoinClick={onGroupJoinClick}
                    />
                );
            });

            menuItems.push(
                <Divider key='sync-play-groups-divider' />
            );
        }

        if (user?.Policy?.SyncPlayAccess === SyncPlayUserAccessType.CreateAndJoinGroups) {
            menuItems.push(
                <MenuItem
                    key='sync-play-new-group'
                    onClick={onGroupAddClick}
                    sx={TOOLBAR_MENU_ITEM_SX}
                >
                    <ListItemIcon>
                        <GroupAdd />
                    </ListItemIcon>
                    <ListItemText primary={globalize.translate('LabelSyncPlayNewGroupDescription')} />
                </MenuItem>
            );
        }
    }

    const MenuListProps = isSyncPlayEnabled ? {
        'aria-labelledby': 'sync-play-active-subheader',
        subheader: (
            <>
                <ListSubheader
                    id='sync-play-active-subheader'
                    component='div'
                    sx={{ marginY: 1.75 }}
                >
                    <SyncPlayGroupListItem
                        group={currentGroup!}
                        button={{
                            onClick: onGroupLeaveClick,
                            tooltip: globalize.translate('LabelSyncPlayLeaveGroup'),
                            Icon: PersonRemove
                        }}
                    />
                </ListSubheader>
                <Divider />
            </>
        )
    } : undefined;

    return (
        <ToolbarMenu
            anchorEl={anchorEl}
            id={ID}
            open={open}
            onClose={onMenuClose}
            slotProps={{
                list: MenuListProps
            }}
        >
            {menuItems}
        </ToolbarMenu>
    );
};

export default SyncPlayMenu;

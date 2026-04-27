import AccountCircle from '@mui/icons-material/AccountCircle';
import ChevronRight from '@mui/icons-material/ChevronRight';
import Close from '@mui/icons-material/Close';
import DashboardIcon from '@mui/icons-material/Dashboard';
import Logout from '@mui/icons-material/Logout';
import Settings from '@mui/icons-material/Settings';
import Storage from '@mui/icons-material/Storage';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu, { MenuProps } from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import type { ApiClient } from 'jellyfin-apiclient';
import React, { FC, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';

import { appHost } from 'components/apphost';
import alert from 'components/alert';
import loading from 'components/loading/loading';
import prompt from 'components/prompt/prompt';
import { AppFeature } from 'constants/appFeature';
import { useApi } from 'hooks/useApi';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { activateProfileSession, reloadIntoProfileTarget } from 'lib/profileSelector/activation';
import { parseProfileSelectorError } from 'lib/profileSelector/api';
import { getProfileAvatarGradient } from 'lib/profileSelector/colors';
import { getVisibleProfiles, PROFILE_SELECTOR_PATH } from 'lib/profileSelector/utils';
import Dashboard from 'utils/dashboard';

export const ID = 'app-user-menu';

type ProfileSelectorMember = {
    ProfileUserId?: string | null;
    Name?: string | null;
    PrimaryImageTag?: string | null;
    DisplayOrder?: number;
    IsVisible?: boolean;
    RequiresPin?: boolean;
    IsDisabled?: boolean;
    IsAdministrator?: boolean;
    IsOwner?: boolean;
    HasParentalRestrictions?: boolean;
    IsActive?: boolean;
};

type ProfileSelectorState = {
    IsEnabled?: boolean;
    Profiles?: ProfileSelectorMember[];
};

interface AppUserMenuProps extends MenuProps {
    onMenuClose: () => void;
    profileGradient?: string | null;
    profileSelector?: ProfileSelectorState | null;
}

const MENU_ITEM_SX = {
    minHeight: 58,
    px: 2.25,
    py: 1.15,
    gap: 1.75,
    color: '#fff',
    fontFamily: '"Figtree", "Helvetica Neue", Arial, sans-serif',
    '&:hover, &:focus-visible': {
        backgroundColor: 'rgba(255,255,255,0.07)'
    },
    '& .MuiListItemIcon-root': {
        alignItems: 'center',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: '6px',
        color: '#fff',
        height: 40,
        justifyContent: 'center',
        minWidth: 40,
        width: 40
    },
    '& .MuiListItemText-primary': {
        color: '#fff',
        fontSize: '1rem',
        fontWeight: 700,
        letterSpacing: '-0.01em'
    },
    '& .MuiListItemText-secondary': {
        color: 'rgba(255,255,255,0.42)',
        fontSize: '0.82rem',
        lineHeight: 1.25,
        mt: 0.25
    }
};

function getProfileImageUrl(apiBasePath: string | undefined, profile: ProfileSelectorMember) {
    if (!apiBasePath || !profile.ProfileUserId || !profile.PrimaryImageTag) {
        return undefined;
    }

    return `${apiBasePath}/Users/${profile.ProfileUserId}/Images/Primary?tag=${profile.PrimaryImageTag}`;
}

function getProfileInitial(profile: ProfileSelectorMember) {
    return profile.Name?.trim().charAt(0).toUpperCase() || '?';
}

function getProfileRole(profile: ProfileSelectorMember) {
    if (profile.IsAdministrator || profile.IsOwner) {
        return {
            label: globalize.translate('ProfileSelectorMenuAdminRole'),
            color: '#46D369',
            borderColor: 'rgba(70,211,105,0.45)',
            backgroundColor: 'rgba(70,211,105,0.10)'
        };
    }

    if (profile.HasParentalRestrictions) {
        return {
            label: globalize.translate('ProfileSelectorMenuKidsRole'),
            color: '#FFC83D',
            borderColor: 'rgba(255,200,61,0.45)',
            backgroundColor: 'rgba(255,200,61,0.10)'
        };
    }

    return {
        label: globalize.translate('ProfileSelectorMenuUserRole'),
        color: 'rgba(255,255,255,0.58)',
        borderColor: 'transparent',
        backgroundColor: 'transparent'
    };
}

function shouldShowCurrentRole(profile: ProfileSelectorMember) {
    return !!profile.IsAdministrator || !!profile.IsOwner || !!profile.HasParentalRestrictions;
}

function getProfileSubtitle(profile: ProfileSelectorMember, serverName?: string | null) {
    if (profile.IsAdministrator || profile.IsOwner) {
        return globalize.translate('ProfileSelectorOwnerDescription');
    }

    if (profile.HasParentalRestrictions) {
        return globalize.translate('ProfileSelectorKidsDescription');
    }

    return serverName || '';
}

async function requestProfilePin(profile: ProfileSelectorMember, description?: string | null) {
    return prompt({
        title: globalize.translate('ProfileSelectorPinTitle', profile.Name || ''),
        label: globalize.translate('LabelPasswordRecoveryPinCode'),
        description: description || globalize.translate('ProfileSelectorPinDescription'),
        confirmText: globalize.translate('ButtonOk'),
        inputType: 'password',
        inputMode: 'numeric',
        autocomplete: 'off',
        maxLength: 8,
        pattern: '[0-9]*'
    });
}

async function submitProfileActivation(apiClient: ApiClient, profile: ProfileSelectorMember, pin?: string | null): Promise<void> {
    loading.show();

    try {
        await activateProfileSession(apiClient, profile, pin);
        reloadIntoProfileTarget('/home');
    } catch (response) {
        loading.hide();
        const error = await parseProfileSelectorError(response);

        if (error.code === 'PROFILE_PIN_REQUIRED' || error.code === 'PROFILE_PIN_INVALID') {
            try {
                const retryPin = await requestProfilePin(profile, error.detail);
                return submitProfileActivation(apiClient, profile, retryPin);
            } catch {
                return;
            }
        }

        void alert({
            title: globalize.translate('HeaderError'),
            text: error.detail || globalize.translate('MessageUnableToConnectToServer')
        });
    } finally {
        loading.hide();
    }
}

async function activateProfileFromMenu(apiClient: ApiClient, profile: ProfileSelectorMember) {
    if (!profile.ProfileUserId) {
        return;
    }

    let pin = null;
    if (profile.RequiresPin) {
        try {
            pin = await requestProfilePin(profile);
        } catch {
            return;
        }
    }

    await submitProfileActivation(apiClient, profile, pin);
}

const ProfileMenuAvatar: FC<{
    apiBasePath?: string;
    gradient?: string | null;
    index: number;
    profile: ProfileSelectorMember;
    size: number;
}> = ({
    apiBasePath,
    gradient,
    index,
    profile,
    size
}) => {
    const imageUrl = getProfileImageUrl(apiBasePath, profile);

    return (
        <Avatar
            alt={profile.Name || undefined}
            src={imageUrl}
            sx={{
                background: imageUrl ? undefined : gradient || getProfileAvatarGradient(index),
                borderRadius: '6px',
                boxShadow: '0 10px 26px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12)',
                color: '#fff',
                fontFamily: '"Figtree", "Helvetica Neue", Arial, sans-serif',
                fontSize: `${Math.max(size * 0.42, 14)}px`,
                fontWeight: 800,
                height: size,
                width: size
            }}
        >
            {imageUrl ? null : getProfileInitial(profile)}
        </Avatar>
    );
};

const RoleBadge: FC<{
    profile: ProfileSelectorMember;
    prominent?: boolean;
}> = ({
    profile,
    prominent = false
}) => {
    const role = getProfileRole(profile);

    return (
        <Box
            component='span'
            sx={{
                alignItems: 'center',
                backgroundColor: role.backgroundColor,
                border: `1px solid ${role.borderColor}`,
                borderRadius: '3px',
                color: role.color,
                display: 'inline-flex',
                fontSize: prominent ? '0.72rem' : '0.68rem',
                fontWeight: 800,
                letterSpacing: '0.18em',
                lineHeight: 1,
                px: prominent ? 0.65 : 0,
                py: prominent ? 0.35 : 0,
                textTransform: 'uppercase'
            }}
        >
            {role.label}
        </Box>
    );
};

const ProfileSwitchMenuItem: FC<{
    apiBasePath?: string;
    index: number;
    onProfileSwitch: (profile: ProfileSelectorMember) => void;
    profile: ProfileSelectorMember;
}> = ({
    apiBasePath,
    index,
    onProfileSwitch,
    profile
}) => {
    const onClick = useCallback(() => {
        onProfileSwitch(profile);
    }, [ onProfileSwitch, profile ]);

    return (
        <MenuItem
            disabled={profile.IsDisabled}
            onClick={onClick}
            sx={MENU_ITEM_SX}
        >
            <ProfileMenuAvatar
                apiBasePath={apiBasePath}
                index={index}
                profile={profile}
                size={40}
            />
            <ListItemText
                primary={profile.Name}
                sx={{
                    my: 0,
                    minWidth: 0
                }}
            />
            <RoleBadge profile={profile} />
        </MenuItem>
    );
};

const ServerStatusRow: FC<{
    onSelectServerClick: () => void;
    serverName?: string | null;
}> = ({
    onSelectServerClick,
    serverName
}) => (
    <MenuItem
        onClick={onSelectServerClick}
        sx={MENU_ITEM_SX}
    >
        <ListItemIcon>
            <Storage fontSize='small' />
        </ListItemIcon>
        <ListItemText
            primary={serverName || globalize.translate('SelectServer')}
            secondary={
                <Box
                    component='span'
                    sx={{
                        alignItems: 'center',
                        display: 'inline-flex',
                        gap: 0.75
                    }}
                >
                    <Box
                        component='span'
                        sx={{
                            backgroundColor: '#46D369',
                            borderRadius: '50%',
                            height: 6,
                            width: 6
                        }}
                    />
                    {globalize.translate('ProfileSelectorMenuServerOnline')}
                </Box>
            }
        />
    </MenuItem>
);

const AppUserMenu: FC<AppUserMenuProps> = ({
    anchorEl,
    open,
    onMenuClose,
    profileGradient,
    profileSelector
}) => {
    const { __legacyApiClient__, api, user } = useApi();
    const currentServer = user?.ServerId ? ServerConnections.getServerInfo(user.ServerId) : null;
    const serverName = currentServer?.Name || user?.ServerName || __legacyApiClient__?.serverAddress?.();
    const visibleProfiles = useMemo<ProfileSelectorMember[]>(
        () => getVisibleProfiles(profileSelector) as ProfileSelectorMember[],
        [ profileSelector ]
    );

    const currentProfile = useMemo<ProfileSelectorMember | null>(() => {
        const activeProfile = visibleProfiles.find(profile => profile.ProfileUserId === user?.Id)
            || visibleProfiles.find(profile => profile.IsActive);

        if (activeProfile) {
            return activeProfile;
        }

        if (!user) {
            return null;
        }

        return {
            ProfileUserId: user.Id,
            Name: user.Name,
            PrimaryImageTag: user.PrimaryImageTag,
            IsAdministrator: !!user.Policy?.IsAdministrator,
            IsOwner: !!user.Policy?.IsAdministrator
        };
    }, [ user, visibleProfiles ]);

    const currentProfileIndex = Math.max(
        0,
        visibleProfiles.findIndex(profile => profile.ProfileUserId === currentProfile?.ProfileUserId)
    );

    const switchProfiles = useMemo(
        () => visibleProfiles.filter(profile => profile.ProfileUserId !== user?.Id),
        [ user?.Id, visibleProfiles ]
    );

    const isProfileSelectorAvailable = !!profileSelector?.IsEnabled
        || !!currentServer?.ProfileSelectorEnabled
        || !!user?.Policy?.IsAdministrator;

    const onProfileSwitch = useCallback((profile: ProfileSelectorMember) => {
        if (!__legacyApiClient__ || !profile.ProfileUserId || profile.ProfileUserId === user?.Id) {
            return;
        }

        onMenuClose();
        void activateProfileFromMenu(__legacyApiClient__, profile);
    }, [ __legacyApiClient__, onMenuClose, user?.Id ]);

    const onExitAppClick = useCallback(() => {
        appHost.exit();
        onMenuClose();
    }, [ onMenuClose ]);

    const onLogoutClick = useCallback(() => {
        Dashboard.logout();
        onMenuClose();
    }, [ onMenuClose ]);

    const onSelectServerClick = useCallback(() => {
        Dashboard.selectServer();
        onMenuClose();
    }, [ onMenuClose ]);

    return (
        <Menu
            anchorEl={anchorEl}
            anchorOrigin={{
                vertical: 'bottom',
                horizontal: 'right'
            }}
            transformOrigin={{
                vertical: 'top',
                horizontal: 'right'
            }}
            id={ID}
            keepMounted
            open={open}
            onClose={onMenuClose}
            slotProps={{
                paper: {
                    sx: {
                        background: 'rgba(20,20,20,0.98)',
                        border: '1px solid rgba(255,255,255,0.10)',
                        borderRadius: '10px',
                        boxShadow: '0 22px 70px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.05)',
                        color: '#fff',
                        mt: 1.25,
                        overflow: 'hidden',
                        width: {
                            xs: 'calc(100vw - 32px)',
                            sm: 420
                        }
                    }
                },
                list: {
                    sx: {
                        p: 0
                    }
                }
            }}
        >
            {currentProfile && (
                <Box
                    sx={{
                        alignItems: 'center',
                        background: 'linear-gradient(180deg, rgba(0,164,220,0.10) 0%, rgba(255,255,255,0.02) 100%)',
                        borderBottom: '1px solid rgba(255,255,255,0.10)',
                        display: 'flex',
                        gap: 1.75,
                        px: 2.25,
                        py: 2
                    }}
                >
                    <ProfileMenuAvatar
                        apiBasePath={api?.basePath}
                        gradient={profileGradient}
                        index={currentProfileIndex}
                        profile={currentProfile}
                        size={52}
                    />
                    <Box sx={{ minWidth: 0 }}>
                        <Box
                            sx={{
                                alignItems: 'center',
                                display: 'flex',
                                gap: 1,
                                minWidth: 0
                            }}
                        >
                            <Typography
                                component='p'
                                noWrap
                                sx={{
                                    color: '#fff',
                                    fontSize: '1.05rem',
                                    fontWeight: 800,
                                    letterSpacing: '-0.015em',
                                    lineHeight: 1.15,
                                    maxWidth: 245
                                }}
                            >
                                {currentProfile.Name}
                            </Typography>
                            {shouldShowCurrentRole(currentProfile) && (
                                <RoleBadge
                                    profile={currentProfile}
                                    prominent
                                />
                            )}
                        </Box>
                        <Typography
                            component='p'
                            noWrap
                            sx={{
                                color: 'rgba(255,255,255,0.48)',
                                fontSize: '0.84rem',
                                mt: 0.45,
                                maxWidth: 270
                            }}
                        >
                            {getProfileSubtitle(currentProfile, serverName)}
                        </Typography>
                    </Box>
                </Box>
            )}

            {isProfileSelectorAvailable && (
                <Box
                    sx={{
                        pb: 1.4,
                        pt: 1.8
                    }}
                >
                    <Typography
                        component='p'
                        sx={{
                            color: 'rgba(255,255,255,0.40)',
                            fontSize: '0.72rem',
                            fontWeight: 800,
                            letterSpacing: '0.22em',
                            mb: 0.75,
                            px: 2.25,
                            textTransform: 'uppercase'
                        }}
                    >
                        {globalize.translate('ProfileSelectorMenuSwitchTo')}
                    </Typography>

                    {switchProfiles.map(profile => (
                        <ProfileSwitchMenuItem
                            apiBasePath={api?.basePath}
                            index={Math.max(0, visibleProfiles.findIndex(visibleProfile => visibleProfile.ProfileUserId === profile.ProfileUserId))}
                            key={profile.ProfileUserId || profile.Name}
                            onProfileSwitch={onProfileSwitch}
                            profile={profile}
                        />
                    ))}

                    <MenuItem
                        component={Link}
                        to={PROFILE_SELECTOR_PATH}
                        onClick={onMenuClose}
                        sx={MENU_ITEM_SX}
                    >
                        <Box
                            sx={{
                                alignItems: 'center',
                                border: '1px dashed rgba(255,255,255,0.28)',
                                borderRadius: '6px',
                                color: 'rgba(255,255,255,0.55)',
                                display: 'flex',
                                fontSize: '1.3rem',
                                height: 40,
                                justifyContent: 'center',
                                width: 40
                            }}
                        >
                            +
                        </Box>
                        <ListItemText primary={globalize.translate('ProfileSelectorMenuViewAll')} />
                        <ChevronRight
                            fontSize='small'
                            sx={{
                                color: 'rgba(255,255,255,0.32)'
                            }}
                        />
                    </MenuItem>
                </Box>
            )}

            <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

            <Box sx={{ py: 1.35 }}>
                <MenuItem
                    component={Link}
                    to={`/userprofile?userId=${user?.Id}`}
                    onClick={onMenuClose}
                    sx={MENU_ITEM_SX}
                >
                    <ListItemIcon>
                        <AccountCircle fontSize='small' />
                    </ListItemIcon>
                    <ListItemText primary={globalize.translate('ProfileSelectorMenuMyAccount')} />
                </MenuItem>

                <MenuItem
                    component={Link}
                    to='/mypreferencesmenu'
                    onClick={onMenuClose}
                    sx={MENU_ITEM_SX}
                >
                    <ListItemIcon>
                        <Settings fontSize='small' />
                    </ListItemIcon>
                    <ListItemText primary={globalize.translate('Settings')} />
                </MenuItem>
            </Box>

            {user?.Policy?.IsAdministrator && (
                <>
                    <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

                    <Box sx={{ py: 1.35 }}>
                        <Typography
                            component='p'
                            sx={{
                                alignItems: 'center',
                                color: 'rgba(255,255,255,0.40)',
                                display: 'flex',
                                fontSize: '0.72rem',
                                fontWeight: 800,
                                gap: 0.8,
                                letterSpacing: '0.22em',
                                mb: 0.75,
                                px: 2.25,
                                textTransform: 'uppercase'
                            }}
                        >
                            <Box
                                component='span'
                                sx={{
                                    backgroundColor: '#46D369',
                                    borderRadius: '50%',
                                    height: 6,
                                    width: 6
                                }}
                            />
                            {globalize.translate('HeaderAdmin')}
                        </Typography>

                        <MenuItem
                            component={Link}
                            to='/dashboard'
                            onClick={onMenuClose}
                            sx={MENU_ITEM_SX}
                        >
                            <ListItemIcon>
                                <DashboardIcon fontSize='small' />
                            </ListItemIcon>
                            <ListItemText primary={globalize.translate('TabDashboard')} />
                        </MenuItem>

                        <ServerStatusRow
                            onSelectServerClick={onSelectServerClick}
                            serverName={serverName}
                        />
                    </Box>
                </>
            )}

            <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

            <Box sx={{ py: 1.35 }}>
                {appHost.supports(AppFeature.MultiServer) && !user?.Policy?.IsAdministrator && (
                    <ServerStatusRow
                        onSelectServerClick={onSelectServerClick}
                        serverName={serverName}
                    />
                )}

                <MenuItem
                    onClick={onLogoutClick}
                    sx={{
                        ...MENU_ITEM_SX,
                        color: '#ff6b6b',
                        '& .MuiListItemIcon-root': {
                            ...MENU_ITEM_SX['& .MuiListItemIcon-root'],
                            background: 'rgba(229,9,20,0.12)',
                            color: '#ff6b6b'
                        },
                        '& .MuiListItemText-primary': {
                            ...MENU_ITEM_SX['& .MuiListItemText-primary'],
                            color: '#ff6b6b'
                        }
                    }}
                >
                    <ListItemIcon>
                        <Logout fontSize='small' />
                    </ListItemIcon>
                    <ListItemText primary={globalize.translate('ButtonSignOut')} />
                </MenuItem>

                {appHost.supports(AppFeature.ExitMenu) && (
                    <MenuItem
                        onClick={onExitAppClick}
                        sx={MENU_ITEM_SX}
                    >
                        <ListItemIcon>
                            <Close fontSize='small' />
                        </ListItemIcon>
                        <ListItemText primary={globalize.translate('ButtonExitApp')} />
                    </MenuItem>
                )}
            </Box>
        </Menu>
    );
};

export default AppUserMenu;

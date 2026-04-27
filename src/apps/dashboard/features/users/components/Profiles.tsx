import Avatar from '@mui/material/Avatar';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { UserDto } from '@jellyfin/sdk/lib/generated-client/models/user-dto';
import { useQuery } from '@tanstack/react-query';
import React, { useCallback, useEffect, useState } from 'react';

import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import confirm from 'components/confirm/confirm';
import Loading from 'components/loading/LoadingComponent';
import prompt from 'components/prompt/prompt';
import { useDeleteUser } from 'apps/dashboard/features/users/api/useDeleteUser';
import {
    isAdultVideosCollectionType,
    JellyflixCollectionType
} from 'constants/jellyflixCollectionTypes';
import { useApi } from 'hooks/useApi';
import globalize from 'lib/globalize';
import {
    clearProfilePin,
    getOwnerProfileSelector,
    parseProfileSelectorError,
    setProfilePin,
    updateProfileSelector
} from 'lib/profileSelector/api';
import { getProfileAvatarGradient } from 'lib/profileSelector/colors';

type ManagedProfile = UserDto & {
    Included: boolean;
    RequiresPin: boolean;
    IsOwner: boolean;
    DisplayOrder: number;
};

type LibraryAccessFolder = Pick<BaseItemDto, 'CollectionType' | 'Id' | 'Name'>;

type SelectorProfile = {
    ProfileUserId?: string;
    RequiresPin?: boolean;
    DisplayOrder?: number;
};

type ProfileSelectorState = {
    IsEnabled?: boolean;
    AutoSelectSingleProfile?: boolean;
    Profiles?: SelectorProfile[];
};

type ProfilesProps = {
    ownerUserId: string
};

type ProfileSelectorUserRowProps = {
    disabled: boolean;
    index: number;
    mediaFolders: LibraryAccessFolder[];
    profile: ManagedProfile;
    imageUrl?: string;
    onIncludedChange: (profileUserId: string, included: boolean) => void;
    onDeleteClick: (profile: ManagedProfile) => void;
    onLibraryAccessChange: (profileUserId: string, folderId: string, checked: boolean) => void;
    onPinClick: (profile: ManagedProfile) => void;
};

const LIBRARY_ORDER = new Map<string, number>([
    [ CollectionType.Movies, 10 ],
    [ CollectionType.Tvshows, 20 ],
    [ JellyflixCollectionType.Courses, 30 ],
    [ JellyflixCollectionType.AdultVideos, 40 ]
]);

function getLibrarySortOrder(folder: LibraryAccessFolder) {
    return LIBRARY_ORDER.get(folder.CollectionType || '') ?? 100;
}

function sortLibraryAccessFolders(mediaFolders: LibraryAccessFolder[]) {
    return [ ...mediaFolders ]
        .filter(folder => !!folder.Id)
        .sort((left, right) => {
            const orderDiff = getLibrarySortOrder(left) - getLibrarySortOrder(right);
            if (orderDiff !== 0) {
                return orderDiff;
            }

            return (left.Name || '').localeCompare(right.Name || '');
        });
}

function isLibrarySelectedForProfile(profile: ManagedProfile, folder: LibraryAccessFolder) {
    const enabledFolders = profile.Policy?.EnabledFolders || [];
    const isExplicitAdultFolder = isAdultVideosCollectionType(folder.CollectionType);

    if (isExplicitAdultFolder) {
        return enabledFolders.includes(folder.Id || '');
    }

    return Boolean(profile.Policy?.EnableAllFolders || enabledFolders.includes(folder.Id || ''));
}

function updateProfileLibraryAccess(
    profile: ManagedProfile,
    mediaFolders: LibraryAccessFolder[],
    folderId: string,
    checked: boolean
): ManagedProfile {
    if (!profile.Policy) {
        return profile;
    }

    const currentSelectedFolderIds = new Set(
        mediaFolders
            .filter(folder => folder.Id && isLibrarySelectedForProfile(profile, folder))
            .map(folder => folder.Id!)
    );

    if (checked) {
        currentSelectedFolderIds.add(folderId);
    } else {
        currentSelectedFolderIds.delete(folderId);
    }

    const adultFolderIds = new Set(
        mediaFolders
            .filter(folder => folder.Id && isAdultVideosCollectionType(folder.CollectionType))
            .map(folder => folder.Id!)
    );
    const regularFolderIds = mediaFolders
        .filter(folder => folder.Id && !adultFolderIds.has(folder.Id))
        .map(folder => folder.Id!);
    const areAllRegularFoldersSelected = regularFolderIds.length > 0
        && regularFolderIds.every(id => currentSelectedFolderIds.has(id));
    const enabledFolders = Array.from(currentSelectedFolderIds)
        .filter(id => !areAllRegularFoldersSelected || adultFolderIds.has(id));

    return {
        ...profile,
        Policy: {
            ...profile.Policy,
            EnableAllFolders: areAllRegularFoldersSelected,
            EnabledFolders: enabledFolders
        }
    };
}

function buildManagedProfiles(users: UserDto[], selector: ProfileSelectorState | null | undefined, ownerUserId: string): ManagedProfile[] {
    const selectorProfiles = selector?.Profiles || [];
    const selectorProfilesById = new Map<string, SelectorProfile>(
        selectorProfiles
            .filter(profile => !!profile.ProfileUserId)
            .map(profile => [ profile.ProfileUserId!, profile ])
    );

    return users
        .filter(user => !!user.Id)
        .map((user, index) => {
            const selectorProfile = selectorProfilesById.get(user.Id || '');

            return {
                ...user,
                Included: selector ? !!selectorProfile : !user.Policy?.IsDisabled,
                RequiresPin: !!selectorProfile?.RequiresPin,
                IsOwner: user.Id === ownerUserId,
                DisplayOrder: selectorProfile?.DisplayOrder ?? index
            };
        })
        .sort((left, right) => {
            if (left.IsOwner !== right.IsOwner) {
                return left.IsOwner ? -1 : 1;
            }

            if (left.DisplayOrder !== right.DisplayOrder) {
                return left.DisplayOrder - right.DisplayOrder;
            }

            return (left.Name || '').localeCompare(right.Name || '');
        });
}

function buildSelectorPayload(isEnabled: boolean, autoSelectSingleProfile: boolean, profiles: ManagedProfile[]) {
    return {
        IsEnabled: isEnabled,
        AutoSelectSingleProfile: autoSelectSingleProfile,
        Profiles: profiles
            .filter(profile => profile.Included)
            .map((profile, index) => ({
                ProfileUserId: profile.Id,
                DisplayOrder: index,
                IsVisible: true
            }))
    };
}

async function promptForPin(profileName?: string | null) {
    return prompt({
        title: globalize.translate('ProfileSelectorPinTitle', profileName || ''),
        label: globalize.translate('LabelPasswordRecoveryPinCode'),
        description: globalize.translate('ProfileSelectorPinDescription'),
        confirmText: globalize.translate('ButtonOk'),
        inputType: 'password',
        inputMode: 'numeric',
        autocomplete: 'off',
        maxLength: 8,
        pattern: '[0-9]*'
    });
}

const ProfileSelectorUserRow = ({
    disabled,
    imageUrl,
    index,
    mediaFolders,
    profile,
    onDeleteClick,
    onIncludedChange,
    onLibraryAccessChange,
    onPinClick
}: ProfileSelectorUserRowProps) => {
    const profileId = profile.Id || '';
    const initial = profile.Name?.trim().charAt(0).toUpperCase();

    const handleIncludedChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        onIncludedChange(profileId, event.target.checked);
    }, [ onIncludedChange, profileId ]);

    const handlePinClick = useCallback(() => {
        onPinClick(profile);
    }, [ onPinClick, profile ]);

    const handleDeleteClick = useCallback(() => {
        onDeleteClick(profile);
    }, [ onDeleteClick, profile ]);

    const handleLibraryAccessChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        onLibraryAccessChange(profileId, event.target.name, event.target.checked);
    }, [ onLibraryAccessChange, profileId ]);

    return (
        <Card variant='outlined'>
            <CardContent>
                <Stack
                    direction={{
                        xs: 'column',
                        sm: 'row'
                    }}
                    spacing={2}
                    alignItems={{
                        xs: 'flex-start',
                        sm: 'center'
                    }}
                    justifyContent='space-between'
                >
                    <Stack direction='row' spacing={2} alignItems='center'>
                        <Avatar
                            src={imageUrl}
                            sx={{
                                width: 72,
                                height: 72,
                                borderRadius: '18px',
                                background: imageUrl ? undefined : getProfileAvatarGradient(index),
                                color: '#fff',
                                fontSize: '2.4rem',
                                fontWeight: 800
                            }}
                        >
                            {imageUrl ? null : initial}
                        </Avatar>

                        <Box>
                            <Typography variant='h3'>{profile.Name}</Typography>
                            <Typography variant='body2' color='text.secondary'>
                                {profile.IsOwner ? globalize.translate('ProfileSelectorOwnerDescription') : ''}
                            </Typography>
                        </Box>
                    </Stack>

                    <Stack spacing={1} sx={{ minWidth: { sm: 340 } }}>
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={profile.Included}
                                    disabled={disabled || profile.Policy?.IsDisabled}
                                    onChange={handleIncludedChange}
                                />
                            }
                            label={globalize.translate('ProfileSelectorIncludedLabel')}
                        />

                        <Button
                            variant='outlined'
                            disabled={disabled || !profile.Included}
                            onClick={handlePinClick}
                        >
                            {profile.RequiresPin ?
                                globalize.translate('ProfileSelectorPinClear') :
                                globalize.translate('ProfileSelectorPinSet')}
                        </Button>

                        {!profile.IsOwner && (
                            <Button
                                color='error'
                                disabled={disabled}
                                variant='text'
                                onClick={handleDeleteClick}
                            >
                                {globalize.translate('Delete')}
                            </Button>
                        )}
                    </Stack>
                </Stack>

                {mediaFolders.length > 0 && (
                    <Box
                        sx={{
                            borderTop: '1px solid rgba(255, 255, 255, 0.12)',
                            mt: 2,
                            pt: 2
                        }}
                    >
                        <Typography variant='h4'>
                            {globalize.translate('HeaderLibraries')}
                        </Typography>
                        <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
                            {globalize.translate('ProfileSelectorLibraryAccessHelp')}
                        </Typography>

                        <Box
                            sx={{
                                display: 'grid',
                                gap: 1,
                                gridTemplateColumns: {
                                    xs: '1fr',
                                    sm: 'repeat(2, minmax(0, 1fr))',
                                    lg: 'repeat(4, minmax(0, 1fr))'
                                }
                            }}
                        >
                            {mediaFolders.map(folder => (
                                <FormControlLabel
                                    key={folder.Id}
                                    control={
                                        <Checkbox
                                            checked={isLibrarySelectedForProfile(profile, folder)}
                                            disabled={disabled || !profile.Included}
                                            name={folder.Id || ''}
                                            onChange={handleLibraryAccessChange}
                                        />
                                    }
                                    label={folder.Name}
                                />
                            ))}
                        </Box>
                    </Box>
                )}
            </CardContent>
        </Card>
    );
};

const Profiles = ({ ownerUserId }: ProfilesProps) => {
    const { __legacyApiClient__ } = useApi();
    const deleteUser = useDeleteUser();
    const [ isEnabled, setIsEnabled ] = useState(true);
    const [ autoSelectSingleProfile, setAutoSelectSingleProfile ] = useState(false);
    const [ mediaFolders, setMediaFolders ] = useState<LibraryAccessFolder[]>([]);
    const [ managedProfiles, setManagedProfiles ] = useState<ManagedProfile[]>([]);
    const [ message, setMessage ] = useState<string | null>(null);
    const [ error, setError ] = useState<string | null>(null);
    const [ isSaving, setIsSaving ] = useState(false);

    const {
        data,
        isError,
        isPending,
        refetch
    } = useQuery({
        queryKey: [ 'DashboardProfileSelector', __legacyApiClient__?.serverId(), ownerUserId ],
        queryFn: async () => {
            const [ selector, users, mediaFoldersResponse ] = await Promise.all([
                getOwnerProfileSelector(__legacyApiClient__!, ownerUserId),
                __legacyApiClient__!.getUsers(),
                __legacyApiClient__!.getJSON(__legacyApiClient__!.getUrl('Library/MediaFolders', {
                    IsHidden: false
                }))
            ]);

            return {
                selector: selector as ProfileSelectorState | null,
                users: users as UserDto[],
                mediaFolders: sortLibraryAccessFolders(mediaFoldersResponse.Items || [])
            };
        },
        enabled: !!__legacyApiClient__ && !!ownerUserId
    });

    useEffect(() => {
        if (!data) {
            return;
        }

        setIsEnabled(data.selector?.IsEnabled ?? true);
        setAutoSelectSingleProfile(data.selector?.AutoSelectSingleProfile ?? false);
        setMediaFolders(data.mediaFolders);
        setManagedProfiles(buildManagedProfiles(data.users, data.selector, ownerUserId));
    }, [ data, ownerUserId ]);

    const handleEnabledChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        setIsEnabled(event.target.checked);
    }, []);

    const handleAutoSelectChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        setAutoSelectSingleProfile(event.target.checked);
    }, []);

    const handleIncludedChange = useCallback((profileUserId: string, included: boolean) => {
        setManagedProfiles(profiles => profiles.map(profile => (
            profile.Id === profileUserId ? {
                ...profile,
                Included: included
            } : profile
        )));
    }, []);

    const handleLibraryAccessChange = useCallback((profileUserId: string, folderId: string, checked: boolean) => {
        setManagedProfiles(profiles => profiles.map(profile => (
            profile.Id === profileUserId ?
                updateProfileLibraryAccess(profile, mediaFolders, folderId, checked) :
                profile
        )));
    }, [ mediaFolders ]);

    const handlePinClick = useCallback(async (profile: ManagedProfile) => {
        if (!__legacyApiClient__ || !profile.Id) {
            return;
        }

        setMessage(null);
        setError(null);
        setIsSaving(true);

        try {
            if (profile.RequiresPin) {
                await clearProfilePin(__legacyApiClient__, ownerUserId, profile.Id);
            } else {
                const pin = await promptForPin(profile.Name);
                await setProfilePin(__legacyApiClient__, ownerUserId, profile.Id, pin);
            }

            await refetch();
            setMessage(globalize.translate('SettingsSaved'));
        } catch (response) {
            if (!response) {
                return;
            }

            const parsedError = await parseProfileSelectorError(response);
            if (parsedError.status) {
                setError(parsedError.detail || globalize.translate('MessageUnableToConnectToServer'));
            }
        } finally {
            setIsSaving(false);
        }
    }, [ __legacyApiClient__, ownerUserId, refetch ]);

    const handleDeleteClick = useCallback(async (profile: ManagedProfile) => {
        if (!profile.Id || profile.IsOwner) {
            return;
        }

        try {
            await confirm({
                title: globalize.translate('DeleteName', profile.Name || ''),
                text: globalize.translate('DeleteUserConfirmation'),
                confirmText: globalize.translate('Delete'),
                primary: 'delete'
            });
        } catch {
            return;
        }

        setMessage(null);
        setError(null);
        setIsSaving(true);

        try {
            await deleteUser.mutateAsync({
                userId: profile.Id
            });
            await refetch();
            setMessage(globalize.translate('SettingsSaved'));
        } catch {
            setError(globalize.translate('MessageUnableToConnectToServer'));
        } finally {
            setIsSaving(false);
        }
    }, [ deleteUser, refetch ]);

    const handleSaveClick = useCallback(async () => {
        if (!__legacyApiClient__) {
            return;
        }

        if (!managedProfiles.some(profile => profile.Included)) {
            setError(globalize.translate('ProfileSelectorSelectAtLeastOne'));
            return;
        }

        setMessage(null);
        setError(null);
        setIsSaving(true);

        try {
            await updateProfileSelector(
                __legacyApiClient__,
                ownerUserId,
                buildSelectorPayload(isEnabled, autoSelectSingleProfile, managedProfiles)
            );
            await Promise.all(managedProfiles
                .filter(profile => !!profile.Id && !!profile.Policy)
                .map(profile => __legacyApiClient__.updateUserPolicy(profile.Id!, profile.Policy!)));
            await refetch();
            setMessage(globalize.translate('SettingsSaved'));
        } catch (response) {
            const parsedError = await parseProfileSelectorError(response);
            setError(parsedError.detail || globalize.translate('MessageUnableToConnectToServer'));
        } finally {
            setIsSaving(false);
        }
    }, [ __legacyApiClient__, autoSelectSingleProfile, isEnabled, managedProfiles, ownerUserId, refetch ]);

    if (isPending) {
        return <Loading />;
    }

    if (isError) {
        return (
            <Alert severity='error'>
                {globalize.translate('MessageUnableToConnectToServer')}
            </Alert>
        );
    }

    return (
        <Stack spacing={2} className='readOnlyContent'>
            <Typography variant='body1' color='text.secondary'>
                {globalize.translate('ProfileSelectorManageSubtitle')}
            </Typography>

            {message && <Alert severity='success'>{message}</Alert>}
            {error && <Alert severity='error'>{error}</Alert>}

            <Stack spacing={1}>
                <FormControlLabel
                    control={
                        <Checkbox
                            checked={isEnabled}
                            disabled={isSaving}
                            onChange={handleEnabledChange}
                        />
                    }
                    label={globalize.translate('ProfileSelectorEnabledLabel')}
                />

                <FormControlLabel
                    control={
                        <Checkbox
                            checked={autoSelectSingleProfile}
                            disabled={isSaving}
                            onChange={handleAutoSelectChange}
                        />
                    }
                    label={globalize.translate('ProfileSelectorAutoSelectLabel')}
                />
            </Stack>

            <Stack spacing={2}>
                {managedProfiles.map((profile, index) => (
                    <ProfileSelectorUserRow
                        key={profile.Id}
                        disabled={isSaving}
                        imageUrl={
                            profile.PrimaryImageTag && __legacyApiClient__ && profile.Id ?
                                __legacyApiClient__.getUserImageUrl(profile.Id, {
                                    width: 240,
                                    tag: profile.PrimaryImageTag,
                                    type: 'Primary'
                                }) :
                                undefined
                        }
                        index={index}
                        mediaFolders={mediaFolders}
                        profile={profile}
                        onDeleteClick={handleDeleteClick}
                        onIncludedChange={handleIncludedChange}
                        onLibraryAccessChange={handleLibraryAccessChange}
                        onPinClick={handlePinClick}
                    />
                ))}
            </Stack>

            <Button
                variant='contained'
                disabled={isSaving}
                onClick={handleSaveClick}
                sx={{ alignSelf: 'flex-start' }}
            >
                {globalize.translate('Save')}
            </Button>
        </Stack>
    );
};

export default Profiles;

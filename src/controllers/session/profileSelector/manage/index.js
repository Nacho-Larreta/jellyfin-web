import escapeHtml from 'escape-html';

import loading from 'components/loading/loading';
import prompt from 'components/prompt/prompt';
import toast from 'components/toast/toast';
import alert from 'components/alert';
import focusManager from 'components/focusManager';
import layoutManager from 'components/layoutManager';
import { getDefaultBackgroundClass } from 'components/cardbuilder/utils/builder';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import libraryMenu from 'scripts/libraryMenu';
import Dashboard from 'utils/dashboard';

import {
    clearProfilePin,
    getCurrentProfileSelector,
    getOwnerProfileSelector,
    parseProfileSelectorError,
    setProfilePin,
    updateProfileSelector
} from '../../../../lib/profileSelector/api';
import { getProfileAvatarColorClass } from '../../../../lib/profileSelector/colors';
import { getProfileSelectorRoute } from '../../../../lib/profileSelector/utils';

import '../profileSelector.scss';

function getApiClient() {
    return ServerConnections.currentApiClient();
}

function getServerName(apiClient) {
    return apiClient.serverInfo()?.Name || apiClient.serverAddress();
}

function getProfileMeta(profile) {
    if (profile.IsOwner) {
        return globalize.translate('ProfileSelectorOwnerDescription');
    }

    if (profile.HasParentalRestrictions) {
        return globalize.translate('ProfileSelectorKidsDescription');
    }

    if (profile.Policy?.IsAdministrator) {
        return globalize.translate('ProfileSelectorOwnerDescription');
    }

    return '';
}

function getProfileAvatarMarkup(apiClient, profile, index) {
    if (profile.PrimaryImageTag) {
        const imageUrl = apiClient.getUserImageUrl(profile.Id, {
            width: 320,
            tag: profile.PrimaryImageTag,
            type: 'Primary'
        });

        return `<div class="profileSelectorCardAvatar" style="background-image:url('${imageUrl}');"></div>`;
    }

    const initial = escapeHtml((profile.Name || '?').slice(0, 1).toUpperCase());
    return `<div class="profileSelectorCardAvatar ${getDefaultBackgroundClass(profile.Name)} ${getProfileAvatarColorClass(index)}"><div class="profileSelectorCardInitial">${initial}</div></div>`;
}

function buildManagedProfiles(users, selector, ownerUserId) {
    const selectorProfiles = selector?.Profiles || [];
    const selectorProfilesById = new Map(selectorProfiles.map(profile => [profile.ProfileUserId, profile]));

    return users
        .filter(user => !!user.Id)
        .map(user => {
            const selectorProfile = selectorProfilesById.get(user.Id);

            return {
                ...user,
                Included: selector ? !!selectorProfile : !user.Policy?.IsDisabled,
                RequiresPin: !!selectorProfile?.RequiresPin,
                IsOwner: user.Id === ownerUserId,
                HasParentalRestrictions: selectorProfile?.HasParentalRestrictions
                    || !!user.Policy?.BlockedTags?.length
                    || !!user.Policy?.BlockedMediaFolders?.length
                    || !user.Policy?.EnableAllFolders,
                DisplayOrder: selectorProfile?.DisplayOrder ?? Number.MAX_SAFE_INTEGER
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

function getManagedProfilesMarkup(apiClient, managedProfiles) {
    if (!managedProfiles.length) {
        return `<p class="profileSelectorManageEmpty">${escapeHtml(globalize.translate('ProfileSelectorNoProfilesAvailable'))}</p>`;
    }

    return managedProfiles.map((profile, index) => {
        const badge = profile.HasParentalRestrictions ?
            `<span class="profileSelectorCardBadge">${escapeHtml(globalize.translate('Kids').toUpperCase())}</span>` :
            '';

        const pinLabel = profile.RequiresPin ? globalize.translate('ProfileSelectorPinClear') : globalize.translate('ProfileSelectorPinSet');

        return `
            <div class="profileSelectorManageRow" data-profile-userid="${profile.Id}">
                <div class="profileSelectorManageIdentity">
                    <div class="profileSelectorManageAvatarFrame">
                        ${getProfileAvatarMarkup(apiClient, profile, index)}
                        ${badge}
                    </div>
                    <div class="profileSelectorManageCopy">
                        <div class="profileSelectorManageName">${escapeHtml(profile.Name || '')}</div>
                        <div class="profileSelectorManageMeta">${escapeHtml(getProfileMeta(profile))}</div>
                    </div>
                </div>

                <div class="profileSelectorManageActions">
                    <label class="checkboxContainer">
                        <input is="emby-checkbox" type="checkbox" class="chkManagedProfileIncluded" ${profile.Included ? 'checked' : ''} ${profile.Policy?.IsDisabled ? 'disabled' : ''} />
                        <span>${globalize.translate('ProfileSelectorIncludedLabel')}</span>
                    </label>

                    <button is="emby-button" type="button" class="block btnToggleProfilePin" ${profile.Included ? '' : 'disabled'}>
                        <span>${escapeHtml(pinLabel)}</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function promptForPin(profileName) {
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

export default function(view) {
    let ownerUserId = null;
    let managedProfiles = [];

    function renderManagedProfiles() {
        const apiClient = getApiClient();
        view.querySelector('.profileSelectorManageList').innerHTML = getManagedProfilesMarkup(apiClient, managedProfiles);

        if (layoutManager.tv) {
            focusManager.autoFocus(view);
        }
    }

    async function loadManagementState() {
        const apiClient = getApiClient();
        if (!apiClient) {
            Dashboard.navigate('login');
            return;
        }

        loading.show();

        try {
            const [ currentUser, currentSelector, users ] = await Promise.all([
                apiClient.getCurrentUser(),
                getCurrentProfileSelector(apiClient),
                apiClient.getUsers()
            ]);

            if (!currentUser?.Policy?.IsAdministrator && !currentSelector?.CanManageProfiles) {
                Dashboard.navigate('/home');
                return;
            }

            ownerUserId = currentSelector?.OwnerUserId || currentUser.Id;
            const selector = ownerUserId ?
                await getOwnerProfileSelector(apiClient, ownerUserId).catch(err => {
                    console.warn('[ProfileSelectorManagePage] falling back to current selector', err);
                    return currentSelector;
                }) :
                currentSelector;

            managedProfiles = buildManagedProfiles(users, selector, ownerUserId);

            const serverNameElement = view.querySelector('.profileSelectorServerName');
            if (serverNameElement) {
                serverNameElement.textContent = getServerName(apiClient);
            }
            view.querySelector('.chkProfileSelectorEnabled').checked = selector?.IsEnabled ?? true;
            view.querySelector('.chkProfileSelectorAutoSelect').checked = selector?.AutoSelectSingleProfile ?? false;

            renderManagedProfiles();
        } catch (err) {
            console.error('[ProfileSelectorManagePage] failed to load state', err);
            Dashboard.navigate(getProfileSelectorRoute());
        } finally {
            loading.hide();
        }
    }

    async function onPinButtonClick(button) {
        const row = button.closest('.profileSelectorManageRow');
        const profile = managedProfiles.find(item => item.Id === row?.getAttribute('data-profile-userid'));
        if (!profile || !ownerUserId) {
            return;
        }

        let pin = null;

        try {
            pin = await promptForPin(profile.Name);
        } catch {
            return;
        }

        try {
            loading.show();
            const apiClient = getApiClient();

            if (profile.RequiresPin) {
                await clearProfilePin(apiClient, ownerUserId, profile.Id, pin);
                profile.RequiresPin = false;
            } else {
                await setProfilePin(apiClient, ownerUserId, profile.Id, pin);
                profile.RequiresPin = true;
            }

            renderManagedProfiles();
        } catch (response) {
            if (response) {
                const error = await parseProfileSelectorError(response);
                if (error.detail) {
                    alert({
                        title: globalize.translate('HeaderError'),
                        text: error.detail
                    });
                }
            }
        } finally {
            loading.hide();
        }
    }

    async function onSaveProfilesClick() {
        const selectedProfiles = managedProfiles.filter(profile => profile.Included);
        if (selectedProfiles.length === 0) {
            alert({
                title: globalize.translate('HeaderError'),
                text: globalize.translate('ProfileSelectorSelectAtLeastOne')
            });
            return;
        }

        loading.show();

        try {
            const apiClient = getApiClient();
            const payload = {
                IsEnabled: view.querySelector('.chkProfileSelectorEnabled').checked,
                AutoSelectSingleProfile: view.querySelector('.chkProfileSelectorAutoSelect').checked,
                Profiles: selectedProfiles.map((profile, index) => ({
                    ProfileUserId: profile.Id,
                    DisplayOrder: index,
                    IsVisible: true
                }))
            };

            await updateProfileSelector(apiClient, ownerUserId, payload);
            ServerConnections.setProfileSelectorAvailability(apiClient.serverId(), payload.IsEnabled);
            toast(globalize.translate('SettingsSaved'));
            Dashboard.navigate(getProfileSelectorRoute());
        } catch (response) {
            const error = await parseProfileSelectorError(response);
            alert({
                title: globalize.translate('HeaderError'),
                text: error.detail || globalize.translate('MessageUnableToConnectToServer')
            });
        } finally {
            loading.hide();
        }
    }

    view.querySelector('.profileSelectorManageList').addEventListener('change', event => {
        const checkbox = event.target.closest('.chkManagedProfileIncluded');
        if (!checkbox) {
            return;
        }

        const row = checkbox.closest('.profileSelectorManageRow');
        const profile = managedProfiles.find(item => item.Id === row?.getAttribute('data-profile-userid'));
        if (!profile) {
            return;
        }

        profile.Included = checkbox.checked;
        renderManagedProfiles();
    });

    view.querySelector('.profileSelectorManageList').addEventListener('click', event => {
        const button = event.target.closest('.btnToggleProfilePin');
        if (!button) {
            return;
        }

        void onPinButtonClick(button);
    });

    view.querySelector('.btnSaveProfiles').addEventListener('click', () => {
        void onSaveProfilesClick();
    });

    view.querySelector('.btnBackToSelector').addEventListener('click', () => {
        Dashboard.navigate(getProfileSelectorRoute());
    });

    view.addEventListener('viewshow', () => {
        document.documentElement.classList.add('profileSelectorViewportLocked');
        window.scrollTo(0, 0);
        libraryMenu.setTransparentMenu(true);
        loadManagementState();
    });

    view.addEventListener('viewhide', () => {
        document.documentElement.classList.remove('profileSelectorViewportLocked');
        libraryMenu.setTransparentMenu(false);
    });
}

import escapeHtml from 'escape-html';
import formatDistanceToNow from 'date-fns/formatDistanceToNow';

import loading from 'components/loading/loading';
import prompt from 'components/prompt/prompt';
import layoutManager from 'components/layoutManager';
import libraryMenu from 'scripts/libraryMenu';
import focusManager from 'components/focusManager';
import datetime from 'scripts/datetime';
import { getDefaultBackgroundClass } from 'components/cardbuilder/utils/builder';
import { getLocaleWithSuffix } from 'utils/dateFnsLocale';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Dashboard from 'utils/dashboard';
import toast from 'components/toast/toast';
import alert from 'components/alert';

import { activateProfileSession, reloadIntoProfileTarget } from '../../../lib/profileSelector/activation';
import {
    createProfileBackingUser,
    getCurrentProfileSelector,
    getOwnerProfileSelector,
    parseProfileSelectorError,
    updateProfileSelector
} from '../../../lib/profileSelector/api';
import { getProfileAvatarColorClass } from '../../../lib/profileSelector/colors';
import { getManageProfileSelectorRoute, getVisibleProfiles } from '../../../lib/profileSelector/utils';

import './profileSelector.scss';

function getApiClient() {
    return ServerConnections.currentApiClient();
}

function getTargetUrl(params) {
    if (params.url) {
        try {
            return decodeURIComponent(params.url);
        } catch (err) {
            console.warn('[ProfileSelectorPage] unable to decode url param', params.url, err);
        }
    }

    return '/home';
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

    const activityDate = profile.LastActivityDate || profile.LastLoginDate;
    if (!activityDate) {
        return '';
    }

    try {
        return globalize.translate('LastSeen', formatDistanceToNow(Date.parse(activityDate), getLocaleWithSuffix()));
    } catch {
        return datetime.toLocaleDateString(new Date(activityDate));
    }
}

function getProfileAvatarMarkup(apiClient, profile, index) {
    if (profile.PrimaryImageTag) {
        const imageUrl = apiClient.getUserImageUrl(profile.ProfileUserId, {
            width: 480,
            tag: profile.PrimaryImageTag,
            type: 'Primary'
        });

        return `<div class="profileSelectorCardAvatar" style="background-image:url('${imageUrl}');"></div>`;
    }

    const initial = escapeHtml((profile.Name || '?').slice(0, 1).toUpperCase());
    return `<div class="profileSelectorCardAvatar ${getDefaultBackgroundClass(profile.Name)} ${getProfileAvatarColorClass(index)}"><div class="profileSelectorCardInitial">${initial}</div></div>`;
}

function getProfileCardMarkup(apiClient, profile, index) {
    const badges = [];

    if (profile.HasParentalRestrictions) {
        badges.push(`<span class="profileSelectorCardBadge">${escapeHtml(globalize.translate('Kids').toUpperCase())}</span>`);
    }

    if (profile.IsActive) {
        badges.push('<span class="profileSelectorCardActive" aria-hidden="true"></span>');
    }

    if (profile.RequiresPin) {
        badges.push('<span class="profileSelectorCardLock material-icons" aria-hidden="true">lock</span>');
    }

    return `
        <button type="button" class="profileSelectorCard card" data-profile-userid="${profile.ProfileUserId}">
            <div class="profileSelectorCardFrame">
                ${getProfileAvatarMarkup(apiClient, profile, index)}
                ${badges.join('')}
            </div>
            <div class="profileSelectorCardBody">
                <div class="profileSelectorCardTitle">${escapeHtml(profile.Name || '')}</div>
                <div class="profileSelectorCardMeta">${escapeHtml(getProfileMeta(profile))}</div>
            </div>
        </button>
    `;
}

function getAddProfileCardMarkup() {
    return `
        <button type="button" class="profileSelectorCard card" data-action="add-profile">
            <div class="profileSelectorCardFrame profileSelectorCardAdd">
                <span class="material-icons profileSelectorCardAddIcon" aria-hidden="true">add</span>
            </div>
            <div class="profileSelectorCardBody">
                <div class="profileSelectorCardTitle">${escapeHtml(globalize.translate('ProfileSelectorAddProfileTitle'))}</div>
                <div class="profileSelectorCardMeta">${escapeHtml(globalize.translate('ProfileSelectorAddProfileDescription'))}</div>
            </div>
        </button>
    `;
}

function renderProfileCards(view, apiClient, selector) {
    const profilesMarkup = getVisibleProfiles(selector)
        .map((profile, index) => getProfileCardMarkup(apiClient, profile, index))
        .join('');

    const addProfileMarkup = selector.CanManageProfiles ? getAddProfileCardMarkup() : '';
    view.querySelector('#profileSelectorCards').innerHTML = profilesMarkup + addProfileMarkup;

    const subtitle = selector.IsCurrentUserOwner ?
        globalize.translate('ProfileSelectorSubtitleOwner', selector.OwnerUserName || '') :
        globalize.translate('ProfileSelectorSubtitle');

    view.querySelector('.profileSelectorSubtitle').textContent = subtitle.trim();
    const serverNameElement = view.querySelector('.profileSelectorServerName');
    if (serverNameElement) {
        serverNameElement.textContent = getServerName(apiClient);
    }

    const manageProfilesButton = view.querySelector('.btnManageProfiles');
    if (selector.CanManageProfiles) {
        manageProfilesButton.classList.remove('hide');
    } else {
        manageProfilesButton.classList.add('hide');
    }
}

async function requestProfilePin(profile) {
    return prompt({
        title: globalize.translate('ProfileSelectorPinTitle', profile.Name || ''),
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

async function requestNewProfileName() {
    try {
        const profileName = await prompt({
            title: globalize.translate('ProfileSelectorCreateTitle'),
            label: globalize.translate('LabelName'),
            description: globalize.translate('ProfileSelectorCreateDescription'),
            confirmText: globalize.translate('ProfileSelectorAddProfileTitle'),
            inputType: 'text',
            autocomplete: 'off',
            maxLength: 64
        });

        return profileName?.trim();
    } catch {
        return null;
    }
}

function generateProfilePassword(selector, profileName) {
    const browserCrypto = window['crypto'];
    if (browserCrypto?.getRandomValues) {
        const bytes = new Uint8Array(24);
        browserCrypto.getRandomValues(bytes);
        return Array.prototype.map.call(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    const selectorId = selector?.ProfileSelectorId || 'selector';
    const ownerId = selector?.OwnerUserId || 'owner';
    const entropy = `${Date.now().toString(36)}-${profileName.length.toString(36)}`;

    return `profile-${selectorId.replace(/-/g, '')}-${ownerId.replace(/-/g, '')}-${entropy}`;
}

function buildProfileSelectorUpdatePayload(selector, newProfileUserId) {
    const profiles = selector?.Profiles || [];
    const profileIds = new Set();
    const payloadProfiles = profiles
        .filter(profile => profile?.ProfileUserId)
        .map((profile, index) => {
            profileIds.add(profile.ProfileUserId);

            return {
                ProfileUserId: profile.ProfileUserId,
                DisplayOrder: Number.isFinite(profile.DisplayOrder) ? profile.DisplayOrder : index,
                IsVisible: profile.IsVisible !== false
            };
        });

    if (newProfileUserId && !profileIds.has(newProfileUserId)) {
        const nextDisplayOrder = payloadProfiles.length === 0 ?
            0 :
            Math.max(...payloadProfiles.map(profile => profile.DisplayOrder)) + 1;

        payloadProfiles.push({
            ProfileUserId: newProfileUserId,
            DisplayOrder: nextDisplayOrder,
            IsVisible: true
        });
    }

    return {
        IsEnabled: selector?.IsEnabled !== false,
        AutoSelectSingleProfile: !!selector?.AutoSelectSingleProfile,
        Profiles: payloadProfiles
    };
}

async function getWritableProfileSelector(apiClient, selector) {
    if (!selector?.OwnerUserId) {
        return selector;
    }

    try {
        return await getOwnerProfileSelector(apiClient, selector.OwnerUserId);
    } catch (err) {
        console.warn('[ProfileSelectorPage] falling back to current selector for profile creation', err);
        return selector;
    }
}

async function createProfileFromSelector(view, selector) {
    const name = await requestNewProfileName();
    if (!name) {
        return selector;
    }

    loading.show();

    try {
        const apiClient = getApiClient();
        const writableSelector = await getWritableProfileSelector(apiClient, selector);
        const ownerUserId = writableSelector?.OwnerUserId || selector?.OwnerUserId;

        if (!ownerUserId) {
            throw new Error('Profile selector owner is missing.');
        }

        const profileUser = await createProfileBackingUser(apiClient, name, generateProfilePassword(writableSelector, name));
        const payload = buildProfileSelectorUpdatePayload(writableSelector, profileUser.Id);
        const updatedSelector = await updateProfileSelector(apiClient, ownerUserId, payload);

        ServerConnections.setProfileSelectorAvailability(apiClient.serverId(), payload.IsEnabled);
        renderProfileCards(view, apiClient, updatedSelector);
        toast(globalize.translate('ProfileSelectorProfileCreated'));

        return updatedSelector;
    } catch (response) {
        const error = await parseProfileSelectorError(response);
        alert({
            title: globalize.translate('HeaderError'),
            text: error.detail || globalize.translate('MessageUnableToConnectToServer')
        });

        return selector;
    } finally {
        loading.hide();
    }
}

async function handleProfileActivationError(profile, response) {
    const error = await parseProfileSelectorError(response);

    if (error.code === 'PROFILE_PIN_REQUIRED') {
        let pin = null;

        try {
            pin = await requestProfilePin(profile);
        } catch {
            return {
                shouldRetry: false,
                pin: null
            };
        }

        return {
            shouldRetry: true,
            pin
        };
    }

    const message = error.detail || globalize.translate('MessageUnableToConnectToServer');
    if (error.status === 423) {
        toast(message);
    } else {
        alert({
            title: globalize.translate('HeaderError'),
            text: message
        });
    }

    return {
        shouldRetry: false,
        pin: null
    };
}

async function activateSelectedProfile(view, params, profile, pin) {
    const apiClient = getApiClient();
    loading.show();

    try {
        await activateProfileSession(apiClient, profile, pin);
        reloadIntoProfileTarget(getTargetUrl(params));
    } catch (response) {
        loading.hide();
        const retry = await handleProfileActivationError(profile, response);
        if (retry.shouldRetry) {
            return activateSelectedProfile(view, params, profile, retry.pin);
        }
    } finally {
        loading.hide();
    }
}

export default function(view, params) {
    let currentSelector = null;

    function findProfile(profileUserId) {
        return getVisibleProfiles(currentSelector).find(profile => profile.ProfileUserId === profileUserId) || null;
    }

    function onCardsClick(event) {
        const card = event.target.closest('.profileSelectorCard');
        if (!card) {
            return;
        }

        const action = card.getAttribute('data-action');
        if (action === 'add-profile') {
            void createProfileFromSelector(view, currentSelector).then(selector => {
                currentSelector = selector;
            });
            return;
        }

        const profileUserId = card.getAttribute('data-profile-userid');
        const profile = findProfile(profileUserId);
        if (!profile) {
            return;
        }

        void activateSelectedProfile(view, params, profile, null);
    }

    function loadSelector() {
        const apiClient = getApiClient();
        if (!apiClient) {
            Dashboard.navigate('login');
            return;
        }

        loading.show();
        getCurrentProfileSelector(apiClient).then(selector => {
            currentSelector = selector;
            if (!selector?.IsEnabled) {
                apiClient.getCurrentUser().then(currentUser => {
                    if (currentUser?.Policy?.IsAdministrator) {
                        Dashboard.navigate(getManageProfileSelectorRoute());
                    } else {
                        Dashboard.navigate(getTargetUrl(params));
                    }
                }).catch(() => {
                    Dashboard.navigate(getTargetUrl(params));
                });
                return;
            }

            renderProfileCards(view, apiClient, selector);

            if (layoutManager.tv) {
                focusManager.autoFocus(view);
            }
        }).catch(err => {
            console.error('[ProfileSelectorPage] failed to load selector', err);
            Dashboard.navigate(getTargetUrl(params));
        }).finally(() => {
            loading.hide();
        });
    }

    view.querySelector('#profileSelectorCards').addEventListener('click', onCardsClick);
    view.querySelector('.btnManageProfiles').addEventListener('click', () => {
        Dashboard.navigate(getManageProfileSelectorRoute());
    });
    view.querySelector('.btnLogout').addEventListener('click', () => {
        Dashboard.logout();
    });

    view.addEventListener('viewshow', () => {
        document.documentElement.classList.add('profileSelectorViewportLocked');
        window.scrollTo(0, 0);
        libraryMenu.setTransparentMenu(true);
        loadSelector();
    });

    view.addEventListener('viewhide', () => {
        document.documentElement.classList.remove('profileSelectorViewportLocked');
        libraryMenu.setTransparentMenu(false);
    });
}

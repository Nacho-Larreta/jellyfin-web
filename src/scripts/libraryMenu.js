import escapeHtml from 'escape-html';
import Headroom from 'headroom.js';

import { AppFeature } from 'constants/appFeature';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getCurrentProfileSelector } from 'lib/profileSelector/api';
import { getProfileAvatarGradientForUser } from 'lib/profileSelector/colors';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import { EventType } from 'constants/eventType';
import { createSessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { queryClient } from 'utils/query/queryClient';

import dom from '../utils/dom';
import layoutManager from '../components/layoutManager';
import inputManager from './inputManager';
import viewManager from '../components/viewManager/viewManager';
import { appRouter } from '../components/router/appRouter';
import { appHost } from '../components/apphost';
import { playbackManager } from '../components/playback/playbackmanager';
import { pluginManager } from '../components/pluginManager';
import groupSelectionMenu from '../plugins/syncPlay/ui/groupSelectionMenu';
import browser from './browser';
import imageHelper from '../utils/image';
import { getMenuLinks } from '../scripts/settings/webSettings';
import Dashboard, { pageClassOn } from '../utils/dashboard';
import { PluginType } from '../types/plugin.ts';
import Events from '../utils/events.ts';
import { getParameterByName } from '../utils/url.ts';
import datetime from '../scripts/datetime';
import { createLibraryMenuViews } from './libraryMenuViews';

import '../elements/emby-button/paper-icon-button-light';

import 'material-design-icons-iconfont';
import '../styles/scrollstyles.scss';
import '../styles/flexstyles.scss';
import { bindHeaderTabs, clearHeaderTabs } from '../components/maintabsmanager';

function isCurrentMount(mount) {
    return mount && activeHeaderMount === mount && mount.header.isConnected;
}

function renderHeader(mount) {
    if (!isCurrentMount(mount)) return;
    let html = '';
    html += '<div class="flex align-items-center flex-grow headerTop">';
    html += '<div class="headerLeft">';
    html += '<button type="button" class="jellyflixHeaderBrand headerButtonLeft" aria-label="Jellyfin">';
    html += '<span class="material-icons jellyflixHeaderBrandIcon" aria-hidden="true">person</span>';
    html += '<span class="jellyflixHeaderBrandText">Jellyfin</span>';
    html += '</button>';
    html += '<button type="button" is="paper-icon-button-light" class="headerButton headerButtonLeft headerBackButton hide"><span class="material-icons ' + (browser.safari ? 'chevron_left' : 'arrow_back') + '" aria-hidden="true"></span></button>';
    html += '<button type="button" is="paper-icon-button-light" class="headerButton headerHomeButton hide barsMenuButton headerButtonLeft"><span class="material-icons home" aria-hidden="true"></span></button>';
    html += '<button type="button" is="paper-icon-button-light" class="headerButton mainDrawerButton barsMenuButton headerButtonLeft hide"><span class="material-icons menu" aria-hidden="true"></span></button>';
    html += '<h3 class="pageTitle" aria-hidden="true"></h3>';
    html += '</div>';
    html += '<div class="headerRight">';
    html += '<button is="paper-icon-button-light" class="headerSyncButton syncButton headerButton headerButtonRight hide"><span class="material-icons groups" aria-hidden="true"></span></button>';
    html += '<span class="headerSelectedPlayer"></span>';
    html += '<button is="paper-icon-button-light" class="headerAudioPlayerButton audioPlayerButton headerButton headerButtonRight hide"><span class="material-icons music_note" aria-hidden="true"></span></button>';
    html += '<button is="paper-icon-button-light" class="headerCastButton castButton headerButton headerButtonRight hide"><span class="material-icons cast" aria-hidden="true"></span></button>';
    html += '<button type="button" is="paper-icon-button-light" class="headerButton headerButtonRight headerSearchButton hide"><span class="material-icons search" aria-hidden="true"></span></button>';
    html += '<button is="paper-icon-button-light" class="headerButton headerButtonRight headerUserButton hide"><span class="material-icons person" aria-hidden="true"></span></button>';
    html += '<div class="currentTimeText hide"></div>';
    html += '</div>';
    html += '</div>';
    html += '<div class="headerTabs sectionTabs hide">';
    html += '</div>';

    skinHeader.classList.add('skinHeader-withBackground');
    skinHeader.classList.add('skinHeader-blurred');
    skinHeader.innerHTML = html;
    mount.tabsContainer = skinHeader.querySelector('.headerTabs');
    bindHeaderTabs(mount.tabsContainer);

    headerBackButton = skinHeader.querySelector('.headerBackButton');
    headerHomeButton = skinHeader.querySelector('.headerHomeButton');
    mainDrawerButton = skinHeader.querySelector('.mainDrawerButton');
    jellyflixHeaderBrandButton = skinHeader.querySelector('.jellyflixHeaderBrand');
    headerUserButton = skinHeader.querySelector('.headerUserButton');
    headerCastButton = skinHeader.querySelector('.headerCastButton');
    headerAudioPlayerButton = skinHeader.querySelector('.headerAudioPlayerButton');
    headerSearchButton = skinHeader.querySelector('.headerSearchButton');
    headerSyncButton = skinHeader.querySelector('.headerSyncButton');
    currentTimeText = skinHeader.querySelector('.currentTimeText');

    retranslateUi();
    lazyLoadViewMenuBarImages(mount);
    bindMenuEvents(mount);
    updateCastIcon();
    updateClock(mount);
    Events.trigger(document, EventType.HEADER_RENDERED);
}

function getCurrentApiClient() {
    if (currentUser?.localUser) {
        return ServerConnections.getApiClient(currentUser.localUser.ServerId);
    }

    return ServerConnections.currentApiClient();
}

function lazyLoadViewMenuBarImages(mount) {
    import('../components/images/imageLoader').then((imageLoader) => {
        if (isCurrentMount(mount)) imageLoader.lazyChildren(mount.header);
    });
}

function onBackClick() {
    appRouter.back();
}

function retranslateUi() {
    if (headerBackButton) {
        headerBackButton.title = globalize.translate('ButtonBack');
    }

    if (headerHomeButton) {
        headerHomeButton.title = globalize.translate('Home');
    }

    if (mainDrawerButton) {
        mainDrawerButton.title = globalize.translate('Menu');
    }

    if (headerSyncButton) {
        headerSyncButton.title = globalize.translate('ButtonSyncPlay');
    }

    if (headerAudioPlayerButton) {
        headerAudioPlayerButton.title = globalize.translate('ButtonPlayer');
    }

    if (headerCastButton) {
        headerCastButton.title = globalize.translate('ButtonCast');
    }

    if (headerSearchButton) {
        headerSearchButton.title = globalize.translate('Search');
    }

    if (headerUserButton) {
        headerUserButton.title = globalize.translate('Settings');
    }
}

function updateUserInHeader(user, mount = activeHeaderMount) {
    if (!isCurrentMount(mount)) return;
    retranslateUi();

    let hasImage;

    if (user?.name) {
        if (user.imageUrl) {
            const url = user.imageUrl;
            updateHeaderUserButton(url, user.name);
            hasImage = true;
        }
        headerUserButton.title = user.name;
        headerUserButton.classList.remove('hide');
    } else {
        headerUserButton.classList.add('hide');
    }

    if (!hasImage) {
        updateHeaderUserButton(null, user?.name);
        updateHeaderUserButtonGradient(user, mount);
    }

    if (user?.localUser) {
        if (headerHomeButton) {
            headerHomeButton.classList.remove('hide');
        }

        if (headerSearchButton) {
            headerSearchButton.classList.remove('hide');
        }

        if (!layoutManager.tv) {
            headerCastButton.classList.remove('hide');
        }

        const policy = user.Policy ? user.Policy : user.localUser.Policy;

        if (
        // Button is present
            headerSyncButton
                // SyncPlay plugin is loaded
                && pluginManager.ofType(PluginType.SyncPlay).length > 0
                // SyncPlay enabled for user
                && policy?.SyncPlayAccess !== 'None'
        ) {
            headerSyncButton.classList.remove('hide');
        }
    } else {
        headerHomeButton.classList.add('hide');
        headerCastButton.classList.add('hide');
        headerSyncButton.classList.add('hide');

        if (headerSearchButton) {
            headerSearchButton.classList.add('hide');
        }
    }

    requiresUserRefresh = false;
}

let headerUserButtonGradientRequestId = 0;

function getHeaderUserId(user) {
    return user?.Id
        || user?.id
        || user?.localUser?.Id
        || getCurrentApiClient()?.getCurrentUserId?.();
}

function updateHeaderUserButtonGradient(user, mount) {
    const requestId = ++headerUserButtonGradientRequestId;
    const apiClient = getCurrentApiClient();
    const userId = getHeaderUserId(user);

    if (!apiClient || !userId || !headerUserButton) {
        return;
    }

    getCurrentProfileSelector(apiClient).then(selector => {
        if (!isCurrentMount(mount) || requestId !== headerUserButtonGradientRequestId || !headerUserButton) {
            return;
        }

        const gradient = getProfileAvatarGradientForUser(selector, userId);
        headerUserButton.style.background = gradient || '';
    }).catch(() => {
        if (isCurrentMount(mount) && requestId === headerUserButtonGradientRequestId && headerUserButton) {
            headerUserButton.style.background = '';
        }
    });
}

function updateHeaderUserButton(src, name) {
    if (src) {
        headerUserButton.classList.add('headerUserButtonRound', 'headerUserButtonProfile');
        headerUserButton.style.background = '';
        headerUserButton.innerHTML = '<div class="headerButton headerButtonRight paper-icon-button-light headerUserButtonRound headerUserImage" style="background-image:url(\'' + src + "');\"></div>";
    } else {
        headerUserButton.classList.remove('headerUserButtonRound');
        headerUserButton.classList.add('headerUserButtonProfile');
        const initial = escapeHtml((name || '').trim().slice(0, 1).toUpperCase() || '?');
        headerUserButton.innerHTML = '<span class="headerUserInitial" aria-hidden="true">' + initial + '</span>';
    }
}

function updateClock(mount) {
    if (layoutManager.tv) {
        currentTimeText.classList.remove('hide');
        mount.clock = setInterval(function() {
            if (isCurrentMount(mount)) mount.clockElement.innerText = datetime.getDisplayTime(new Date());
        }, 1000);
        mount.clockElement = currentTimeText;
    } else {
        currentTimeText.classList.add('hide');
    }
}

function showSearch() {
    inputManager.handleCommand('search');
}

function onHeaderUserButtonClick() {
    Dashboard.navigate('mypreferencesmenu');
}

function onHeaderHomeButtonClick() {
    Dashboard.navigate('home');
}

function showAudioPlayer() {
    return appRouter.showNowPlaying();
}

function bindMenuEvents(mount) {
    const bind = (element, event, callback) => {
        element?.addEventListener(event, callback);
        if (element) mount.listeners.push(() => element.removeEventListener(event, callback));
    };
    if (mainDrawerButton) {
        bind(mainDrawerButton, 'click', toggleMainDrawer);
    }

    if (headerBackButton) {
        bind(headerBackButton, 'click', onBackClick);
    }

    if (headerSearchButton) {
        bind(headerSearchButton, 'click', showSearch);
    }

    bind(headerUserButton, 'click', onHeaderUserButtonClick);
    bind(headerHomeButton, 'click', onHeaderHomeButtonClick);
    bind(jellyflixHeaderBrandButton, 'click', onHeaderHomeButtonClick);

    if (!layoutManager.tv) {
        bind(headerCastButton, 'click', onCastButtonClicked);
    }

    bind(headerAudioPlayerButton, 'click', showAudioPlayer);
    bind(headerSyncButton, 'click', onSyncButtonClicked);

    if (layoutManager.mobile) {
        mount.headroom = initHeadRoom(skinHeader);
    }
}

function onPlaybackStart() {
    if (!isCurrentMount(activeHeaderMount)) return;
    if (playbackManager.isPlayingAudio() && layoutManager.tv) {
        headerAudioPlayerButton.classList.remove('hide');
    } else {
        headerAudioPlayerButton.classList.add('hide');
    }
}

function onPlaybackStop(e, stopInfo) {
    if (!isCurrentMount(activeHeaderMount)) return;
    if (stopInfo.nextMediaType != 'Audio') {
        headerAudioPlayerButton.classList.add('hide');
    }
}

function onCastButtonClicked() {
    const btn = this;

    import('../components/playback/playerSelectionMenu').then((playerSelectionMenu) => {
        playerSelectionMenu.show(btn);
    });
}

function onSyncButtonClicked() {
    const btn = this;
    groupSelectionMenu.show(btn);
}

function getItemHref(item, context) {
    return appRouter.getRouteUrl(item, {
        context: context
    });
}

function toggleMainDrawer() {
    if (!navDrawerInstance || !isCurrentMount(activeHeaderMount)) return;
    if (navDrawerInstance.isVisible) {
        closeMainDrawer();
    } else {
        openMainDrawer();
    }
}

function openMainDrawer() {
    navDrawerInstance?.open();
}

function onMainDrawerOpened() {
    if (layoutManager.mobile) {
        document.body.classList.add('bodyWithPopupOpen');
    }
}

function closeMainDrawer() {
    navDrawerInstance?.close();
}

function onMainDrawerSelect() {
    if (navDrawerInstance.isVisible) {
        onMainDrawerOpened();
    } else {
        document.body.classList.remove('bodyWithPopupOpen');
    }
}

function refreshLibraryInfoInDrawer(user) {
    let html = '';
    const currentServer = ServerConnections.currentApiClient()?.serverInfo?.();
    html += '<div style="height:.5em;"></div>';
    html += `<a is="emby-linkbutton" class="navMenuOption lnkMediaFolder" href="#/home"><span class="material-icons navMenuOptionIcon home" aria-hidden="true"></span><span class="navMenuOptionText">${globalize.translate('Home')}</span></a>`;

    // placeholder for custom menu links
    html += '<div class="customMenuOptions"></div>';

    // libraries are added here
    html += '<div class="libraryMenuOptions"></div>';

    if (user.localUser?.Policy?.IsAdministrator) {
        html += '<div class="adminMenuOptions">';
        html += '<h3 class="sidebarHeader">';
        html += globalize.translate('HeaderAdmin');
        html += '</h3>';
        html += `<a is="emby-linkbutton" class="navMenuOption lnkMediaFolder lnkManageServer" data-itemid="dashboard" href="#/dashboard"><span class="material-icons navMenuOptionIcon dashboard" aria-hidden="true"></span><span class="navMenuOptionText">${globalize.translate('TabDashboard')}</span></a>`;
        html += `<a is="emby-linkbutton" class="navMenuOption lnkMediaFolder editorViewMenu" data-itemid="editor" href="#/metadata"><span class="material-icons navMenuOptionIcon mode_edit" aria-hidden="true"></span><span class="navMenuOptionText">${globalize.translate('MetadataManager')}</span></a>`;
        html += '</div>';
    }

    if (user.localUser) {
        html += '<div class="userMenuOptions">';
        html += '<h3 class="sidebarHeader">';
        html += globalize.translate('HeaderUser');
        html += '</h3>';

        if (appHost.supports(AppFeature.MultiServer)) {
            html += `<a is="emby-linkbutton" class="navMenuOption lnkMediaFolder btnSelectServer" data-itemid="selectserver" href="#"><span class="material-icons navMenuOptionIcon storage" aria-hidden="true"></span><span class="navMenuOptionText">${globalize.translate('SelectServer')}</span></a>`;
        }

        if (currentServer?.ProfileSelectorEnabled || user.localUser?.Policy?.IsAdministrator) {
            html += `<a is="emby-linkbutton" class="navMenuOption lnkMediaFolder btnSwitchProfile" data-itemid="switchprofile" href="#"><span class="material-icons navMenuOptionIcon switch_account" aria-hidden="true"></span><span class="navMenuOptionText">${globalize.translate('SwitchProfile')}</span></a>`;
        }

        html += `<a is="emby-linkbutton" class="navMenuOption lnkMediaFolder btnSettings" data-itemid="settings" href="#"><span class="material-icons navMenuOptionIcon settings" aria-hidden="true"></span><span class="navMenuOptionText">${globalize.translate('Settings')}</span></a>`;
        html += `<a is="emby-linkbutton" class="navMenuOption lnkMediaFolder btnLogout" data-itemid="logout" href="#"><span class="material-icons navMenuOptionIcon exit_to_app" aria-hidden="true"></span><span class="navMenuOptionText">${globalize.translate('ButtonSignOut')}</span></a>`;

        if (appHost.supports(AppFeature.ExitMenu)) {
            html += `<a is="emby-linkbutton" class="navMenuOption lnkMediaFolder exitApp" data-itemid="exitapp" href="#"><span class="material-icons navMenuOptionIcon close" aria-hidden="true"></span><span class="navMenuOptionText">${globalize.translate('ButtonExitApp')}</span></a>`;
        }

        html += '</div>';
    }

    // add buttons to navigation drawer
    navDrawerScrollContainer.innerHTML = html;

    const btnSelectServer = navDrawerScrollContainer.querySelector('.btnSelectServer');
    if (btnSelectServer) {
        btnSelectServer.addEventListener('click', onSelectServerClick);
    }

    const btnSettings = navDrawerScrollContainer.querySelector('.btnSettings');
    if (btnSettings) {
        btnSettings.addEventListener('click', onSettingsClick);
    }

    const btnSwitchProfile = navDrawerScrollContainer.querySelector('.btnSwitchProfile');
    if (btnSwitchProfile) {
        btnSwitchProfile.addEventListener('click', onSwitchProfileClick);
    }

    const btnExit = navDrawerScrollContainer.querySelector('.exitApp');
    if (btnExit) {
        btnExit.addEventListener('click', onExitAppClick);
    }

    const btnLogout = navDrawerScrollContainer.querySelector('.btnLogout');
    if (btnLogout) {
        btnLogout.addEventListener('click', onLogoutClick);
    }
}

function onSidebarLinkClick() {
    const section = this.getElementsByClassName('sectionName')[0];
    const text = section ? section.innerHTML : this.innerHTML;
    LibraryMenu.setTitle(text);
}

function renderCustomMenuLinks(target, links) {
    links.forEach(link => {
        const option = document.createElement('a', 'emby-linkbutton');
        option.classList.add('navMenuOption', 'lnkMediaFolder');
        option.rel = 'noopener noreferrer';
        option.target = '_blank';
        option.href = link.url;

        const icon = document.createElement('span');
        icon.className = `material-icons navMenuOptionIcon ${link.icon || 'link'}`;
        icon.setAttribute('aria-hidden', 'true');
        option.appendChild(icon);

        const label = document.createElement('span');
        label.className = 'navMenuOptionText';
        label.textContent = link.name;
        option.appendChild(label);

        target.appendChild(option);
    });
}

function renderLibraryMenuViews(target, result) {
    const items = [];
    for (const view of result.Items || []) {
        items.push(view);
        if (view.CollectionType === 'livetv') {
            items.push({ ...view, Name: globalize.translate('Guide'), ImageTags: {}, icon: 'dvr', url: '#/livetv?tab=1' });
        }
    }

    let html = `<h3 class="sidebarHeader">${globalize.translate('HeaderMedia')}</h3>`;
    html += items.map(item => {
        const icon = item.icon || (item.CollectionType === 'livetv' ? 'live_tv' : imageHelper.getLibraryIcon(item.CollectionType));
        return `<a is="emby-linkbutton" data-itemid="${escapeHtml(item.Id || '')}" class="lnkMediaFolder navMenuOption" href="${escapeHtml(getItemHref(item, item.CollectionType))}">
                    <span class="material-icons navMenuOptionIcon ${escapeHtml(icon)}" aria-hidden="true"></span>
                    <span class="sectionName navMenuOptionText">${escapeHtml(item.Name || '')}</span>
                </a>`;
    }).join('');
    target.innerHTML = html;
    for (const sidebarLink of target.querySelectorAll('.navMenuOption')) {
        sidebarLink.addEventListener('click', onSidebarLinkClick);
    }
}

function clearLibraryDrawer() {
    currentDrawerType = null;
    if (!navDrawerScrollContainer) return;

    const home = document.createElement('a', 'emby-linkbutton');
    home.className = 'navMenuOption lnkMediaFolder';
    home.href = '#/home';
    home.textContent = globalize.translate('Home');
    navDrawerScrollContainer.replaceChildren(home);
}

function getTopParentId() {
    return getParameterByName('topParentId') || null;
}

function onMainDrawerClick(e) {
    if (dom.parentWithTag(e.target, 'A')) {
        const mount = activeHeaderMount;
        const timeout = setTimeout(() => {
            mount?.timeouts.delete(timeout);
            if (isCurrentMount(mount)) closeMainDrawer();
        }, 30);
        mount?.timeouts.add(timeout);
    }
}

function onSelectServerClick() {
    Dashboard.selectServer();
}

function onSettingsClick() {
    Dashboard.navigate('mypreferencesmenu');
}

function onSwitchProfileClick() {
    Dashboard.navigate('profileselector');
}

function onExitAppClick() {
    appHost.exit();
}

function onLogoutClick() {
    Dashboard.logout();
}

function updateCastIcon() {
    if (!isCurrentMount(activeHeaderMount) || !headerCastButton) return;
    const context = document;
    const info = playbackManager.getPlayerInfo();
    const icon = headerCastButton.querySelector('.material-icons');

    icon.classList.remove('cast_connected', 'cast');

    if (info && !info.isLocalPlayer) {
        icon.classList.add('cast_connected');
        headerCastButton.classList.add('castButton-active');
        context.querySelector('.headerSelectedPlayer').innerText = info.deviceName || info.name;
    } else {
        icon.classList.add('cast');
        headerCastButton.classList.remove('castButton-active');
        context.querySelector('.headerSelectedPlayer').innerHTML = '';
    }
}

function updateLibraryNavLinks(page) {
    const isLiveTvPage = page.classList.contains('liveTvPage');
    const isChannelsPage = page.classList.contains('channelsPage');
    const isEditorPage = page.classList.contains('metadataEditorPage');
    const isMySyncPage = page.classList.contains('mySyncPage');
    const id = isLiveTvPage || isChannelsPage || isEditorPage || isMySyncPage || page.classList.contains('allLibraryPage') ? '' : getTopParentId() || '';
    const elems = document.getElementsByClassName('lnkMediaFolder');

    for (let i = 0, length = elems.length; i < length; i++) {
        const lnkMediaFolder = elems[i];
        const itemId = lnkMediaFolder.getAttribute('data-itemid');

        if (isChannelsPage && itemId === 'channels') {
            lnkMediaFolder.classList.add('navMenuOption-selected');
        } else if (isLiveTvPage && itemId === 'livetv') {
            lnkMediaFolder.classList.add('navMenuOption-selected');
        } else if (isEditorPage && itemId === 'editor') {
            lnkMediaFolder.classList.add('navMenuOption-selected');
        } else if (isMySyncPage && itemId === 'manageoffline' && window.location.href.toString().indexOf('mode=download') != -1) {
            lnkMediaFolder.classList.add('navMenuOption-selected');
        } else if (isMySyncPage && itemId === 'syncotherdevices' && window.location.href.toString().indexOf('mode=download') == -1) {
            lnkMediaFolder.classList.add('navMenuOption-selected');
        } else if (id && itemId == id) {
            lnkMediaFolder.classList.add('navMenuOption-selected');
        } else {
            lnkMediaFolder.classList.remove('navMenuOption-selected');
        }
    }
}

function updateMenuForPageType(isDashboardPage, isLibraryPage) {
    if (!isCurrentMount(activeHeaderMount)) return;
    let newPageType = 3;
    if (isDashboardPage) {
        newPageType = 2;
    } else if (isLibraryPage) {
        newPageType = 1;
    }

    if (currentPageType !== newPageType) {
        currentPageType = newPageType;

        if (isDashboardPage && !layoutManager.mobile) {
            skinHeader.classList.add('headroomDisabled');
        } else {
            skinHeader.classList.remove('headroomDisabled');
        }

        const bodyClassList = document.body.classList;

        if (isLibraryPage) {
            bodyClassList.add('libraryDocument');
            bodyClassList.remove('hideMainDrawer');

            if (navDrawerInstance) {
                navDrawerInstance.setEdgeSwipeEnabled(true);
            }
        } else if (isDashboardPage) {
            bodyClassList.remove('libraryDocument');
            bodyClassList.remove('hideMainDrawer');

            if (navDrawerInstance) {
                navDrawerInstance.setEdgeSwipeEnabled(true);
            }
        } else {
            bodyClassList.remove('libraryDocument');
            bodyClassList.add('hideMainDrawer');

            if (navDrawerInstance) {
                navDrawerInstance.setEdgeSwipeEnabled(false);
            }
        }
    }

    if (requiresUserRefresh) {
        refreshHeaderUser(activeHeaderMount);
    }
}

function updateTitle(page) {
    const title = page.getAttribute('data-title');

    if (title) {
        LibraryMenu.setTitle(title);
    } else if (page.classList.contains('standalonePage')) {
        LibraryMenu.setDefaultTitle();
    }
}

function updateBackButton(page) {
    if (headerBackButton) {
        if (page.getAttribute('data-backbutton') !== 'false' && appRouter.canGoBack()) {
            headerBackButton.classList.remove('hide');
        } else {
            headerBackButton.classList.add('hide');
        }
    }
}

function initHeadRoom(elem) {
    const headroom = new Headroom(elem);
    headroom.init();
    return headroom;
}

const libraryMenuViews = createLibraryMenuViews({
    captureRead: () => {
        const client = ServerConnections.currentApiClient();
        if (!client) return null;
        const port = getWebSessionSwitchApplication(ServerConnections).captureBoundSessionRead(client);
        return port && createSessionScopedReadApi(client, port);
    },
    prepareDrawer: async () => {
        const mount = activeHeaderMount;
        await loadNavDrawer(mount);
        return isCurrentMount(mount) ? navDrawerScrollContainer : null;
    },
    currentDrawer: () => navDrawerScrollContainer,
    clear: clearLibraryDrawer,
    renderUser: (container, user) => {
        refreshLibraryInfoInDrawer({ localUser: user });
        return {
            libraries: container.querySelector('.libraryMenuOptions'),
            links: container.querySelector('.customMenuOptions')
        };
    },
    renderViews: renderLibraryMenuViews,
    getLinks: getMenuLinks,
    renderLinks: renderCustomMenuLinks,
    subscribeAuthority: (read, listener) => ServerConnections.subscribeSessionSwitchEnvelope(
        read.identity.serverId, listener
    ),
    queryClient,
    onError: () => console.error('[LibraryMenu] Failed to load current library views')
});

let libraryDrawerRefreshGeneration = 0;
function refreshLibraryDrawer() {
    const expected = ++libraryDrawerRefreshGeneration;
    const refreshing = libraryMenuViews.refresh();
    currentDrawerType = 'library-loading';
    void refreshing.then(rendered => {
        if (expected === libraryDrawerRefreshGeneration) currentDrawerType = rendered ? 'library' : null;
    });
}

function getNavDrawerOptions(mount) {
    let drawerWidth = window.screen.availWidth - 50;
    drawerWidth = Math.max(drawerWidth, 240);
    drawerWidth = Math.min(drawerWidth, 320);
    return {
        target: mount.drawer,
        edgeContainer: mount.handle,
        onChange: () => {
            if (isCurrentMount(mount)) onMainDrawerSelect();
        },
        width: drawerWidth
    };
}

function loadNavDrawer(mount) {
    if (!isCurrentMount(mount)) return Promise.resolve(null);
    if (mount.drawerPromise) return mount.drawerPromise;
    mount.drawerPromise = import('../lib/navdrawer/navdrawer').then(({ default: NavDrawer }) => {
        if (!isCurrentMount(mount)) return null;
        navDrawerScrollContainer = mount.drawer.querySelector('.scrollContainer');
        const scrollContainer = navDrawerScrollContainer;
        scrollContainer.addEventListener('click', onMainDrawerClick);
        mount.listeners.push(() => scrollContainer.removeEventListener('click', onMainDrawerClick));
        navDrawerInstance = new NavDrawer(getNavDrawerOptions(mount));
        mount.drawerInstance = navDrawerInstance;
        if (!layoutManager.tv) mount.drawer.classList.remove('hide');
        return navDrawerInstance;
    });
    return mount.drawerPromise;
}

let activeHeaderMount;
let navDrawerScrollContainer;
let navDrawerInstance;
let mainDrawerButton;
let headerHomeButton;
let currentDrawerType;
let documentTitle = 'Jellyfin';
let jellyflixHeaderBrandButton;
let pageTitleElement;
let headerBackButton;
let headerUserButton;
let currentUser;
let headerCastButton;
let headerSearchButton;
let headerAudioPlayerButton;
let headerSyncButton;
let currentTimeText;
const enableLibraryNavDrawer = layoutManager.desktop;
const enableLibraryNavDrawerHome = !layoutManager.tv;
let skinHeader;
let requiresUserRefresh = true;

function refreshHeaderUser(mount) {
    if (!isCurrentMount(mount)) return;
    const client = ServerConnections.currentApiClient();
    if (!client) return;
    let read;
    try {
        const port = getWebSessionSwitchApplication(ServerConnections).captureBoundSessionRead(client);
        if (!port) return;
        read = createSessionScopedReadApi(client, port);
    } catch {
        return;
    }
    void read.getCurrentUser().then(user => {
        if (!isCurrentMount(mount) || ServerConnections.currentApiClient() !== client) return;
        try {
            read.assertCurrent();
        } catch {
            return;
        }
        currentUser = {
            localUser: user,
            name: user.Name,
            imageUrl: user.PrimaryImageTag ? client.getUserImageUrl(user.Id, {
                tag: user.PrimaryImageTag,
                type: 'Primary'
            }) : null
        };
        updateUserInHeader(currentUser, mount);
    }).catch(() => undefined);
}

function unmountHeader(mount) {
    if (activeHeaderMount !== mount) return;
    activeHeaderMount = null;
    clearHeaderTabs(mount.tabsContainer);
    headerUserButtonGradientRequestId++;
    libraryDrawerRefreshGeneration++;
    libraryMenuViews.invalidate();
    for (const timeout of mount.timeouts) clearTimeout(timeout);
    mount.timeouts.clear();
    for (const removeListener of mount.listeners) removeListener();
    mount.listeners.length = 0;
    if (mount.clock) clearInterval(mount.clock);
    mount.headroom?.destroy();
    if (mount.drawerInstance) {
        mount.drawerInstance.setEdgeSwipeEnabled(false);
        mount.drawerInstance.close();
        mount.drawerInstance.mask?.remove();
    }
    document.body.classList.remove('bodyWithPopupOpen');
    navDrawerInstance = null;
    navDrawerScrollContainer = null;
    skinHeader = null;
    pageTitleElement = null;
    headerBackButton = null;
    headerHomeButton = null;
    headerUserButton = null;
    headerCastButton = null;
    headerAudioPlayerButton = null;
    headerSearchButton = null;
    headerSyncButton = null;
    jellyflixHeaderBrandButton = null;
    mainDrawerButton = null;
    currentTimeText = null;
    currentPageType = null;
    currentDrawerType = null;
    currentUser = null;
    requiresUserRefresh = true;
}

function releaseHeader(mount) {
    if (activeHeaderMount !== mount) return;
    mount.owners--;
    if (mount.owners === 0) unmountHeader(mount);
}

function ownHeaderMount(mount) {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseHeader(mount);
    };
}

export function mountHeader(header, drawer, handle) {
    if (activeHeaderMount?.header === header && activeHeaderMount.drawer === drawer && activeHeaderMount.handle === handle) {
        const mounted = activeHeaderMount;
        mounted.owners++;
        return ownHeaderMount(mounted);
    }
    if (activeHeaderMount) unmountHeader(activeHeaderMount);
    const mount = {
        header, drawer, handle,
        owners: 1,
        listeners: [], timeouts: new Set(),
        drawerInstance: null, headroom: null, clock: null
    };
    activeHeaderMount = mount;
    skinHeader = header;
    renderHeader(mount);
    void loadNavDrawer(mount);
    refreshHeaderUser(mount);
    refreshLibraryDrawer();
    return ownHeaderMount(mount);
}

function setTabs (type, selectedIndex, builder) {
    const mount = activeHeaderMount;
    if (!isCurrentMount(mount)) return;
    Events.trigger(document, EventType.SET_TABS, type ? [ type, selectedIndex, builder()] : []);

    import('../components/maintabsmanager').then((mainTabsManager) => {
        if (!isCurrentMount(mount)) return;
        if (type) {
            mainTabsManager.setTabs(viewManager.currentView(), selectedIndex, builder, function () {
                return [];
            });
        } else {
            mainTabsManager.setTabs(null);
        }
    });
}

/**
 * Fetch the server name and update the document title.
 * @param {import('jellyfin-apiclient').ApiClient} [_apiClient] The current api client.
 */
const fetchServerName = (_apiClient) => {
    _apiClient
        ?.getPublicSystemInfo()
        .then(({ ServerName }) => {
            documentTitle = ServerName || documentTitle;
            document.title = documentTitle;
        })
        .catch(err => {
            console.error('[LibraryMenu] failed to fetch system info', err);
        });
};

function setDefaultTitle () {
    if (!pageTitleElement) {
        pageTitleElement = document.querySelector('.pageTitle');
    }

    if (pageTitleElement) {
        pageTitleElement.classList.add('pageTitleWithLogo');
        pageTitleElement.classList.add('pageTitleWithDefaultLogo');
        pageTitleElement.style.backgroundImage = null;
        pageTitleElement.innerHTML = '';
    }

    document.title = documentTitle;
}

function setTitle (title) {
    if (title == null) {
        LibraryMenu.setDefaultTitle();
        return;
    }

    if (title === '-') {
        title = '';
    }

    const html = title;

    if (!pageTitleElement) {
        pageTitleElement = document.querySelector('.pageTitle');
    }

    if (pageTitleElement) {
        pageTitleElement.classList.remove('pageTitleWithLogo');
        pageTitleElement.classList.remove('pageTitleWithDefaultLogo');
        pageTitleElement.style.backgroundImage = null;
        pageTitleElement.innerText = html || '';
    }

    document.title = title || documentTitle;
}

function setTransparentMenu (transparent) {
    if (!isCurrentMount(activeHeaderMount)) return;
    if (transparent) {
        skinHeader.classList.add('semiTransparent');
    } else {
        skinHeader.classList.remove('semiTransparent');
    }
}

let currentPageType;
pageClassOn('pagebeforeshow', 'page', function () {
    if (!isCurrentMount(activeHeaderMount)) return;
    if (!this.classList.contains('withTabs')) {
        LibraryMenu.setTabs(null);
    }
});

pageClassOn('pageshow', 'page', function (e) {
    if (!isCurrentMount(activeHeaderMount)) return;
    const page = this;
    const isDashboardPage = page.classList.contains('type-interior');
    const isHomePage = page.classList.contains('homePage');
    const isLibraryPage = !isDashboardPage && page.classList.contains('libraryPage');

    if (!isDashboardPage) {
        if (mainDrawerButton) {
            if (enableLibraryNavDrawer || (isHomePage && enableLibraryNavDrawerHome)) {
                mainDrawerButton.classList.remove('hide');
            } else {
                mainDrawerButton.classList.add('hide');
            }
        }

        if (currentDrawerType !== 'library') {
            refreshLibraryDrawer();
        }
    }

    updateMenuForPageType(isDashboardPage, isLibraryPage);

    // TODO: Seems to do nothing? Check if needed (also in other views).
    if (!e.detail.isRestored) {
        window.scrollTo(0, 0);
    }

    updateTitle(page);
    updateBackButton(page);
    updateLibraryNavLinks(page);
});

Events.on(ServerConnections, 'apiclientcreated', (e, newApiClient) => {
    fetchServerName(newApiClient);
});

Events.on(ServerConnections, 'localusersignedin', function (e, user) {
    const currentApiClient = ServerConnections.getApiClient(user.ServerId);

    libraryMenuViews.invalidate();
    currentDrawerType = null;
    if (currentApiClient !== ServerConnections.currentApiClient()) return;
    currentUser = { localUser: user };
    if (isCurrentMount(activeHeaderMount)) {
        refreshLibraryDrawer();
        refreshHeaderUser(activeHeaderMount);
    }
});

Events.on(ServerConnections, 'localusersignedout', function () {
    libraryMenuViews.invalidate();
    currentDrawerType = null;
    currentUser = {};
    if (isCurrentMount(activeHeaderMount)) updateUserInHeader();
});

Events.on(ServerConnections, 'sessionswitchcompleted', function () {
    libraryMenuViews.invalidate();
    currentDrawerType = null;
    if (isCurrentMount(activeHeaderMount)) {
        refreshLibraryDrawer();
        refreshHeaderUser(activeHeaderMount);
    }
});

Events.on(playbackManager, 'playerchange', updateCastIcon);
Events.on(playbackManager, 'playbackstart', onPlaybackStart);
Events.on(playbackManager, 'playbackstop', onPlaybackStop);

fetchServerName(getCurrentApiClient());

const LibraryMenu = {
    getTopParentId,
    onHardwareMenuButtonClick: function () {
        toggleMainDrawer();
    },
    setTabs,
    setDefaultTitle,
    setTitle,
    setTransparentMenu
};

window.LibraryMenu = LibraryMenu;

export default LibraryMenu;

import DOMPurify from 'dompurify';
import markdownIt from 'markdown-it';

import { AppFeature } from 'constants/appFeature';
import { ServerConnections } from 'lib/jellyfin-apiclient';

import { appHost } from '../../../components/apphost';
import appSettings from '../../../scripts/settings/appSettings';
import dom from '../../../utils/dom';
import loading from '../../../components/loading/loading';
import layoutManager from '../../../components/layoutManager';
import libraryMenu from '../../../scripts/libraryMenu';
import browser from '../../../scripts/browser';
import globalize from '../../../lib/globalize';
import '../../../components/cardbuilder/card.scss';
import '../../../elements/emby-checkbox/emby-checkbox';
import Dashboard from '../../../utils/dashboard';
import toast from '../../../components/toast/toast';
import dialogHelper from '../../../components/dialogHelper/dialogHelper';
import dialog from '../../../components/dialog/dialog';
import { appRouter } from '../../../components/router/appRouter';
import { resolveProfileSelectorRoute } from '../../../lib/profileSelector/navigation';
import { getDefaultBackgroundClass } from '../../../components/cardbuilder/utils/builder';
import { SessionSwitchRecoveryRequiredError } from '../../../lib/profileSelector/sessionSwitch/model';
import {
    readQuickConnectState,
    requestManualAuthentication,
    requestQuickConnectAuthentication
} from './authenticationRequests';

import './login.scss';

const enableFocusTransform = !browser.slow && !browser.edge;

const QUICK_CONNECT_DIAGNOSTICS = Object.freeze({
    initiateFailed: 'initiate-failed',
    initiateMalformed: 'initiate-malformed',
    pollOrConnectFailed: 'poll-or-connect-failed'
});
let nextQuickConnectDialogId = 0;

function reportQuickConnectDiagnostic(code) {
    console.error('[LoginPage][quick-connect]', code);
}

function closeQuickConnectDialog(dialogId) {
    const dialogElement = document.getElementById(dialogId);
    if (dialogElement) {
        dialogHelper.close(dialogElement);
    }
}

function closeQuickConnectDialogOnEscape(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dialogHelper.close(event.currentTarget);
}

function restoreQuickConnectFocus(initiatingControl, isAttemptCurrent) {
    if (!isAttemptCurrent() || !initiatingControl?.isConnected
        || document.querySelector('.dialogContainer .dialog.opened')) return;

    const activeElement = document.activeElement;
    if (activeElement === document.body || !activeElement?.isConnected) {
        initiatingControl.focus();
    }
}

function routeToSessionRecovery(error) {
    if (!(error instanceof SessionSwitchRecoveryRequiredError)) return false;
    Dashboard.navigate('/home');
    return true;
}

async function authenticateUserByName(page, apiClient, url, username, password, isCurrent) {
    loading.show();
    try {
        const expectedAuthorityRevision = ServerConnections.captureLoginAuthority(apiClient.serverId());
        const result = await requestManualAuthentication(apiClient, username, password);
        if (!isCurrent()) return;
        await ServerConnections.publishLoginAuthentication(apiClient, result, {
            expectedAuthorityRevision,
            isCurrent
        });
        if (!isCurrent()) return;
        loading.hide();
        await onLoginSuccessful(apiClient, url, () => !isCurrent());
    } catch (response) {
        if (!isCurrent()) return;
        page.querySelector('#txtManualPassword').value = '';
        loading.hide();
        if (routeToSessionRecovery(response)) return;

        const UnauthorizedOrForbidden = [401, 403];
        if (UnauthorizedOrForbidden.includes(response?.status)) {
            const messageKey = response.status === 401 ? 'MessageInvalidUser' : 'MessageUnauthorizedUser';
            toast(globalize.translate(messageKey));
        } else {
            Dashboard.alert({
                message: globalize.translate('MessageUnableToConnectToServer'),
                title: globalize.translate('HeaderConnectionFailure')
            });
        }
    }
}

function createQuickConnectSession(apiClient, targetUrl, isAttemptCurrent, initiatingControl) {
    let cancelled = false;
    let completing = false;
    let pollTimer = null;
    const dialogId = `quickConnectAlert-${++nextQuickConnectDialogId}`;
    const errorDialogId = `${dialogId}-error`;
    let errorDialogOwner = null;
    const isCurrent = () => !cancelled && isAttemptCurrent();

    const clearPollTimer = () => {
        if (pollTimer !== null) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    };
    const finish = closeDialog => {
        cancelled = true;
        clearPollTimer();
        if (closeDialog) closeQuickConnectDialog(dialogId);
    };
    const cancel = () => {
        errorDialogOwner = null;
        if (!cancelled) finish(true);
        closeQuickConnectDialog(errorDialogId);
    };
    const showErrorDialog = async messageKey => {
        const owner = {};
        errorDialogOwner = owner;
        try {
            await appRouter.ready();
            if (errorDialogOwner !== owner || !isAttemptCurrent()) return;
            const result = dialog.show({
                dialogOptions: { id: errorDialogId, enableHistory: false },
                title: globalize.translate('HeaderError'),
                text: globalize.translate(messageKey),
                buttons: [{
                    name: globalize.translate('ButtonGotIt'),
                    id: 'ok',
                    type: 'submit'
                }]
            });
            document.getElementById(errorDialogId)?.addEventListener('keydown', closeQuickConnectDialogOnEscape);
            const onSettled = () => {
                if (errorDialogOwner === owner) {
                    errorDialogOwner = null;
                    restoreQuickConnectFocus(initiatingControl, isAttemptCurrent);
                }
            };
            void Promise.resolve(result).then(onSettled, onSettled);
        } catch {
            if (errorDialogOwner === owner) errorDialogOwner = null;
        }
    };
    const schedulePoll = secret => {
        if (cancelled) return;
        pollTimer = setTimeout(() => {
            pollTimer = null;
            void poll(secret);
        }, 5000);
    };
    const poll = async secret => {
        try {
            const data = await readQuickConnectState(apiClient, secret);
            if (!isCurrent()) return;
            if (!data.Authenticated) {
                schedulePoll(secret);
                return;
            }

            const result = await requestQuickConnectAuthentication(apiClient, data.Secret);
            if (!isCurrent()) return;
            await ServerConnections.publishLoginAuthentication(apiClient, result, {
                expectedAuthorityRevision,
                isCurrent
            });
            if (!isCurrent()) return;
            completing = true;
            closeQuickConnectDialog(dialogId);
            await onLoginSuccessful(apiClient, targetUrl, () => !isCurrent());
            if (!cancelled) finish(false);
        } catch (error) {
            if (!isCurrent()) return;
            finish(true);
            if (routeToSessionRecovery(error)) return;
            void showErrorDialog('QuickConnectDeactivated');
            reportQuickConnectDiagnostic(QUICK_CONNECT_DIAGNOSTICS.pollOrConnectFailed);
        }
    };
    let expectedAuthorityRevision;
    const start = async () => {
        try {
            expectedAuthorityRevision = ServerConnections.captureLoginAuthority(apiClient.serverId());
            const initiateUrl = apiClient.getUrl('/QuickConnect/Initiate');
            const response = await apiClient.ajax({ type: 'POST', url: initiateUrl }, true);
            const json = await response.json();
            if (!isCurrent()) return false;
            if (typeof json?.Secret !== 'string' || !json.Secret
                || typeof json.Code !== 'string' || !json.Code) {
                reportQuickConnectDiagnostic(QUICK_CONNECT_DIAGNOSTICS.initiateMalformed);
                finish(false);
                return false;
            }

            await appRouter.ready();
            if (!isCurrent()) return false;
            const dialogResult = dialog.show({
                dialogOptions: {
                    id: dialogId,
                    enableHistory: false
                },
                title: globalize.translate('QuickConnect'),
                text: globalize.translate('QuickConnectAuthorizeCode', json.Code),
                buttons: [{
                    name: globalize.translate('ButtonGotIt'),
                    id: 'ok',
                    type: 'submit'
                }]
            });
            const onDialogSettled = () => {
                if (!completing && !cancelled) cancel();
                if (!completing) restoreQuickConnectFocus(initiatingControl, isAttemptCurrent);
            };
            void Promise.resolve(dialogResult).then(onDialogSettled, onDialogSettled);
            const dialogElement = document.getElementById(dialogId);
            dialogElement.addEventListener('keydown', closeQuickConnectDialogOnEscape);
            dialogElement.addEventListener('closing', () => {
                if (!completing && !cancelled) finish(false);
            }, { once: true });
            schedulePoll(json.Secret);
            return isCurrent();
        } catch (error) {
            if (!isCurrent()) return false;
            finish(true);
            if (routeToSessionRecovery(error)) return false;
            void showErrorDialog('QuickConnectNotActive');
            reportQuickConnectDiagnostic(QUICK_CONNECT_DIAGNOSTICS.initiateFailed);
            return false;
        }
    };

    return { cancel, start };
}

export function authenticateQuickConnect(apiClient, targetUrl, isAttemptCurrent = () => true, initiatingControl) {
    const session = createQuickConnectSession(apiClient, targetUrl, isAttemptCurrent, initiatingControl);
    const started = session.start().catch(() => {
        session.cancel();
        reportQuickConnectDiagnostic(QUICK_CONNECT_DIAGNOSTICS.initiateFailed);
        return false;
    });
    return { ...session, started };
}

function onLoginSuccessful(apiClient, url, isCancelled = () => false) {
    return resolveProfileSelectorRoute(apiClient, url || '/home').then(targetUrl => {
        if (isCancelled()) return;
        const activeApiClient = ServerConnections.currentApiClient() || apiClient;
        Dashboard.onServerChanged(activeApiClient.getCurrentUserId(), activeApiClient.accessToken(), activeApiClient);
        Dashboard.navigate(targetUrl);
    }).catch(() => {
        if (isCancelled()) return;
        console.warn('[LoginPage] unable to resolve profile selector route');
        loading.show();
    });
}

function showManualForm(context, showCancel, focusPassword) {
    context.querySelector('.chkRememberLogin').checked = appSettings.enableAutoLogin();
    context.querySelector('.manualLoginForm').classList.remove('hide');
    context.querySelector('.visualLoginForm').classList.add('hide');
    context.querySelector('.btnManual').classList.add('hide');

    if (focusPassword) {
        context.querySelector('#txtManualPassword').focus();
    } else {
        context.querySelector('#txtManualName').focus();
    }

    if (showCancel) {
        context.querySelector('.btnCancel').classList.remove('hide');
    } else {
        context.querySelector('.btnCancel').classList.add('hide');
    }
}

function loadUserList(context, apiClient, users) {
    let html = '';

    for (const user of users) {
        // TODO move card creation code to Card component
        let cssClass = 'card squareCard scalableCard squareCard-scalable';

        if (layoutManager.tv) {
            cssClass += ' show-focus';

            if (enableFocusTransform) {
                cssClass += ' show-animation';
            }
        }

        const cardBoxCssClass = 'cardBox cardBox-bottompadded';
        html += '<button type="button" class="' + cssClass + '">';
        html += '<div class="' + cardBoxCssClass + '">';
        html += '<div class="cardScalable">';
        html += '<div class="cardPadder cardPadder-square"></div>';
        html += `<div class="cardContent" data-haspw="${user.HasPassword}" data-username="${user.Name}" data-userid="${user.Id}">`;
        let imgUrl;

        if (user.PrimaryImageTag) {
            imgUrl = apiClient.getUserImageUrl(user.Id, {
                width: 300,
                tag: user.PrimaryImageTag,
                type: 'Primary'
            });

            html += '<div class="cardImageContainer coveredImage" style="background-image:url(\'' + imgUrl + "');\"></div>";
        } else {
            html += `<div class="cardImage flex align-items-center justify-content-center ${getDefaultBackgroundClass()}">`;
            html += '<span class="material-icons cardImageIcon person" aria-hidden="true"></span>';
            html += '</div>';
        }

        html += '</div>';
        html += '</div>';
        html += '<div class="cardFooter visualCardBox-cardFooter">';
        html += '<div class="cardText singleCardText cardTextCentered">' + user.Name + '</div>';
        html += '</div>';
        html += '</div>';
        html += '</button>';
    }

    context.querySelector('#divUsers').innerHTML = html;
}

export default function (view, params) {
    let quickConnectSession = null;
    let loginAttemptGeneration = 0;

    function cancelQuickConnectSession() {
        quickConnectSession?.cancel();
        quickConnectSession = null;
    }

    function cancelLoginAttempt() {
        loginAttemptGeneration += 1;
        cancelQuickConnectSession();
    }

    function beginLoginAttempt() {
        cancelLoginAttempt();
        const generation = loginAttemptGeneration;
        return () => generation === loginAttemptGeneration;
    }

    function getApiClient() {
        const serverId = params.serverid;

        if (serverId) {
            return ServerConnections.getOrCreateApiClient(serverId);
        }

        return ApiClient;
    }

    function getTargetUrl() {
        if (params.url) {
            try {
                return decodeURIComponent(params.url);
            } catch {
                console.warn('[LoginPage][navigation]', 'target-url-invalid');
            }
        }

        return '/home';
    }

    function showVisualForm() {
        view.querySelector('.visualLoginForm').classList.remove('hide');
        view.querySelector('.manualLoginForm').classList.add('hide');
        view.querySelector('.btnManual').classList.remove('hide');

        import('../../../components/autoFocuser').then(({ default: autoFocuser }) => {
            autoFocuser.autoFocus(view);
        });
    }

    view.querySelector('#divUsers').addEventListener('click', function (e) {
        const card = dom.parentWithClass(e.target, 'card');
        const cardContent = card ? card.querySelector('.cardContent') : null;

        if (cardContent) {
            const context = view;
            const id = cardContent.getAttribute('data-userid');
            const name = cardContent.getAttribute('data-username');
            const haspw = cardContent.getAttribute('data-haspw');

            if (id === 'manual') {
                cancelLoginAttempt();
                context.querySelector('#txtManualName').value = '';
                showManualForm(context, true);
            } else if (haspw == 'false') {
                const isCurrent = beginLoginAttempt();
                void authenticateUserByName(context, getApiClient(), getTargetUrl(), name, '', isCurrent);
            } else {
                cancelLoginAttempt();
                context.querySelector('#txtManualName').value = name;
                context.querySelector('#txtManualPassword').value = '';
                showManualForm(context, true, true);
            }
        }
    });
    view.querySelector('.manualLoginForm').addEventListener('submit', function (e) {
        const isCurrent = beginLoginAttempt();
        appSettings.enableAutoLogin(view.querySelector('.chkRememberLogin').checked);
        void authenticateUserByName(view, getApiClient(), getTargetUrl(), view.querySelector('#txtManualName').value, view.querySelector('#txtManualPassword').value, isCurrent);
        e.preventDefault();
        return false;
    });
    view.querySelector('.btnForgotPassword').addEventListener('click', function () {
        cancelLoginAttempt();
        Dashboard.navigate('forgotpassword');
    });
    view.querySelector('.btnCancel').addEventListener('click', function () {
        cancelLoginAttempt();
        showVisualForm();
    });
    view.querySelector('.btnQuick').addEventListener('click', function () {
        const isCurrent = beginLoginAttempt();
        quickConnectSession = authenticateQuickConnect(getApiClient(), getTargetUrl(), isCurrent, this);
        return false;
    });
    view.querySelector('.btnManual').addEventListener('click', function () {
        cancelLoginAttempt();
        view.querySelector('#txtManualName').value = '';
        showManualForm(view, true);
    });
    view.querySelector('.btnSelectServer').addEventListener('click', function () {
        cancelLoginAttempt();
        Dashboard.selectServer();
    });

    view.addEventListener('viewshow', function () {
        loading.show();
        libraryMenu.setTransparentMenu(true);

        if (!appHost.supports(AppFeature.MultiServer)) {
            view.querySelector('.btnSelectServer').classList.add('hide');
        }

        const apiClient = getApiClient();

        apiClient.getQuickConnect('Enabled')
            .then(enabled => {
                if (enabled === true) {
                    view.querySelector('.btnQuick').classList.remove('hide');
                }
            })
            .catch(() => {
                console.debug('Failed to get QuickConnect status');
            });

        apiClient.getPublicUsers().then(function (users) {
            if (users.length) {
                showVisualForm();
                loadUserList(view, apiClient, users);
            } else {
                view.querySelector('#txtManualName').value = '';
                showManualForm(view, false, false);
            }
        }).catch().then(function () {
            loading.hide();
        });
        apiClient.getJSON(apiClient.getUrl('Branding/Configuration')).then(function (options) {
            const loginDisclaimer = view.querySelector('.loginDisclaimer');

            // eslint-disable-next-line sonarjs/disabled-auto-escaping
            loginDisclaimer.innerHTML = DOMPurify.sanitize(markdownIt({ html: true }).render(options.LoginDisclaimer || ''));

            for (const elem of loginDisclaimer.querySelectorAll('a')) {
                elem.rel = 'noopener noreferrer';
                elem.target = '_blank';
                elem.classList.add('button-link');
                elem.setAttribute('is', 'emby-linkbutton');

                if (layoutManager.tv) {
                    // Disable links navigation on TV
                    elem.tabIndex = -1;
                }
            }
        });
    });
    view.addEventListener('viewhide', function () {
        cancelLoginAttempt();
        libraryMenu.setTransparentMenu(false);
    });
}

import { CancelledError } from '@tanstack/react-query';
import Events from '../utils/events';

import focusManager from '../components/focusManager';
import { destroyTvHomeDashboard, loadTvHomeDashboard, showUnavailableTvHomeDashboard } from '../components/homesections/sections/tvHomeDashboard';
import { destroyTvHomeHero, loadTvHomeHero } from '../components/homesections/sections/tvHomeHero';
import { createHomeImageScope } from '../components/homesections/homeImageScope';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import { createSessionScopedReadApi, SessionReadCancelledError } from 'utils/jellyfin-apiclient/sessionReadApi';
import { createSessionImageRead } from 'utils/jellyfin-apiclient/sessionImageRead';

import '../components/homesections/homesections.scss';
import '../elements/emby-itemscontainer/emby-itemscontainer';

class HomeTab {
    constructor(view) {
        this.view = view;
        this.heroElement = view.querySelector('.tvHomeHero');
        this.dashboardElement = view.querySelector('.tvHomeDashboard');
        this.generation = 0;
        this.paused = true;
        this.imageScope = null;
        this.unsubscribeAuthority = null;
        this.sessionEventHandler = null;
    }

    onResume(options) {
        this.clear();
        const generation = ++this.generation;
        this.paused = false;
        const apiClient = ServerConnections.currentApiClient();
        let port;
        try {
            port = apiClient && getWebSessionSwitchApplication(ServerConnections).captureBoundSessionRead(apiClient);
        } catch {
            port = null;
        }

        if (!apiClient || !port) {
            showUnavailableTvHomeDashboard(this.dashboardElement);
            return Promise.resolve();
        }
        const read = createSessionScopedReadApi(apiClient, port);

        const assertCurrent = () => {
            if (this.paused || this.generation !== generation || !this.view) {
                throw new SessionReadCancelledError();
            }
            read.assertCurrent();
        };
        const verifyAuthority = () => {
            try {
                assertCurrent();
            } catch {
                if (this.generation === generation) {
                    this.onPause();
                    showUnavailableTvHomeDashboard(this.dashboardElement);
                }
            }
        };

        this.unsubscribeAuthority = ServerConnections.subscribeSessionSwitchEnvelope(read.identity.serverId, verifyAuthority);
        this.sessionEventHandler = verifyAuthority;
        for (const event of ['localusersignedin', 'localusersignedout', 'sessionswitchcompleted']) {
            Events.on(ServerConnections, event, verifyAuthority);
        }
        try {
            assertCurrent();
        } catch (error) {
            if (error instanceof CancelledError) {
                this.clear();
                showUnavailableTvHomeDashboard(this.dashboardElement);
                return Promise.resolve();
            }
            throw error;
        }

        this.imageScope = createHomeImageScope(this.view, createSessionImageRead(apiClient, port));
        return read.getCurrentUser().then(user => {
            assertCurrent();
            if (!user?.Id || user.Id !== read.identity.profileUserId
                || user.ServerId && user.ServerId !== read.identity.serverId) {
                throw new SessionReadCancelledError();
            }
            const homeRead = { apiClient, read, user, assertCurrent, images: this.imageScope };
            return Promise.all([
                loadTvHomeHero(this.heroElement, homeRead),
                loadTvHomeDashboard(this.dashboardElement, homeRead)
            ]);
        }).then(() => {
            assertCurrent();
            if (options.autoFocus) focusManager.autoFocus(this.view);
        }).catch(error => {
            if (error instanceof CancelledError) return;
            try {
                assertCurrent();
            } catch {
                return;
            }
            console.error('[HomeTab] Failed to load Home');
            showUnavailableTvHomeDashboard(this.dashboardElement);
        });
    }

    onPause() {
        this.generation++;
        this.paused = true;
        this.clear();
    }

    destroy() {
        this.onPause();
        this.view = null;
        this.heroElement = null;
        this.dashboardElement = null;
    }

    clear() {
        this.unsubscribeAuthority?.();
        this.unsubscribeAuthority = null;
        if (this.sessionEventHandler) {
            for (const event of ['localusersignedin', 'localusersignedout', 'sessionswitchcompleted']) {
                Events.off(ServerConnections, event, this.sessionEventHandler);
            }
            this.sessionEventHandler = null;
        }
        this.imageScope?.dispose();
        this.imageScope = null;
        destroyTvHomeDashboard(this.dashboardElement);
        if (this.heroElement) destroyTvHomeHero(this.heroElement);
    }
}

export default HomeTab;

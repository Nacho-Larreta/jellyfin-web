import { CancelledError } from '@tanstack/react-query';

import focusManager from '../components/focusManager';
import { destroyTvHomeDashboard, loadTvHomeDashboard, showUnavailableTvHomeDashboard } from '../components/homesections/sections/tvHomeDashboard';
import { destroyTvHomeHero, loadTvHomeHero } from '../components/homesections/sections/tvHomeHero';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import { createSessionScopedReadApi, SessionReadCancelledError } from 'utils/jellyfin-apiclient/sessionReadApi';

import '../elements/emby-itemscontainer/emby-itemscontainer';

class HomeTab {
    constructor(view) {
        this.view = view;
        this.heroElement = view.querySelector('.tvHomeHero');
        this.dashboardElement = view.querySelector('.tvHomeDashboard');
        this.generation = 0;
        this.paused = true;
    }

    onResume(options) {
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
            this.clear();
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

        this.clear();
        return read.getCurrentUser().then(user => {
            assertCurrent();
            if (!user?.Id || user.Id !== read.identity.profileUserId
                || user.ServerId && user.ServerId !== read.identity.serverId) {
                throw new SessionReadCancelledError();
            }
            const homeRead = { apiClient, read, user, assertCurrent };
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
        destroyTvHomeDashboard(this.dashboardElement);
        if (this.heroElement) destroyTvHomeHero(this.heroElement);
    }
}

export default HomeTab;

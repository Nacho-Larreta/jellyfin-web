import * as userSettings from '../scripts/settings/userSettings';
import focusManager from '../components/focusManager';
import homeSections from '../components/homesections/homesections';
import { destroyTvHomeDashboard, loadTvHomeDashboard } from '../components/homesections/sections/tvHomeDashboard';
import { destroyTvHomeHero, loadTvHomeHero } from '../components/homesections/sections/tvHomeHero';
import { ServerConnections } from 'lib/jellyfin-apiclient';

import '../elements/emby-itemscontainer/emby-itemscontainer';

class HomeTab {
    constructor(view, params) {
        this.view = view;
        this.params = params;
        this.apiClient = ServerConnections.currentApiClient();
        this.heroElement = view.querySelector('.tvHomeHero');
        this.dashboardElement = view.querySelector('.tvHomeDashboard');
        this.sectionsContainer = view.querySelector('.sections');
        view.querySelector('.sections').addEventListener('settingschange', onHomeScreenSettingsChanged.bind(this));
    }
    onResume(options) {
        const heroPromise = loadTvHomeHero(this.heroElement, this.apiClient);
        const dashboardElement = this.dashboardElement;

        if (dashboardElement) {
            this.destroyHomeSections();
            this.sectionsRendered = false;

            return Promise.all([
                heroPromise,
                loadTvHomeDashboard(dashboardElement, this.apiClient)
                    .catch(err => {
                        console.error('[HomeTab] Custom TV home failed; falling back to legacy home sections', err);
                        destroyTvHomeDashboard(dashboardElement);
                        return this.apiClient.getCurrentUser()
                            .then(user => homeSections.loadSections(this.sectionsContainer, this.apiClient, user, userSettings));
                    })
            ])
                .then(() => {
                    if (options.autoFocus) {
                        focusManager.autoFocus(this.view);
                    }
                });
        }

        if (this.sectionsRendered) {
            const sectionsContainer = this.sectionsContainer;

            if (sectionsContainer) {
                return Promise.all([
                    heroPromise,
                    homeSections.resume(sectionsContainer, options)
                ]);
            }

            return heroPromise;
        }

        const view = this.view;
        const apiClient = this.apiClient;
        this.destroyHomeSections();
        this.sectionsRendered = true;
        return Promise.all([
            heroPromise,
            apiClient.getCurrentUser()
                .then(user => homeSections.loadSections(view.querySelector('.sections'), apiClient, user, userSettings))
        ])
            .then(() => {
                if (options.autoFocus) {
                    focusManager.autoFocus(view);
                }
            }).catch(err => {
                console.error(err);
            });
    }
    onPause() {
        const sectionsContainer = this.sectionsContainer;

        if (sectionsContainer) {
            homeSections.pause(sectionsContainer);
        }
    }
    destroy() {
        this.view = null;
        this.params = null;
        this.apiClient = null;
        this.destroyHomeSections();
        if (this.dashboardElement) {
            destroyTvHomeDashboard(this.dashboardElement);
        }
        if (this.heroElement) {
            destroyTvHomeHero(this.heroElement);
        }
        this.heroElement = null;
        this.dashboardElement = null;
        this.sectionsContainer = null;
    }
    destroyHomeSections() {
        const sectionsContainer = this.sectionsContainer;

        if (sectionsContainer) {
            homeSections.destroySections(sectionsContainer);
        }
    }
}

function onHomeScreenSettingsChanged() {
    this.sectionsRendered = false;

    if (!this.paused) {
        this.onResume({
            refresh: true
        });
    }
}

export default HomeTab;

import * as userSettings from '../scripts/settings/userSettings';
import focusManager from '../components/focusManager';
import homeSections from '../components/homesections/homesections';
import { destroyTvHomeHero, loadTvHomeHero } from '../components/homesections/sections/tvHomeHero';
import { ServerConnections } from 'lib/jellyfin-apiclient';

import '../elements/emby-itemscontainer/emby-itemscontainer';

class HomeTab {
    constructor(view, params) {
        this.view = view;
        this.params = params;
        this.apiClient = ServerConnections.currentApiClient();
        this.heroElement = view.querySelector('.tvHomeHero');
        this.sectionsContainer = view.querySelector('.sections');
        view.querySelector('.sections').addEventListener('settingschange', onHomeScreenSettingsChanged.bind(this));
    }
    onResume(options) {
        const heroPromise = loadTvHomeHero(this.heroElement, this.apiClient);

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
        if (this.heroElement) {
            destroyTvHomeHero(this.heroElement);
        }
        this.heroElement = null;
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

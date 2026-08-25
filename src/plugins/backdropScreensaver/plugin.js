
import { ServerConnections } from 'lib/jellyfin-apiclient';
import * as userSettings from 'scripts/settings/userSettings';
import { PluginType } from 'types/plugin.ts';

import { NeutralLogoScreensaver } from './NeutralLogoScreensaver.ts';
import { ScreensaverContentPolicy } from './ScreensaverContentPolicy.ts';

const defaultDependencies = {
    getApiClient: () => ServerConnections.currentApiClient(),
    loadSlideshow: () => import('../../components/slideshow/slideshow'),
    createFallback: () => new NeutralLogoScreensaver()
};

class BackdropScreensaver {
    constructor(dependencies = defaultDependencies) {
        this.name = 'BackdropScreensaver';
        this.type = PluginType.Screensaver;
        this.id = 'backdropscreensaver';
        this.supportsAnonymous = false;
        this.dependencies = dependencies;
        this.fallback = dependencies.createFallback();
        this.generation = 0;
    }

    show() {
        const policy = new ScreensaverContentPolicy(userSettings.screensaverAgeCeiling());
        this.currentPolicy = policy;
        return this.start(policy);
    }

    retry() {
        if (!this.currentPolicy) {
            return Promise.resolve();
        }

        return this.start(this.currentPolicy);
    }

    start(policy) {
        const generation = ++this.generation;
        const previousSlideshow = this.currentSlideshow;
        this.currentSlideshow = null;
        this.fallback.show();

        const previousHide = previousSlideshow?.hide() ?? Promise.resolve();
        return Promise.resolve(previousHide)
            .then(() => this.load(generation, policy));
    }

    async load(generation, policy) {
        try {
            const apiClient = this.dependencies.getApiClient();
            const catalog = await apiClient.getParentalRatings();
            if (!this.isActive(generation) || !Array.isArray(catalog)) {
                return;
            }

            const result = await apiClient.getItems(apiClient.getCurrentUserId(), policy.buildQuery());
            if (!this.isActive(generation)) {
                return;
            }

            const items = policy.filterEligibleItems(Array.isArray(result?.Items) ? result.Items : [], catalog);
            if (items.length === 0) {
                return;
            }

            const { default: Slideshow } = await this.dependencies.loadSlideshow();
            if (!this.isActive(generation)) {
                return;
            }

            const slideshow = new Slideshow({
                showTitle: true,
                cover: true,
                items,
                autoplay: {
                    delay: userSettings.backdropScreensaverInterval() * 1000
                }
            });

            await this.fallback.hide();
            if (!this.isActive(generation)) {
                return;
            }

            slideshow.show();
            this.currentSlideshow = slideshow;
        } catch {
            // The neutral fallback remains visible. Retrying must reuse currentPolicy.
        }
    }

    isActive(generation) {
        return generation === this.generation;
    }

    hide() {
        this.generation++;
        this.currentPolicy = null;

        const slideshow = this.currentSlideshow;
        this.currentSlideshow = null;

        return Promise.all([
            slideshow?.hide() ?? Promise.resolve(),
            this.fallback.hide()
        ]).then(() => undefined);
    }
}

export default BackdropScreensaver;

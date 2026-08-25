import icon from '@jellyfin/ux-web/icon-transparent.png';

import '../logoScreensaver/style.scss';

const logoScreensaverClass = 'logoScreenSaver';

export class NeutralLogoScreensaver {
    private element?: HTMLDivElement;

    show() {
        if (this.element?.isConnected) {
            return;
        }

        const container = document.createElement('div');
        container.classList.add(logoScreensaverClass);

        const image = document.createElement('img');
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        image.classList.add('logoScreenSaverImage');
        image.src = icon;

        container.appendChild(image);
        document.body.appendChild(container);
        this.element = container;
    }

    hide() {
        this.element?.remove();
        this.element = undefined;
        return Promise.resolve();
    }
}

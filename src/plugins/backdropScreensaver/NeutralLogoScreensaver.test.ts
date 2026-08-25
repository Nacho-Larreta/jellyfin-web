import { afterEach, describe, expect, it } from 'vitest';

import { NeutralLogoScreensaver } from './NeutralLogoScreensaver';

describe('NeutralLogoScreensaver', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('renders one decorative Jellyfin logo and removes it synchronously on hide', async () => {
        const fallback = new NeutralLogoScreensaver();

        fallback.show();
        fallback.show();

        const logos = document.querySelectorAll('.logoScreenSaver');
        const image = logos[0]?.querySelector('img');
        expect(logos).toHaveLength(1);
        expect(image?.getAttribute('alt')).toBe('');
        expect(image?.getAttribute('aria-hidden')).toBe('true');

        await fallback.hide();
        expect(document.querySelector('.logoScreenSaver')).toBeNull();
    });
});

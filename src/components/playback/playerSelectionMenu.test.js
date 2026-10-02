import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    close: vi.fn(),
    createDialog: vi.fn(() => document.createElement('div')),
    dialogShow: vi.fn(async () => 'cancel'),
    getPlayerInfo: vi.fn(),
    getSupportedCommands: vi.fn(() => [ 'EndSession' ]),
    open: vi.fn(() => Promise.resolve()),
    isEnabled: vi.fn(async () => false)
}));

vi.mock('constants/appFeature', () => ({ AppFeature: {} }));
vi.mock('../../utils/events.ts', () => ({ default: { on: vi.fn() } }));
vi.mock('../../scripts/browser', () => ({ default: {} }));
vi.mock('../loading/loading', () => ({ default: { show: vi.fn(), hide: vi.fn() } }));
vi.mock('./playbackmanager', () => ({
    playbackManager: {
        getPlayerInfo: mocks.getPlayerInfo,
        getSupportedCommands: mocks.getSupportedCommands,
        enableDisplayMirroring: vi.fn(() => false)
    }
}));
vi.mock('../pluginManager', () => ({ pluginManager: { plugins: [] } }));
vi.mock('../router/appRouter', () => ({ appRouter: { showNowPlaying: vi.fn() } }));
vi.mock('../../lib/globalize', () => ({ default: { translate: (key, name) => name ? `${key} ${name}` : key } }));
vi.mock('../apphost', () => ({ appHost: { supports: vi.fn(() => false) } }));
vi.mock('../../scripts/autocast', () => ({ enable: vi.fn(), isEnabled: mocks.isEnabled }));
vi.mock('../../elements/emby-checkbox/emby-checkbox', () => ({}));
vi.mock('../../elements/emby-button/emby-button', () => ({}));
vi.mock('../dialog/dialog', () => ({ default: { show: mocks.dialogShow } }));
vi.mock('../dialogHelper/dialogHelper', () => ({
    default: { createDialog: mocks.createDialog, close: mocks.close, open: mocks.open }
}));

import { show } from './playerSelectionMenu';

describe('active player menu device heading', () => {
    beforeEach(() => {
        mocks.close.mockClear();
        mocks.createDialog.mockClear();
        mocks.dialogShow.mockClear();
        mocks.getPlayerInfo.mockReset();
    });

    function showForDevice(deviceName) {
        mocks.getPlayerInfo.mockReturnValue({
            deviceName,
            name: 'Google Cast',
            isLocalPlayer: false,
            supportedCommands: []
        });
        show();
        return mocks.createDialog.mock.results[0].value;
    }

    it('renders receiver supplied markup as text without creating executable elements', () => {
        const deviceName = '<img src=x onerror="window.castMenuInjected = true">';
        const dialog = showForDevice(deviceName);

        expect(dialog.querySelector('h2')?.textContent).toBe(deviceName);
        expect(dialog.querySelector('img')).toBeNull();
        expect(window.castMenuInjected).toBeUndefined();
    });

    it('preserves a normal device name and cancel action', () => {
        const dialog = showForDevice('Living Room TV');

        expect(dialog.querySelector('h2')?.textContent).toBe('Living Room TV');
        dialog.querySelector('.btnCancel').click();
        expect(mocks.close).toHaveBeenCalledWith(dialog);
    });

    it('passes escaped receiver text to the disconnect confirmation', async () => {
        const dialog = showForDevice('<img src=x onerror=alert(1)>');

        dialog.querySelector('.btnDisconnect').click();
        await vi.waitFor(() => expect(mocks.dialogShow).toHaveBeenCalledOnce());

        const confirmation = mocks.dialogShow.mock.calls[0][0];
        expect(confirmation.text).toContain('&lt;img');
        expect(confirmation.text).not.toContain('<img');
    });
});

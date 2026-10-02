import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QuickConnectPage from './index';

const authorizeQuickConnect = vi.hoisted(() => vi.fn());

vi.mock('@jellyfin/sdk/lib/utils/api/quick-connect-api', () => ({
    getQuickConnectApi: () => ({ authorizeQuickConnect })
}));
vi.mock('hooks/useApi', () => ({
    useApi: () => ({ api: {}, user: { Id: 'fallback-user' } })
}));
vi.mock('components/Page', () => ({
    default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>
}));
vi.mock('components/layoutManager', () => ({ default: { tv: false } }));
vi.mock('lib/globalize', () => ({ default: { translate: (key: string) => key } }));

const consoleMethods = [ 'debug', 'error', 'info', 'log', 'warn', 'trace', 'dir', 'table' ] as const;
const rawCode = '123 456';
const codeInUrl = '123%20456';
const normalizedCode = '123456';
const targetUser = 'user+private@test';

describe('Quick Connect authorizer form', () => {
    let root: Root;
    let container: HTMLDivElement;
    let consoleSpies: ReturnType<typeof vi.spyOn>[];

    beforeEach(async () => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        authorizeQuickConnect.mockReset();
        consoleSpies = consoleMethods.map(method => vi.spyOn(console, method).mockImplementation(() => undefined));
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        await act(async () => root.render(
            <MemoryRouter initialEntries={[ `/quickconnect?code=${codeInUrl}&userId=${encodeURIComponent(targetUser)}` ]}>
                <QuickConnectPage />
            </MemoryRouter>
        ));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        consoleSpies.forEach(spy => {
            spy.mockRestore();
        });
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    });

    async function submitCode() {
        const form = container.querySelector('form');
        expect(form).not.toBeNull();
        await act(async () => {
            form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
    }

    function expectNoPairingIdentifiersInConsole() {
        const allArguments = consoleSpies.flatMap(spy => spy.mock.calls.flat());
        const printed = allArguments.map(argument => String(argument)).join(' ');
        const markers = [ rawCode, normalizedCode, targetUser ];
        const leaked = markers.some(marker => [ marker, encodeURIComponent(marker), encodeURIComponent(encodeURIComponent(marker)) ]
            .some(variant => printed.includes(variant)));
        expect(leaked).toBe(false);
    }

    it('authorizes the normalized code and target user without logging either on success', async () => {
        authorizeQuickConnect.mockResolvedValue(undefined);
        await submitCode();

        expect(authorizeQuickConnect).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(authorizeQuickConnect.mock.calls[0]?.[0])).toBe(JSON.stringify({
            code: normalizedCode,
            userId: targetUser
        }));
        expect(container.textContent?.includes('QuickConnectAuthorizeSuccess')).toBe(true);
        expectNoPairingIdentifiersInConsole();
    });

    it('keeps the same request and shows the failure state without logging pairing data', async () => {
        authorizeQuickConnect.mockRejectedValue(new Error('synthetic failure'));
        await submitCode();

        expect(authorizeQuickConnect).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(authorizeQuickConnect.mock.calls[0]?.[0])).toBe(JSON.stringify({
            code: normalizedCode,
            userId: targetUser
        }));
        expect(container.textContent?.includes('QuickConnectAuthorizeFail')).toBe(true);
        expectNoPairingIdentifiersInConsole();
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    closeDialog: vi.fn(),
    captureLoginAuthority: vi.fn(() => 0),
    currentApiClient: vi.fn(() => null),
    dashboardAlert: vi.fn(),
    dialogShow: vi.fn(),
    getOrCreateApiClient: vi.fn(),
    navigate: vi.fn(),
    onServerChanged: vi.fn(),
    publishLoginAuthentication: vi.fn().mockResolvedValue(undefined),
    routerReady: vi.fn(() => Promise.resolve()),
    resolveProfileSelectorRoute: vi.fn(),
    translate: vi.fn(key => key)
}));

vi.mock('constants/appFeature', () => ({ AppFeature: { MultiServer: 'multi-server' } }));
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        currentApiClient: mocks.currentApiClient,
        getOrCreateApiClient: mocks.getOrCreateApiClient,
        captureLoginAuthority: mocks.captureLoginAuthority,
        publishLoginAuthentication: mocks.publishLoginAuthentication
    }
}));
vi.mock('../../../components/apphost', () => ({
    appHost: { supports: vi.fn(() => true) }
}));
vi.mock('../../../components/dialog/dialog', () => ({
    default: { show: mocks.dialogShow }
}));
vi.mock('../../../components/router/appRouter', () => ({
    appRouter: { ready: mocks.routerReady }
}));
vi.mock('../../../components/cardbuilder/utils/builder', () => ({
    getDefaultBackgroundClass: vi.fn(() => 'default-background')
}));
vi.mock('../../../components/dialogHelper/dialogHelper', () => ({
    default: { close: mocks.closeDialog }
}));
vi.mock('../../../components/layoutManager', () => ({
    default: { tv: false }
}));
vi.mock('../../../components/loading/loading', () => ({
    default: { hide: vi.fn(), show: vi.fn() }
}));
vi.mock('../../../components/toast/toast', () => ({ default: vi.fn() }));
vi.mock('../../../elements/emby-checkbox/emby-checkbox', () => ({}));
vi.mock('../../../lib/profileSelector/navigation', () => ({
    resolveProfileSelectorRoute: mocks.resolveProfileSelectorRoute
}));
vi.mock('../../../lib/globalize', () => ({
    default: { translate: mocks.translate }
}));
vi.mock('../../../scripts/browser', () => ({
    default: { edge: false, slow: false }
}));
vi.mock('../../../scripts/libraryMenu', () => ({
    default: { setTransparentMenu: vi.fn() }
}));
vi.mock('../../../scripts/settings/appSettings', () => ({
    default: { enableAutoLogin: vi.fn(() => true) }
}));
vi.mock('../../../utils/dom', () => ({
    default: { parentWithClass: vi.fn() }
}));
vi.mock('../../../utils/dashboard', () => ({
    default: {
        alert: mocks.dashboardAlert,
        navigate: mocks.navigate,
        onServerChanged: mocks.onServerChanged,
        selectServer: vi.fn()
    }
}));

import createLoginController, { authenticateQuickConnect } from './index';

const CONSOLE_METHOD_ALLOWLIST = Object.freeze([
    'debug',
    'error',
    'info',
    'log',
    'warn',
    'trace',
    'dir',
    'table'
].filter(method => typeof console[method] === 'function'));
const RAW_MARKER = 'raw secret+/=?#pairing-marker';
const ENCODED_MARKER = encodeURIComponent(RAW_MARKER);
const DOUBLE_ENCODED_MARKER = encodeURIComponent(ENCODED_MARKER);

let consoleSpies;
let dialogs;

function createApiClient() {
    return {
        accessToken: vi.fn(() => 'active-token'),
        ajax: vi.fn(),
        getCurrentUserId: vi.fn(() => 'user-1'),
        getUrl: vi.fn(path => `https://server.test${path}`),
        onAuthenticated: vi.fn(),
        serverId: vi.fn(() => 'server-1'),
        setRequestHeaders: vi.fn(headers => { headers.Authorization = 'MediaBrowser test'; })
    };
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function createSensitiveFailure() {
    const cause = new Error(ENCODED_MARKER);
    cause.stack = `${cause.stack}\n${DOUBLE_ENCODED_MARKER}`;
    const error = new Error(RAW_MARKER, { cause });
    error.requestUrl = new URL(`https://server.test/QuickConnect?value=${ENCODED_MARKER}`);
    error.details = { value: DOUBLE_ENCODED_MARKER };
    return error;
}

function collectStrings(value, seen = new Set()) {
    if (typeof value === 'string') return [ value ];
    if (value === null || value === undefined || typeof value !== 'object') return [];
    if (seen.has(value)) return [];
    seen.add(value);

    if (value instanceof URL) return [ value.href ];
    return Reflect.ownKeys(value).flatMap(key => (
        [ String(key), ...collectStrings(value[key], seen) ]
    ));
}

function expectNoSensitiveConsoleValues() {
    const values = CONSOLE_METHOD_ALLOWLIST.flatMap(method => (
        consoleSpies[method].mock.calls.flatMap(call => collectStrings(call))
    ));

    for (const marker of [ RAW_MARKER, ENCODED_MARKER, DOUBLE_ENCODED_MARKER ]) {
        expect(values.every(value => !value.includes(marker))).toBe(true);
    }
}

function expectOnlyDiagnostic(code) {
    expect(consoleSpies.error.mock.calls).toEqual([
        [ '[LoginPage][quick-connect]', code ]
    ]);
    for (const method of CONSOLE_METHOD_ALLOWLIST.filter(candidate => candidate !== 'error')) {
        expect(consoleSpies[method]).not.toHaveBeenCalled();
    }
    expectNoSensitiveConsoleValues();
}

function expectNoConsoleCalls() {
    for (const method of CONSOLE_METHOD_ALLOWLIST) {
        expect(consoleSpies[method]).not.toHaveBeenCalled();
    }
}

function validInitiate(apiClient, secret = 'safe-secret') {
    apiClient.ajax.mockImplementation(request => {
        if (request.url.includes('AuthenticateWithQuickConnect')) {
            return Promise.resolve({
                AccessToken: 'new-token',
                ServerId: 'server-1',
                User: { Id: 'new-user' }
            });
        }
        return Promise.resolve({
            json: vi.fn().mockResolvedValue({ Secret: secret, Code: '123456' })
        });
    });
}

function pollingResponse(value) {
    return { ok: true, json: vi.fn().mockResolvedValue(value) };
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function createViewHarness() {
    const viewListeners = new Map();
    const elements = new Map();
    const element = selector => {
        if (!elements.has(selector)) {
            const listeners = new Map();
            elements.set(selector, {
                addEventListener: (event, listener) => listeners.set(event, listener),
                checked: false,
                classList: { add: vi.fn(), remove: vi.fn() },
                focus: vi.fn(),
                listeners,
                value: ''
            });
        }
        return elements.get(selector);
    };
    return {
        element,
        view: {
            addEventListener: (event, listener) => viewListeners.set(event, listener),
            querySelector: element
        },
        viewListeners
    };
}

describe('Quick Connect login diagnostics and polling lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        document.body.replaceChildren();
        mocks.captureLoginAuthority.mockReturnValue(0);
        mocks.publishLoginAuthentication.mockResolvedValue(undefined);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pollingResponse({ Authenticated: false })));
        dialogs = [];
        mocks.routerReady.mockImplementation(() => Promise.resolve());
        mocks.dialogShow.mockImplementation(options => {
            const element = document.createElement('div');
            element.id = options.dialogOptions.id;
            document.body.append(element);
            const result = createDeferred();
            dialogs.push({ element, result });
            return result.promise;
        });
        mocks.closeDialog.mockImplementation(element => {
            element.dispatchEvent(new Event('closing'));
            element.remove();
            dialogs.find(dialog => dialog.element === element)?.result.reject();
        });
        consoleSpies = Object.fromEntries(CONSOLE_METHOD_ALLOWLIST.map(method => [
            method,
            vi.spyOn(console, method).mockImplementation(() => undefined)
        ]));
    });

    afterEach(() => {
        document.body.replaceChildren();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([ 'initiate', 'polling' ])(
        'contains a getUrl failure at the %s boundary without rejecting or logging it',
        async boundary => {
            const apiClient = createApiClient();
            validInitiate(apiClient);
            if (boundary === 'initiate') {
                apiClient.getUrl.mockImplementationOnce(() => {
                    throw createSensitiveFailure();
                });
            } else {
                apiClient.getUrl
                    .mockImplementationOnce(path => `https://server.test${path}`)
                    .mockImplementationOnce(() => {
                        throw createSensitiveFailure();
                    });
            }

            const session = authenticateQuickConnect(apiClient, '/home');

            await expect(session.started).resolves.toBe(boundary === 'polling');
            if (boundary === 'polling') {
                await vi.advanceTimersByTimeAsync(5_000);
            }
            expectOnlyDiagnostic(boundary === 'polling' ? 'poll-or-connect-failed' : 'initiate-failed');
            expect(vi.getTimerCount()).toBe(0);
        }
    );

    it('does not log pairing data from a malformed initiate response', async () => {
        const apiClient = createApiClient();
        apiClient.ajax.mockResolvedValue({
            json: vi.fn().mockResolvedValue({
                Secret: RAW_MARKER,
                requestUrl: ENCODED_MARKER,
                nested: { Code: DOUBLE_ENCODED_MARKER }
            })
        });
        const session = authenticateQuickConnect(apiClient, '/home');

        await expect(session.started).resolves.toBe(false);
        expectOnlyDiagnostic('initiate-malformed');
    });

    it('does not log nested Error fields from an initiate request failure', async () => {
        const apiClient = createApiClient();
        apiClient.ajax.mockRejectedValue(createSensitiveFailure());
        const session = authenticateQuickConnect(apiClient, '/home');

        await expect(session.started).resolves.toBe(false);
        expectOnlyDiagnostic('initiate-failed');
    });

    it.each([ 'initiate', 'polling' ])(
        'does not open a delayed %s error dialog after viewhide',
        async boundary => {
            const apiClient = createApiClient();
            const readiness = createDeferred();
            validInitiate(apiClient);
            mocks.getOrCreateApiClient.mockReturnValue(apiClient);
            if (boundary === 'initiate') {
                apiClient.ajax.mockRejectedValue(createSensitiveFailure());
                mocks.routerReady.mockReturnValue(readiness.promise);
            } else {
                fetch.mockRejectedValue(createSensitiveFailure());
                mocks.routerReady
                    .mockImplementationOnce(() => Promise.resolve())
                    .mockReturnValue(readiness.promise);
            }
            const harness = createViewHarness();
            createLoginController(harness.view, { serverid: 'server-1' });

            harness.element('.btnQuick').listeners.get('click')();
            await flushPromises();
            if (boundary === 'polling') {
                await vi.advanceTimersByTimeAsync(5_000);
                expect(mocks.dialogShow).toHaveBeenCalledOnce();
            }
            harness.viewListeners.get('viewhide')();
            readiness.resolve();
            await flushPromises();

            expect(mocks.dialogShow).toHaveBeenCalledTimes(boundary === 'polling' ? 1 : 0);
            expect(mocks.dashboardAlert).not.toHaveBeenCalled();
            expectOnlyDiagnostic(boundary === 'polling' ? 'poll-or-connect-failed' : 'initiate-failed');
        }
    );

    it.each([ 'initiate', 'polling' ])(
        'observes Back rejection from a %s error dialog without exposing the failure',
        async boundary => {
            const apiClient = createApiClient();
            validInitiate(apiClient);
            if (boundary === 'initiate') {
                apiClient.ajax.mockRejectedValue(createSensitiveFailure());
            } else {
                fetch.mockRejectedValue(createSensitiveFailure());
            }
            const session = authenticateQuickConnect(apiClient, '/home');
            await expect(session.started).resolves.toBe(boundary === 'polling');
            if (boundary === 'polling') await vi.advanceTimersByTimeAsync(5_000);
            await flushPromises();

            const errorDialog = dialogs.at(-1);
            expect(errorDialog.element.id).toMatch(/-error$/);
            expect(mocks.dialogShow.mock.lastCall[0].dialogOptions).toMatchObject({
                id: errorDialog.element.id,
                enableHistory: false
            });
            errorDialog.element.dispatchEvent(new Event('closing'));
            errorDialog.result.reject(createSensitiveFailure());
            await flushPromises();

            expect(mocks.dashboardAlert).not.toHaveBeenCalled();
            expectOnlyDiagnostic(boundary === 'polling' ? 'poll-or-connect-failed' : 'initiate-failed');
            session.cancel();
        }
    );

    it.each([
        {
            name: 'polling',
            arrange: () => {
                fetch.mockRejectedValue(createSensitiveFailure());
            }
        },
        {
            name: 'connect',
            arrange: apiClient => {
                fetch.mockResolvedValue(pollingResponse({ Authenticated: true, Secret: RAW_MARKER }));
                apiClient.ajax.mockImplementation(options => (
                    options.dataType === 'json' ?
                        Promise.reject(createSensitiveFailure()) :
                        Promise.resolve({ json: vi.fn().mockResolvedValue({ Secret: 'safe-secret', Code: '123456' }) })
                ));
            }
        }
    ])('does not log nested Error fields from a $name failure', async ({ arrange }) => {
        const apiClient = createApiClient();
        validInitiate(apiClient);
        arrange(apiClient);
        const session = authenticateQuickConnect(apiClient, '/home');

        await expect(session.started).resolves.toBe(true);
        expect(mocks.dialogShow.mock.lastCall[0].dialogOptions).toMatchObject({
            id: dialogs[0].element.id,
            enableHistory: false
        });
        await vi.advanceTimersByTimeAsync(5_000);

        expectOnlyDiagnostic('poll-or-connect-failed');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('completes successfully once and cancels polling before navigation', async () => {
        const apiClient = createApiClient();
        validInitiate(apiClient);
        fetch.mockResolvedValue(pollingResponse({ Authenticated: true, Secret: 'safe-secret' }));
        mocks.resolveProfileSelectorRoute.mockResolvedValue('/home');
        const session = authenticateQuickConnect(apiClient, '/home');

        await expect(session.started).resolves.toBe(true);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(fetch).toHaveBeenCalledOnce();
        expect(mocks.publishLoginAuthentication).toHaveBeenCalledOnce();
        expect(apiClient.onAuthenticated).not.toHaveBeenCalled();
        expect(mocks.closeDialog).toHaveBeenCalledOnce();
        expect(mocks.navigate).toHaveBeenCalledWith('/home');
        expect(vi.getTimerCount()).toBe(0);
        expectNoConsoleCalls();
    });

    it('polls through a same-origin transport without logging an encoded secret URL', async () => {
        const apiClient = createApiClient();
        validInitiate(apiClient, RAW_MARKER);
        const session = authenticateQuickConnect(apiClient, '/home');

        await expect(session.started).resolves.toBe(true);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(fetch).toHaveBeenCalledWith(
            `https://server.test/QuickConnect/Connect?Secret=${ENCODED_MARKER}`,
            {
                method: 'GET',
                credentials: 'same-origin',
                headers: { accept: 'application/json', Authorization: 'MediaBrowser test' }
            }
        );
        expectNoConsoleCalls();
        session.cancel();
    });

    it('does not publish a Quick Connect result that arrives after manual login starts', async () => {
        const apiClient = createApiClient();
        const quickAuthentication = createDeferred();
        validInitiate(apiClient);
        fetch.mockResolvedValue(pollingResponse({ Authenticated: true, Secret: 'safe-secret' }));
        apiClient.ajax.mockImplementation(request => {
            if (request.url.includes('AuthenticateWithQuickConnect')) return quickAuthentication.promise;
            if (request.url.includes('authenticatebyname')) {
                return Promise.resolve({ ServerId: 'server-1', AccessToken: 'manual-token', User: { Id: 'manual-user' } });
            }
            return Promise.resolve({ json: vi.fn().mockResolvedValue({ Secret: 'safe-secret', Code: '123456' }) });
        });
        mocks.getOrCreateApiClient.mockReturnValue(apiClient);
        mocks.resolveProfileSelectorRoute.mockResolvedValue('/home');
        const harness = createViewHarness();
        createLoginController(harness.view, { serverid: 'server-1' });

        harness.element('.btnQuick').listeners.get('click')();
        await flushPromises();
        await vi.advanceTimersByTimeAsync(5_000);
        harness.element('#txtManualName').value = 'manual-user';
        harness.element('.manualLoginForm').listeners.get('submit')({ preventDefault: vi.fn() });
        await flushPromises();
        quickAuthentication.resolve({ ServerId: 'server-1', AccessToken: 'stale-token', User: { Id: 'stale-user' } });
        await flushPromises();

        expect(mocks.publishLoginAuthentication).toHaveBeenCalledOnce();
        expect(mocks.publishLoginAuthentication.mock.calls[0][1].User.Id).toBe('manual-user');
        expect(apiClient.onAuthenticated).not.toHaveBeenCalled();
        expectNoConsoleCalls();
    });

    it('publishes only the newest out-of-order manual login response', async () => {
        const apiClient = createApiClient();
        const first = createDeferred();
        const second = createDeferred();
        apiClient.ajax.mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        mocks.getOrCreateApiClient.mockReturnValue(apiClient);
        mocks.resolveProfileSelectorRoute.mockResolvedValue('/home');
        const harness = createViewHarness();
        createLoginController(harness.view, { serverid: 'server-1' });

        const submit = harness.element('.manualLoginForm').listeners.get('submit');
        harness.element('#txtManualName').value = 'old-user';
        submit({ preventDefault: vi.fn() });
        harness.element('#txtManualName').value = 'new-user';
        submit({ preventDefault: vi.fn() });
        second.resolve({ ServerId: 'server-1', AccessToken: 'new-token', User: { Id: 'new-user' } });
        await flushPromises();
        first.resolve({ ServerId: 'server-1', AccessToken: 'old-token', User: { Id: 'old-user' } });
        await flushPromises();

        expect(mocks.publishLoginAuthentication).toHaveBeenCalledOnce();
        expect(mocks.publishLoginAuthentication.mock.calls[0][1].User.Id).toBe('new-user');
        expect(apiClient.onAuthenticated).not.toHaveBeenCalled();
        expectNoConsoleCalls();
    });

    it('does not navigate when viewhide occurs during committed login bootstrap', async () => {
        const apiClient = createApiClient();
        const bootstrap = createDeferred();
        validInitiate(apiClient);
        fetch.mockResolvedValue(pollingResponse({ Authenticated: true, Secret: 'safe-secret' }));
        mocks.publishLoginAuthentication.mockReturnValue(bootstrap.promise);
        mocks.getOrCreateApiClient.mockReturnValue(apiClient);
        const harness = createViewHarness();
        createLoginController(harness.view, { serverid: 'server-1' });

        harness.element('.btnQuick').listeners.get('click')();
        await flushPromises();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mocks.publishLoginAuthentication).toHaveBeenCalledOnce();
        harness.viewListeners.get('viewhide')();
        bootstrap.resolve();
        await flushPromises();

        expect(mocks.navigate).not.toHaveBeenCalled();
        expectNoConsoleCalls();
    });

    it('keeps a slow poll single-flight and schedules the next poll only after completion', async () => {
        const apiClient = createApiClient();
        const firstPoll = createDeferred();
        validInitiate(apiClient);
        fetch.mockImplementationOnce(() => firstPoll.promise)
            .mockResolvedValue(pollingResponse({ Authenticated: false }));
        const session = authenticateQuickConnect(apiClient, '/home');

        await expect(session.started).resolves.toBe(true);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(fetch).toHaveBeenCalledOnce();

        firstPoll.resolve(pollingResponse({ Authenticated: false }));
        await flushPromises();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(fetch).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);

        session.cancel();
        expect(vi.getTimerCount()).toBe(0);
        expectNoConsoleCalls();
    });

    it('viewhide cancels an in-flight poll and prevents late dialog or navigation work', async () => {
        const apiClient = createApiClient();
        const poll = createDeferred();
        validInitiate(apiClient);
        fetch.mockImplementation(() => poll.promise);
        mocks.getOrCreateApiClient.mockReturnValue(apiClient);
        const harness = createViewHarness();
        createLoginController(harness.view, { serverid: 'server-1' });

        expect(harness.element('.btnQuick').listeners.get('click')()).toBe(false);
        await flushPromises();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fetch).toHaveBeenCalledOnce();

        harness.viewListeners.get('viewhide')();
        poll.resolve(pollingResponse({ Authenticated: true, Secret: RAW_MARKER }));
        await flushPromises();
        await vi.advanceTimersByTimeAsync(20_000);

        expect(mocks.publishLoginAuthentication).not.toHaveBeenCalled();
        expect(mocks.closeDialog).toHaveBeenCalledOnce();
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.dashboardAlert).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expectNoConsoleCalls();
    });

    it('does not open a dialog after viewhide while router readiness is pending', async () => {
        const apiClient = createApiClient();
        const readiness = createDeferred();
        validInitiate(apiClient);
        mocks.routerReady.mockReturnValue(readiness.promise);
        mocks.getOrCreateApiClient.mockReturnValue(apiClient);
        const harness = createViewHarness();
        createLoginController(harness.view, { serverid: 'server-1' });

        harness.element('.btnQuick').listeners.get('click')();
        await flushPromises();
        harness.viewListeners.get('viewhide')();
        readiness.resolve();
        await flushPromises();

        expect(mocks.dialogShow).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expectNoConsoleCalls();
    });

    it('does not let a replaced session open after its router readiness resolves', async () => {
        const apiClient = createApiClient();
        const firstReadiness = createDeferred();
        validInitiate(apiClient);
        mocks.routerReady
            .mockImplementationOnce(() => firstReadiness.promise)
            .mockImplementation(() => Promise.resolve());
        mocks.getOrCreateApiClient.mockReturnValue(apiClient);
        const harness = createViewHarness();
        createLoginController(harness.view, { serverid: 'server-1' });

        harness.element('.btnQuick').listeners.get('click')();
        await flushPromises();
        harness.element('.btnQuick').listeners.get('click')();
        await flushPromises();
        expect(mocks.dialogShow).toHaveBeenCalledOnce();

        firstReadiness.resolve();
        await flushPromises();
        expect(mocks.dialogShow).toHaveBeenCalledOnce();
        harness.viewListeners.get('viewhide')();
        await flushPromises();
        expect(vi.getTimerCount()).toBe(0);
        expectNoConsoleCalls();
    });

    it('does not open a dialog after switching to server selection', async () => {
        const apiClient = createApiClient();
        const readiness = createDeferred();
        validInitiate(apiClient);
        mocks.routerReady.mockReturnValue(readiness.promise);
        mocks.getOrCreateApiClient.mockReturnValue(apiClient);
        const harness = createViewHarness();
        createLoginController(harness.view, { serverid: 'server-1' });

        harness.element('.btnQuick').listeners.get('click')();
        await flushPromises();
        harness.element('.btnSelectServer').listeners.get('click')();
        readiness.resolve();
        await flushPromises();

        expect(mocks.dialogShow).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expectNoConsoleCalls();
    });

    it('closes only the replaced session dialog and ignores its late rejection', async () => {
        const apiClient = createApiClient();
        validInitiate(apiClient);
        const first = authenticateQuickConnect(apiClient, '/home');
        await expect(first.started).resolves.toBe(true);
        first.cancel();
        const second = authenticateQuickConnect(apiClient, '/home');
        await expect(second.started).resolves.toBe(true);
        await flushPromises();

        expect(dialogs).toHaveLength(2);
        expect(dialogs[0].element.id).not.toBe(dialogs[1].element.id);
        expect(mocks.closeDialog).toHaveBeenCalledWith(dialogs[0].element);
        expect(document.getElementById(dialogs[1].element.id)).toBe(dialogs[1].element);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fetch).toHaveBeenCalledOnce();

        second.cancel();
        await flushPromises();
        expect(vi.getTimerCount()).toBe(0);
        expectNoConsoleCalls();
    });

    it('stops polling as soon as the user closes the dialog', async () => {
        const apiClient = createApiClient();
        validInitiate(apiClient);
        const session = authenticateQuickConnect(apiClient, '/home');
        await expect(session.started).resolves.toBe(true);

        dialogs[0].element.dispatchEvent(new Event('closing'));
        dialogs[0].result.reject(createSensitiveFailure());
        await flushPromises();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(fetch).not.toHaveBeenCalled();
        expect(mocks.closeDialog).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expectNoConsoleCalls();
    });

    it('owns an early dialog rejection and contains sensitive failure data', async () => {
        const apiClient = createApiClient();
        validInitiate(apiClient);
        const session = authenticateQuickConnect(apiClient, '/home');
        await expect(session.started).resolves.toBe(true);

        dialogs[0].result.reject(createSensitiveFailure());
        await flushPromises();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(mocks.closeDialog).toHaveBeenCalledWith(dialogs[0].element);
        expect(fetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expectNoConsoleCalls();
    });

    it('contains an invalid target URL without logging its pairing data', async () => {
        const apiClient = createApiClient();
        validInitiate(apiClient);
        mocks.getOrCreateApiClient.mockReturnValue(apiClient);
        const harness = createViewHarness();
        createLoginController(harness.view, {
            serverid: 'server-1',
            url: `%${ENCODED_MARKER}`
        });

        harness.element('.btnQuick').listeners.get('click')();
        await flushPromises();

        expect(consoleSpies.warn.mock.calls).toEqual([
            [ '[LoginPage][navigation]', 'target-url-invalid' ]
        ]);
        expectNoSensitiveConsoleValues();
        harness.viewListeners.get('viewhide')();
        await flushPromises();
    });
});

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectionRequired from 'components/ConnectionRequired';

import Search from './search';

vi.mock('lib/jellyfin-apiclient', () => ({
    ConnectionState: {
        ServerMismatch: 'ServerMismatch',
        ServerUpdateNeeded: 'ServerUpdateNeeded',
        Unavailable: 'Unavailable'
    },
    ServerConnections: {
        currentApiClient: () => ({ isLoggedIn: () => true, serverId: () => 'server-1' }),
        firstConnection: true
    }
}));
const presentation = vi.hoisted(() => ({
    current: true,
    layout: { tv: false },
    resolveRoute: (_client: unknown, route: string): Promise<string> => Promise.resolve(route),
    version: 0,
    listeners: new Set<() => void>()
}));

vi.mock('lib/profileSelector/navigation', () => ({
    resolveProfileSelectorRoute: (client: unknown, route: string) => presentation.resolveRoute(client, route)
}));
vi.mock('lib/profileSelector/sessionSwitch/application', () => {
    const application = {
        prepareProtectedRoute: () => Promise.resolve({}),
        captureVerifiedRoutePresentation: () => presentation.current ?
            { isCurrent: () => presentation.current } : null,
        subscribeRoutePresentation: (_serverId: string, listener: () => void) => {
            presentation.listeners.add(listener);
            return () => presentation.listeners.delete(listener);
        },
        readRoutePresentationVersion: () => presentation.version
    };
    return { getWebSessionSwitchApplication: () => application };
});
vi.mock('components/ConnectionErrorPage', () => ({ default: () => <div>Connection unavailable</div> }));
vi.mock('components/loading/LoadingComponent', () => ({ default: () => <div>Loading</div> }));
vi.mock('components/Page', () => ({
    default: ({ children, id }: { children: React.ReactNode; id: string }) => <div id={id}>{children}</div>
}));
vi.mock('components/alphaPicker/AlphaPickerComponent', () => {
    function MockAlphaPicker({ onAlphaPicked }: Readonly<{ onAlphaPicked: (event: Event) => void }>) {
        function append() {
            onAlphaPicked(new CustomEvent('picked', { detail: { value: 'X' } }));
        }
        function backspace() {
            onAlphaPicked(new CustomEvent('picked', { detail: { value: 'backspace' } }));
        }
        return React.createElement(React.Fragment, null,
            React.createElement('button', { id: 'alphaAppend', onClick: append }, 'X'),
            React.createElement('button', { id: 'alphaBackspace', onClick: backspace }, 'Backspace'));
    }
    return { default: MockAlphaPicker };
});
vi.mock('components/layoutManager', () => ({ default: presentation.layout }));
vi.mock('scripts/browser', () => ({ default: { tv: false } }));
vi.mock('lib/globalize', () => ({ default: { translate: (key: string) => key } }));
vi.mock('apps/stable/features/search/api/useSearchDiscovery', () => ({
    useRecordSearchHistory: () => ({ mutate: vi.fn(), isReady: false })
}));
vi.mock('apps/stable/features/search/components/SearchResults', () => ({ default: () => null }));
vi.mock('apps/stable/features/search/components/SearchSuggestions', () => {
    function MockSuggestions({ onSearch }: Readonly<{ onSearch: (query: string) => void }>) {
        function choose() {
            onSearch('Family');
        }
        return React.createElement('button', { id: 'suggestedSearch', onClick: choose }, 'Family');
    }
    return { default: MockSuggestions };
});

let navigate: NavigateFunction;

function LocationProbe() {
    navigate = useNavigate();
    const location = useLocation();
    return <output id='routeSearch'>{location.search}</output>;
}

describe('Search typing through the protected route', () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(async () => {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        presentation.current = true;
        presentation.layout.tv = false;
        presentation.version = 0;
        presentation.listeners.clear();
        presentation.resolveRoute = (_client, route) => Promise.resolve(route);
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        await act(async () => root.render(
            <MemoryRouter initialEntries={[ '/search' ]}>
                <LocationProbe />
                <Routes>
                    <Route element={<ConnectionRequired />}>
                        <Route path='/search' element={<Search />} />
                        <Route path='/detail' element={<div>Detail page</div>} />
                    </Route>
                </Routes>
            </MemoryRouter>
        ));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    });

    it('keeps the input mounted and focused while every character updates the query', async () => {
        await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('#searchTextInput')).not.toBeNull());
        const input = container.querySelector<HTMLInputElement>('#searchTextInput')!;
        input.focus();

        for (const value of [ 'L', 'Lo', 'Loc', 'Loca', 'Local' ]) {
            await act(async () => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                setter?.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });

            expect(container.querySelector('#searchTextInput')).toBe(input);
            expect(document.activeElement).toBe(input);
            expect(input.value).toBe(value);
            expect(container.querySelector('#routeSearch')?.textContent).toBe(`?query=${value}`);
        }

        await new Promise(resolve => setTimeout(resolve, 30));
        expect(container.querySelector('#searchTextInput')).toBe(input);
        expect(document.activeElement).toBe(input);
    });

    it('reuses verified authority for a query-only change without a second selector reconciliation', async () => {
        await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('#searchTextInput')).not.toBeNull());
        const input = container.querySelector<HTMLInputElement>('#searchTextInput')!;
        const resolveRoute = vi.fn((_client: unknown, route: string) => Promise.resolve(route));
        presentation.resolveRoute = resolveRoute;

        await act(async () => navigate('/search?query=Family'));
        expect(container.querySelector('#searchTextInput')).toBe(input);
        expect(input.value).toBe('Family');
        expect(resolveRoute).not.toHaveBeenCalled();
    });

    it('closes Search for another parameter and on synchronous authority revocation', async () => {
        await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('#searchTextInput')).not.toBeNull());
        let finish!: (route: string) => void;
        presentation.resolveRoute = () => new Promise(resolve => {
            finish = resolve;
        });

        await act(async () => navigate('/search?query=Family&genre=Horror'));
        expect(container.querySelector('#searchTextInput')).toBeNull();
        expect(container.textContent).toContain('Loading');
        await act(async () => finish('/search?query=Family&genre=Horror'));

        await act(async () => {
            presentation.current = false;
            presentation.version += 1;
            presentation.listeners.forEach(listener => {
                listener();
            });
        });
        expect(container.querySelector('#searchTextInput')).toBeNull();
        expect(container.textContent).toContain('Loading');
    });

    it('keeps a fresh Search entry closed when application readiness is missing', async () => {
        await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('#searchTextInput')).not.toBeNull());
        await act(async () => navigate('/detail'));
        presentation.current = false;

        await act(async () => navigate('/search?query=Private'));
        expect(container.querySelector('#searchTextInput')).toBeNull();
        expect(container.textContent).toContain('Connection unavailable');
    });

    it('restores the URL after clearing, a suggestion and Back/Forward navigation', async () => {
        await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('#searchTextInput')).not.toBeNull());
        const input = container.querySelector<HTMLInputElement>('#searchTextInput')!;

        await act(async () => container.querySelector<HTMLButtonElement>('#suggestedSearch')?.click());
        expect(input.value).toBe('Family');
        expect(container.querySelector('#routeSearch')?.textContent).toBe('?query=Family');

        await act(async () => container.querySelector<HTMLButtonElement>('.search-input__clear')?.click());
        expect(container.querySelector('#searchTextInput')).toBe(input);
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('');
        expect(container.querySelector('#routeSearch')?.textContent).toBe('');

        await act(async () => navigate('/search?query=Restored'));
        expect(input.value).toBe('Restored');
        await act(async () => navigate('/detail'));
        expect(container.textContent).toContain('Detail page');
        await act(async () => navigate(-1));
        expect(container.querySelector<HTMLInputElement>('#searchTextInput')?.value).toBe('Restored');
        expect(container.querySelector('#routeSearch')?.textContent).toBe('?query=Restored');
        await act(async () => navigate(1));
        expect(container.textContent).toContain('Detail page');
    });

    it('applies TV AlphaPicker append and backspace without remounting the field', async () => {
        await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('#searchTextInput')).not.toBeNull());
        presentation.layout.tv = true;
        await act(async () => navigate('/search?query=A'));
        const input = container.querySelector<HTMLInputElement>('#searchTextInput')!;

        await act(async () => container.querySelector<HTMLButtonElement>('#alphaAppend')?.click());
        expect(container.querySelector('#searchTextInput')).toBe(input);
        expect(input.value).toBe('AX');
        expect(container.querySelector('#routeSearch')?.textContent).toBe('?query=AX');

        await act(async () => container.querySelector<HTMLButtonElement>('#alphaBackspace')?.click());
        expect(container.querySelector('#searchTextInput')).toBe(input);
        expect(input.value).toBe('A');
        expect(container.querySelector('#routeSearch')?.textContent).toBe('?query=A');
    });
});

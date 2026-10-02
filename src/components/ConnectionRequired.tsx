import React, { FunctionComponent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { ApiClient, ConnectResponse } from 'jellyfin-apiclient';

import { ConnectionState, ServerConnections } from 'lib/jellyfin-apiclient';
import { resolveProfileSelectorRoute } from 'lib/profileSelector/navigation';
import { getWebSessionSwitchApplication, type RoutePresentationGrant } from 'lib/profileSelector/sessionSwitch/application';
import { PROFILE_SELECTOR_PATH } from 'lib/profileSelector/utils';

import ConnectionErrorPage from './ConnectionErrorPage';
import {
    RouteValidationAuthority,
    createConnectionRouteKey,
    isAuthorizedRoute,
    isSearchQueryPresentationTransition
} from './connectionRequiredRouteAuthority';
import Loading from './loading/LoadingComponent';

enum AccessLevel {
    /** Requires a user with administrator access */
    Admin = 'admin',
    /** No access restrictions */
    Public = 'public',
    /** Requires a valid user session */
    User = 'user',
    /** Requires the startup wizard to NOT be completed */
    Wizard = 'wizard'
};

type AccessLevelValue = `${AccessLevel}`;

enum BounceRoutes {
    Home = '/home',
    Login = '/login',
    SelectServer = '/selectserver',
    StartWizard = '/wizard/start'
}

type ConnectionRequiredProps = {
    level?: AccessLevelValue
};

const ERROR_STATES = [
    ConnectionState.ServerMismatch,
    ConnectionState.ServerUpdateNeeded,
    ConnectionState.Unavailable
];

const fetchPublicSystemInfo = async (apiClient: ApiClient) => {
    const infoResponse = await fetch(
        `${apiClient.serverAddress()}/System/Info/Public`,
        { cache: 'no-cache' }
    );

    if (!infoResponse.ok) {
        throw new Error('Public system info request failed');
    }

    return infoResponse.json();
};

const normalizedConnectionAddress = (address: unknown): string | null => {
    if (typeof address !== 'string') return null;
    try {
        const url = new URL(address);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            return null;
        }
        let basePath = url.pathname;
        while (basePath.length > 1 && basePath.endsWith('/')) {
            basePath = basePath.slice(0, -1);
        }
        return `${url.origin}${basePath}`;
    } catch {
        return null;
    }
};

const responseConfirmsAddress = (response: ConnectResponse, serverId: string, address: string): boolean => {
    const responseServer = response.Servers?.find(server => server?.Id === serverId);
    return [
        responseServer?.ManualAddress,
        responseServer?.LocalAddress,
        responseServer?.RemoteAddress
    ].some(candidate => normalizedConnectionAddress(candidate) === address);
};

const hasNewerClient = (
    currentClient: ApiClient | undefined,
    initialClient: ApiClient | undefined,
    confirmedClient: ApiClient
): boolean => Boolean(currentClient?.isLoggedIn())
    || (currentClient !== initialClient && currentClient !== confirmedClient);

const validateAdministrator = async (
    apiClient: ApiClient | undefined,
    isCurrent: () => boolean,
    onUnauthorized: () => Promise<void>
): Promise<boolean> => {
    const user = await apiClient?.getCurrentUser();
    if (!isCurrent()) return false;
    if (user?.Policy?.IsAdministrator) return true;

    await onUnauthorized();
    return false;
};

type RouteValidationState =
    | { readonly status: 'validating'; readonly routeKey: string }
    | { readonly status: 'authorized'; readonly routeKey: string; readonly presentationGrant?: RoutePresentationGrant }
    | { readonly status: 'error'; readonly routeKey: string; readonly connectionState: ConnectionState };

/**
 * A component that ensures a server connection has been established.
 * Additional parameters exist to verify a user or admin have authenticated.
 * If a condition fails, this component will navigate to the appropriate page.
 */
const ConnectionRequired: FunctionComponent<ConnectionRequiredProps> = ({
    level = 'user'
}) => {
    const navigate = useNavigate();
    const location = useLocation();
    const routeKey = createConnectionRouteKey(
        level,
        location.key,
        location.pathname,
        location.search
    );
    const isSearchRoute = level === AccessLevel.User && location.pathname === '/search';
    const presentationApplication = isSearchRoute ? getWebSessionSwitchApplication(ServerConnections) : null;
    const presentationServerId = isSearchRoute ? ServerConnections.currentApiClient()?.serverId() : undefined;
    const subscribePresentation = useCallback((listener: () => void) =>
        presentationApplication && presentationServerId ?
            presentationApplication.subscribeRoutePresentation(presentationServerId, listener) :
            () => undefined, [ presentationApplication, presentationServerId ]);
    const presentationVersion = useCallback(() =>
        presentationApplication && presentationServerId ?
            presentationApplication.readRoutePresentationVersion(presentationServerId) :
            0, [ presentationApplication, presentationServerId ]);
    useSyncExternalStore(subscribePresentation, presentationVersion, () => 0);
    const routeAuthority = useRef(new RouteValidationAuthority());
    routeAuthority.current.observe(routeKey);
    const [ validation, setValidation ] = useState<RouteValidationState>({
        status: 'validating',
        routeKey
    });
    const authorizedPresentation = validation.status === 'authorized' ? validation.presentationGrant : undefined;
    const searchPresentationContinues = isSearchRoute
        && isSearchQueryPresentationTransition(validation.routeKey, routeKey)
        && authorizedPresentation?.isCurrent() === true;
    const reusablePresentation = useRef<RoutePresentationGrant | null>(null);
    reusablePresentation.current = searchPresentationContinues ? authorizedPresentation ?? null : null;

    useEffect(() => {
        const authority = routeAuthority.current;
        const ticket = authority.begin(routeKey);
        const isCurrent = () => authority.isCurrent(ticket);
        const reusableGrant = reusablePresentation.current;
        if (reusableGrant?.isCurrent()) {
            setValidation({ status: 'authorized', routeKey, presentationGrant: reusableGrant });
            return () => authority.invalidate(ticket);
        }
        const authorize = (presentationGrant?: RoutePresentationGrant) => {
            if (!isCurrent()) return;
            if (level === AccessLevel.User && location.pathname === '/search'
                && !presentationGrant?.isCurrent()) {
                setValidation({ status: 'error', routeKey, connectionState: ConnectionState.Unavailable });
                return;
            }
            setValidation({ status: 'authorized', routeKey, presentationGrant });
        };
        const navigateCurrent = (target: string) => {
            if (isCurrent()) navigate(target);
        };
        const selectConfirmedFirstClient = (response: ConnectResponse, initialClient: ApiClient | undefined) => {
            const currentClient = ServerConnections.currentApiClient();
            if (!isCurrent() || hasNewerClient(currentClient, initialClient, response.ApiClient)) return 'superseded';

            const confirmedClient = response.ApiClient;
            const serverId = confirmedClient?.serverId();
            const address = normalizedConnectionAddress(confirmedClient?.serverAddress());
            if (!serverId || !address || !responseConfirmsAddress(response, serverId, address)
                || ServerConnections.getApiClient(serverId) !== confirmedClient
                || (initialClient?.serverId() && initialClient !== confirmedClient)) return 'invalid';

            if (currentClient !== confirmedClient) ServerConnections.setLocalApiClient(confirmedClient);
            return 'confirmed';
        };
        const showServerSignIn = (response: ConnectResponse, initialClient?: ApiClient) => {
            if (initialClient) {
                const selection = selectConfirmedFirstClient(response, initialClient);
                if (selection === 'superseded') return;
                if (selection === 'invalid') {
                    setValidation({ status: 'error', routeKey, connectionState: ConnectionState.ServerMismatch });
                    return;
                }
            }
            if (location.pathname === BounceRoutes.Login) {
                authorize();
            } else {
                const url = encodeURIComponent(location.pathname + location.search);
                navigateCurrent(`${BounceRoutes.Login}?serverid=${response.ApiClient.serverId()}&url=${url}`);
            }
        };
        const bounce = async (connectionResponse: ConnectResponse, initialClient?: ApiClient) => {
            if (!isCurrent()) return;
            switch (connectionResponse.State) {
                case ConnectionState.SignedIn:
                    navigateCurrent(BounceRoutes.Home);
                    return;
                case ConnectionState.ServerSignIn:
                    showServerSignIn(connectionResponse, initialClient);
                    return;
                case ConnectionState.ServerSelection:
                    if (location.pathname === BounceRoutes.SelectServer) authorize();
                    else navigateCurrent(BounceRoutes.SelectServer);
                    return;
            }
        };
        const validateWizard = async (firstConnection: ConnectResponse | null) => {
            const apiClient = firstConnection?.ApiClient || ServerConnections.currentApiClient();
            if (!apiClient) throw new Error('No ApiClient available');

            const systemInfo = await fetchPublicSystemInfo(apiClient);
            if (!isCurrent()) return;
            if (systemInfo?.StartupWizardCompleted) {
                navigateCurrent(BounceRoutes.Home);
                return;
            }

            ServerConnections.setLocalApiClient(apiClient);
            authorize();
        };
        const handleIncompleteWizard = async (firstConnection: ConnectResponse, initialClient: ApiClient | undefined) => {
            if (firstConnection.State === ConnectionState.ServerSignIn) {
                const systemInfo = await fetchPublicSystemInfo(firstConnection.ApiClient);
                if (!isCurrent()) return;
                if (!systemInfo?.StartupWizardCompleted) {
                    ServerConnections.setLocalApiClient(firstConnection.ApiClient);
                    navigateCurrent(BounceRoutes.StartWizard);
                    return;
                }
            }
            await bounce(firstConnection, initialClient);
        };
        const validateProtectedSession = async (client: ApiClient | undefined) => {
            const needsDirectBootstrap = level === AccessLevel.Admin
                || (level === AccessLevel.User && location.pathname === PROFILE_SELECTOR_PATH);
            if (!needsDirectBootstrap || !client) return true;

            await getWebSessionSwitchApplication(ServerConnections).prepareProtectedRoute(client);
            return isCurrent();
        };
        const resolveUserRoute = async (client: ApiClient | undefined): Promise<boolean> => {
            if (level !== AccessLevel.User || location.pathname === PROFILE_SELECTOR_PATH) return true;
            if (!client) throw new Error('No ApiClient available');
            const currentPath = location.pathname + location.search;
            const targetRoute = await resolveProfileSelectorRoute(client, currentPath);
            if (!isCurrent()) return false;
            if (targetRoute === currentPath) return true;
            navigateCurrent(targetRoute);
            return false;
        };
        const authorizeUserRoute = async (client: ApiClient | undefined) => {
            if (level !== AccessLevel.User || location.pathname !== '/search') {
                authorize();
                return;
            }
            if (!client) throw new Error('No ApiClient available');
            const application = getWebSessionSwitchApplication(ServerConnections);
            let grant = application.captureVerifiedRoutePresentation(client);
            if (!grant) {
                await application.prepareProtectedRoute(client);
                if (!isCurrent()) return;
                grant = application.captureVerifiedRoutePresentation(client);
            }
            authorize(grant ?? undefined);
        };
        const validateUserAccess = async () => {
            const client = ServerConnections.currentApiClient();
            const protectedRoute = level === AccessLevel.Admin || level === AccessLevel.User;
            if (protectedRoute && !client?.isLoggedIn()) {
                await bounce(await ServerConnections.connect());
                return;
            }
            if (!await validateProtectedSession(client) || !isCurrent()) return;

            if (level === AccessLevel.Admin && !await validateAdministrator(
                client,
                isCurrent,
                async () => bounce(await ServerConnections.connect())
            )) return;

            if (!await resolveUserRoute(client) || !isCurrent()) return;
            await authorizeUserRoute(client);
        };
        const run = async () => {
            if (isCurrent()) setValidation({ status: 'validating', routeKey });
            const initialApiClient = ServerConnections.currentApiClient();
            const firstConnection = ServerConnections.firstConnection ?
                null :
                await ServerConnections.connect();
            if (!isCurrent()) return;
            ServerConnections.firstConnection = true;

            if (firstConnection && ERROR_STATES.includes(firstConnection.State)) {
                setValidation({
                    status: 'error',
                    routeKey,
                    connectionState: firstConnection.State
                });
            } else if (level === AccessLevel.Wizard) {
                await validateWizard(firstConnection);
            } else if (firstConnection
                && firstConnection.State !== ConnectionState.SignedIn
                && !initialApiClient?.isLoggedIn()) {
                await handleIncompleteWizard(firstConnection, initialApiClient);
            } else {
                await validateUserAccess();
            }
        };

        void run().catch(() => {
            if (isCurrent()) {
                setValidation(level === AccessLevel.User && location.pathname === '/search' ?
                    { status: 'error', routeKey, connectionState: ConnectionState.Unavailable } :
                    { status: 'validating', routeKey });
                console.error('[ConnectionRequired] route validation failed');
            }
        });
        return () => {
            authority.invalidate(ticket);
        };
    }, [ level, location.pathname, location.search, navigate, routeKey ]);

    if (validation.routeKey === routeKey && validation.status === 'error') {
        return <ConnectionErrorPage state={validation.connectionState} />;
    }

    const authorizedRouteKey = validation.status === 'authorized' ? validation.routeKey : null;
    const grantCurrent = !isSearchRoute || authorizedPresentation?.isCurrent() === true;
    if ((!isAuthorizedRoute(routeKey, authorizedRouteKey) && !searchPresentationContinues)
        || !grantCurrent) {
        return <Loading />;
    }

    return <Outlet />;
};

export default ConnectionRequired;

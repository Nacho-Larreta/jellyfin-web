import React, { FunctionComponent, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { ApiClient, ConnectResponse } from 'jellyfin-apiclient';

import { ConnectionState, ServerConnections } from 'lib/jellyfin-apiclient';
import { resolveProfileSelectorRoute } from 'lib/profileSelector/navigation';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import { PROFILE_SELECTOR_PATH } from 'lib/profileSelector/utils';

import ConnectionErrorPage from './ConnectionErrorPage';
import {
    RouteValidationAuthority,
    createConnectionRouteKey,
    isAuthorizedRoute
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
    | { readonly status: 'authorized'; readonly routeKey: string }
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
    const routeAuthority = useRef(new RouteValidationAuthority());
    routeAuthority.current.observe(routeKey);
    const [ validation, setValidation ] = useState<RouteValidationState>({
        status: 'validating',
        routeKey
    });

    useEffect(() => {
        const authority = routeAuthority.current;
        const ticket = authority.begin(routeKey);
        const isCurrent = () => authority.isCurrent(ticket);
        const authorize = () => {
            if (isCurrent()) setValidation({ status: 'authorized', routeKey });
        };
        const navigateCurrent = (target: string) => {
            if (isCurrent()) navigate(target);
        };
        const bounce = async (connectionResponse: ConnectResponse) => {
            if (!isCurrent()) return;
            switch (connectionResponse.State) {
                case ConnectionState.SignedIn:
                    navigateCurrent(BounceRoutes.Home);
                    return;
                case ConnectionState.ServerSignIn:
                    if (location.pathname === BounceRoutes.Login) {
                        authorize();
                    } else {
                        const url = encodeURIComponent(location.pathname + location.search);
                        navigateCurrent(`${BounceRoutes.Login}?serverid=${connectionResponse.ApiClient.serverId()}&url=${url}`);
                    }
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
        const handleIncompleteWizard = async (firstConnection: ConnectResponse) => {
            if (firstConnection.State === ConnectionState.ServerSignIn) {
                const systemInfo = await fetchPublicSystemInfo(firstConnection.ApiClient);
                if (!isCurrent()) return;
                if (!systemInfo?.StartupWizardCompleted) {
                    ServerConnections.setLocalApiClient(firstConnection.ApiClient);
                    navigateCurrent(BounceRoutes.StartWizard);
                    return;
                }
            }
            await bounce(firstConnection);
        };
        const validateProtectedSession = async (client: ApiClient | undefined) => {
            const needsDirectBootstrap = level === AccessLevel.Admin
                || (level === AccessLevel.User && location.pathname === PROFILE_SELECTOR_PATH);
            if (!needsDirectBootstrap || !client) return true;

            await getWebSessionSwitchApplication(ServerConnections).prepareProtectedRoute(client);
            return isCurrent();
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

            if (level === AccessLevel.User && location.pathname !== PROFILE_SELECTOR_PATH) {
                if (!client) throw new Error('No ApiClient available');
                const currentPath = location.pathname + location.search;
                const targetRoute = await resolveProfileSelectorRoute(client, currentPath);
                if (!isCurrent()) return;
                if (targetRoute !== currentPath) {
                    navigateCurrent(targetRoute);
                    return;
                }
            }
            authorize();
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
                await handleIncompleteWizard(firstConnection);
            } else {
                await validateUserAccess();
            }
        };

        void run().catch(() => {
            if (isCurrent()) {
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
    if (!isAuthorizedRoute(routeKey, authorizedRouteKey)) {
        return <Loading />;
    }

    return <Outlet />;
};

export default ConnectionRequired;

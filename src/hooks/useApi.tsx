import type { Api } from '@jellyfin/sdk';
import type { UserDto } from '@jellyfin/sdk/lib/generated-client';
import type { ApiClient, Event } from 'jellyfin-apiclient';
import React, { type FC, type PropsWithChildren, createContext, useCallback, useContext, useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';

import ConnectionErrorPage from 'components/ConnectionErrorPage';
import Loading from 'components/loading/LoadingComponent';
import viewContainer from 'components/viewContainer';
import { ConnectionState, ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import type { BoundSessionReadIdentity, FreshSessionAuthority } from 'lib/profileSelector/sessionSwitch/boundRequests';
import type { SessionSwitchCompletionReceipt } from 'lib/profileSelector/sessionSwitch/model';
import {
    capturePendingOldAuthority,
    matchesCompletion,
    samePublication,
    sameRestoredSession,
    verifiedAuthority,
    type PublishedAuthority
} from 'lib/profileSelector/sessionSwitch/publicationAuthority';
import events from 'utils/events';
import { toApi } from 'utils/jellyfin-apiclient/compat';
import { createSessionScopedReadApi, type SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { type BoundUserViewsRead } from 'utils/jellyfin-apiclient/boundUserViewsQuery';
import { queryClient } from 'utils/query/queryClient';

export interface JellyfinApiContext {
    __legacyApiClient__?: ApiClient
    api?: Api
    sessionScopedReadApi?: SessionScopedReadApi
    sessionScopedUserViewsReadApi?: BoundUserViewsRead
    sessionQueryIdentity?: BoundSessionReadIdentity
    user?: UserDto
}

export const ApiContext = createContext<JellyfinApiContext>({});
export const useApi = () => useContext(ApiContext);

const COMPLETION_WAIT_MS = 10_000;
const SERVER_SELECTION_ROUTE = '#/selectserver';

function reloadCurrentPage() {
    window.location.reload();
}

function createPublishedContext(client: ApiClient, user: UserDto, serverId: string): JellyfinApiContext {
    const port = getWebSessionSwitchApplication(ServerConnections).captureBoundSessionRead(client);
    const sessionScopedReadApi = port ? createSessionScopedReadApi(client, port) : undefined;
    return {
        __legacyApiClient__: client,
        api: toApi(client),
        sessionScopedReadApi,
        sessionScopedUserViewsReadApi: sessionScopedReadApi,
        sessionQueryIdentity: sessionScopedReadApi?.identity,
        user: { ...user, ServerId: serverId }
    };
}

interface ApiProviderProps {
    reloadPage?: () => void;
}

export const ApiProvider: FC<PropsWithChildren<ApiProviderProps>> = ({
    children,
    reloadPage = reloadCurrentPage
}) => {
    const [ context, setContext ] = useState<JellyfinApiContext>({});
    const [ availability, setAvailability ] = useState<'ready' | 'pending' | 'unavailable'>('ready');
    const onSelectServer = useCallback(() => {
        window.location.hash = SERVER_SELECTION_ROUTE;
        reloadPage();
    }, [ reloadPage ]);

    useLayoutEffect(() => {
        let generation = 0;
        let mounted = true;
        let publishedAuthority: PublishedAuthority | null = null;
        let closedAuthority: PublishedAuthority | null = null;
        let coldOldAuthority: PublishedAuthority | null = null;
        let restoreAllowed = false;
        let observedSwitchId: string | null = null;
        let observedServerId: string | null = null;
        let unsubscribeEnvelope: (() => void) | undefined;
        let completionTimeout: number | undefined;
        let resolvingGeneration: number | null = null;

        const clearCompletionTimeout = () => {
            window.clearTimeout(completionTimeout);
            completionTimeout = undefined;
        };

        const showUnavailable = (expectedGeneration: number) => {
            if (!mounted || generation !== expectedGeneration) return;
            generation++;
            resolvingGeneration = null;
            clearCompletionTimeout();
            unsubscribeEnvelope?.();
            unsubscribeEnvelope = undefined;
            setAvailability('unavailable');
        };

        const readAuthority = (serverId: string): FreshSessionAuthority | null => {
            try {
                return ServerConnections.readFreshSessionAuthority(serverId);
            } catch {
                return null;
            }
        };

        const currentAuthority = (serverId: string, fresh: FreshSessionAuthority | null) => {
            const client = ServerConnections.currentApiClient();
            return client && verifiedAuthority(
                client,
                fresh,
                client,
                ServerConnections.getApiClient(serverId)
            );
        };

        const closePublished = (fresh: FreshSessionAuthority | null) => {
            if (!publishedAuthority) return;
            closedAuthority = publishedAuthority;
            publishedAuthority = null;
            restoreAllowed = !!fresh?.envelope?.marker;
            observedSwitchId = fresh?.envelope?.marker?.switchId || observedSwitchId;
            generation++;
            resolvingGeneration = null;
            clearCompletionTimeout();
            const expectedGeneration = generation;
            flushSync(() => {
                setContext({});
                setAvailability('pending');
            });
            void queryClient.cancelQueries();
            queryClient.clear();
            viewContainer.reset();
            completionTimeout = window.setTimeout(() => showUnavailable(expectedGeneration), COMPLETION_WAIT_MS);
        };

        const probeAndPublish = async (
            candidate: PublishedAuthority,
            mode: 'initial' | 'target' | 'restored',
            expectedGeneration: number
        ) => {
            try {
                const user = await candidate.client.getCurrentUser();
                if (!mounted || generation !== expectedGeneration) return;
                const fresh = readAuthority(candidate.serverId);
                const latest = currentAuthority(candidate.serverId, fresh);
                const restoredAuthority = closedAuthority || coldOldAuthority;
                if (!latest || !samePublication(candidate, latest)
                    || user?.Id !== candidate.userId
                    || user.ServerId && user.ServerId !== candidate.serverId
                    || mode === 'target' && (!fresh || !observedSwitchId
                        || !matchesCompletion(fresh, observedSwitchId, latest))
                    || mode === 'restored' && (!restoredAuthority
                        || !sameRestoredSession(restoredAuthority, latest))) {
                    showUnavailable(expectedGeneration);
                    return;
                }

                const published = createPublishedContext(candidate.client, user, candidate.serverId);
                const finalAuthority = currentAuthority(candidate.serverId, readAuthority(candidate.serverId));
                if (!mounted || generation !== expectedGeneration
                    || !finalAuthority || !samePublication(candidate, finalAuthority)) {
                    if (generation === expectedGeneration) {
                        generation++;
                        resolvingGeneration = null;
                    }
                    inspectAuthority();
                    return;
                }
                publishedAuthority = latest;
                closedAuthority = null;
                coldOldAuthority = null;
                restoreAllowed = false;
                observedSwitchId = null;
                resolvingGeneration = null;
                clearCompletionTimeout();
                generation++;
                setContext(published);
                setAvailability('ready');
            } catch {
                showUnavailable(expectedGeneration);
            }
        };

        const publicationMode = (
            fresh: FreshSessionAuthority,
            latest: PublishedAuthority
        ): 'initial' | 'target' | 'restored' | null => {
            if (closedAuthority) {
                if (restoreAllowed && sameRestoredSession(closedAuthority, latest)) return 'restored';
                if (observedSwitchId && matchesCompletion(fresh, observedSwitchId, latest)) return 'target';
                return null;
            }
            if (coldOldAuthority && sameRestoredSession(coldOldAuthority, latest)) return 'restored';
            if (observedSwitchId) {
                return matchesCompletion(fresh, observedSwitchId, latest) ? 'target' : null;
            }
            return 'initial';
        };

        const observePendingMarker = (fresh: FreshSessionAuthority, serverId: string) => {
            const switchId = fresh.envelope?.marker?.switchId;
            if (!switchId) return;
            if (!closedAuthority && observedSwitchId !== switchId) {
                const client = ServerConnections.currentApiClient();
                coldOldAuthority = client ? capturePendingOldAuthority(
                    client,
                    fresh,
                    ServerConnections.getApiClient(serverId)
                ) : null;
            }
            if (resolvingGeneration === generation || observedSwitchId !== switchId) {
                generation++;
                resolvingGeneration = null;
                if (closedAuthority) {
                    clearCompletionTimeout();
                    const expectedGeneration = generation;
                    completionTimeout = window.setTimeout(
                        () => showUnavailable(expectedGeneration),
                        COMPLETION_WAIT_MS
                    );
                }
            }
            observedSwitchId = switchId;
        };

        const inspectAuthority = () => {
            if (!mounted || !observedServerId) return;
            const fresh = readAuthority(observedServerId);
            const latest = currentAuthority(observedServerId, fresh);
            if (publishedAuthority && (!latest || !samePublication(publishedAuthority, latest))) {
                closePublished(fresh);
            }
            if (publishedAuthority || !fresh) return;
            if (fresh.envelope?.marker) {
                observePendingMarker(fresh, observedServerId);
                return;
            }
            if (!latest || resolvingGeneration === generation) return;

            const mode = publicationMode(fresh, latest);
            if (!mode) return;
            resolvingGeneration = generation;
            void probeAndPublish(latest, mode, generation);
        };

        const observeServer = (serverId: string) => {
            if (observedServerId === serverId && unsubscribeEnvelope) return;
            unsubscribeEnvelope?.();
            observedServerId = serverId;
            try {
                unsubscribeEnvelope = ServerConnections.subscribeSessionSwitchEnvelope(serverId, inspectAuthority);
                inspectAuthority();
            } catch {
                showUnavailable(generation);
            }
        };

        const updateApiUser = (_e: Event | undefined, newUser: UserDto) => {
            if (!mounted || !newUser?.Id) return;
            const client = ServerConnections.currentApiClient();
            const serverId = newUser.ServerId || client?.serverId();
            if (!client || !serverId || client.getCurrentUserId() !== newUser.Id) return;
            if (closedAuthority && observedServerId === serverId) return;
            if (observedServerId && observedServerId !== serverId) {
                closePublished(null);
                generation++;
                resolvingGeneration = null;
                clearCompletionTimeout();
                closedAuthority = null;
                coldOldAuthority = null;
                restoreAllowed = false;
                observedSwitchId = null;
            }
            observeServer(serverId);
            inspectAuthority();
        };

        const resetApiUser = () => {
            const hadPublished = !!publishedAuthority;
            generation++;
            resolvingGeneration = null;
            publishedAuthority = null;
            closedAuthority = null;
            coldOldAuthority = null;
            restoreAllowed = false;
            observedSwitchId = null;
            clearCompletionTimeout();
            unsubscribeEnvelope?.();
            unsubscribeEnvelope = undefined;
            observedServerId = null;
            if (!mounted) return;
            flushSync(() => {
                setContext({});
                setAvailability('ready');
            });
            if (hadPublished) {
                void queryClient.cancelQueries();
                queryClient.clear();
                viewContainer.reset();
            }
        };

        const onSessionSwitchCompleted = (_e: Event, receipt: SessionSwitchCompletionReceipt) => {
            if (!mounted || !receipt || receipt.serverId !== observedServerId) return;
            const fresh = readAuthority(receipt.serverId);
            const belongs = fresh?.envelope?.marker?.switchId === receipt.switchId
                || observedSwitchId === receipt.switchId
                || fresh?.envelope?.lastCompletion?.switchId === receipt.switchId
                    && fresh.envelope.lastCompletion.profileUserId === receipt.profileUserId
                    && fresh.envelope.lastCompletion.sessionEpoch === receipt.sessionEpoch
                    && (!publishedAuthority || publishedAuthority.userId !== receipt.profileUserId
                        || publishedAuthority.epoch !== receipt.sessionEpoch);
            if (!belongs) return;
            if (publishedAuthority) observedSwitchId = receipt.switchId;
            if (closedAuthority && observedSwitchId !== receipt.switchId) {
                generation++;
                resolvingGeneration = null;
                clearCompletionTimeout();
                observedSwitchId = receipt.switchId;
                const expectedGeneration = generation;
                completionTimeout = window.setTimeout(() => showUnavailable(expectedGeneration), COMPLETION_WAIT_MS);
            }
            inspectAuthority();
        };

        events.on(ServerConnections, 'localusersignedin', updateApiUser);
        events.on(ServerConnections, 'localusersignedout', resetApiUser);
        events.on(ServerConnections, 'sessionswitchcompleted', onSessionSwitchCompleted);

        const initialClient = ServerConnections.currentApiClient();
        if (initialClient) {
            observeServer(initialClient.serverId());
        }

        return () => {
            mounted = false;
            generation++;
            clearCompletionTimeout();
            unsubscribeEnvelope?.();
            events.off(ServerConnections, 'localusersignedin', updateApiUser);
            events.off(ServerConnections, 'localusersignedout', resetApiUser);
            events.off(ServerConnections, 'sessionswitchcompleted', onSessionSwitchCompleted);
        };
    }, []);

    if (availability === 'pending') return <Loading />;
    if (availability === 'unavailable') {
        return (
            <ConnectionErrorPage
                state={ConnectionState.Unavailable}
                onSelectServer={onSelectServer}
            />
        );
    }

    return (
        <ApiContext.Provider value={context}>
            {children}
        </ApiContext.Provider>
    );
};

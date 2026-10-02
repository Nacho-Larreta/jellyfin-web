import type { Api } from '@jellyfin/sdk';
import type { UserDto } from '@jellyfin/sdk/lib/generated-client';
import type { ApiClient, Event } from 'jellyfin-apiclient';
import React, { type FC, type PropsWithChildren, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

import ConnectionErrorPage from 'components/ConnectionErrorPage';
import Loading from 'components/loading/LoadingComponent';
import viewContainer from 'components/viewContainer';
import { ConnectionState, ServerConnections } from 'lib/jellyfin-apiclient';
import { getWebSessionSwitchApplication } from 'lib/profileSelector/sessionSwitch/application';
import { type BoundSessionReadIdentity } from 'lib/profileSelector/sessionSwitch/boundRequests';
import {
    assertSessionEnvelope,
    type SessionSwitchCompletionReceipt,
    type SessionSwitchEnvelope
} from 'lib/profileSelector/sessionSwitch/model';
import events from 'utils/events';
import { toApi } from 'utils/jellyfin-apiclient/compat';
import { createSessionScopedReadApi, type SessionScopedReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';
import { queryClient } from 'utils/query/queryClient';

export interface JellyfinApiContext {
    __legacyApiClient__?: ApiClient
    api?: Api
    sessionScopedReadApi?: SessionScopedReadApi
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

function isCompletedEnvelope(value: unknown, receipt: SessionSwitchCompletionReceipt): value is SessionSwitchEnvelope {
    if (value === null) return false;
    try {
        assertSessionEnvelope(value);
    } catch {
        return false;
    }

    const completion = value.lastCompletion;
    return value.marker === null
        && completion?.switchId === receipt.switchId
        && completion.serverId === receipt.serverId
        && completion.profileUserId === receipt.profileUserId
        && completion.sessionEpoch === receipt.sessionEpoch
        && value.activeSession.serverId === receipt.serverId
        && value.activeSession.profileUserId === receipt.profileUserId
        && value.activeSession.sessionEpoch === receipt.sessionEpoch;
}

function createPublishedContext(client: ApiClient, user: UserDto, serverId: string): JellyfinApiContext {
    const port = getWebSessionSwitchApplication(ServerConnections).captureBoundSessionRead(client);
    const sessionScopedReadApi = port ? createSessionScopedReadApi(client, port) : undefined;
    return {
        __legacyApiClient__: client,
        api: toApi(client),
        sessionScopedReadApi,
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

    useEffect(() => {
        let generation = 0;
        let mounted = true;
        let completionInProgress = false;
        let unsubscribeEnvelope: (() => void) | undefined;
        let completionTimeout: number | undefined;

        const cancelPendingCompletion = () => {
            generation++;
            unsubscribeEnvelope?.();
            unsubscribeEnvelope = undefined;
            window.clearTimeout(completionTimeout);
            completionTimeout = undefined;
        };

        const showUnavailable = (expectedGeneration: number) => {
            if (!mounted || generation !== expectedGeneration) return;
            generation++;
            unsubscribeEnvelope?.();
            unsubscribeEnvelope = undefined;
            window.clearTimeout(completionTimeout);
            completionTimeout = undefined;
            setAvailability('unavailable');
        };

        const updateApiUser = (_e: Event | undefined, newUser: UserDto) => {
            if (!mounted || completionInProgress || !newUser?.Id) return;
            const client = ServerConnections.currentApiClient();
            const serverId = newUser.ServerId || client?.serverId();
            if (!client || !serverId || client.serverId() !== serverId
                || ServerConnections.getApiClient(serverId) !== client
                || client.getCurrentUserId() !== newUser.Id
                || !client.accessToken()) return;

            let published: JellyfinApiContext;
            try {
                const envelope = ServerConnections.getSessionSwitchEnvelope(serverId);
                if (envelope && (envelope.marker !== null
                    || envelope.activeSession.serverId !== serverId
                    || envelope.activeSession.profileUserId !== newUser.Id
                    || envelope.activeSession.credentialRef.token !== client.accessToken())) return;
                published = createPublishedContext(client, newUser, serverId);
            } catch {
                cancelPendingCompletion();
                setContext({});
                setAvailability('unavailable');
                return;
            }

            cancelPendingCompletion();
            setContext(published);
            setAvailability('ready');
        };

        const resetApiUser = () => {
            cancelPendingCompletion();
            completionInProgress = false;
            if (!mounted) return;
            setContext({});
            setAvailability('ready');
        };

        const resolveCompletion = async (receipt: SessionSwitchCompletionReceipt, expectedGeneration: number) => {
            try {
                const client = ServerConnections.getApiClient(receipt.serverId);
                const envelope = ServerConnections.getSessionSwitchEnvelope(receipt.serverId);
                if (!client || client !== ServerConnections.currentApiClient()
                    || !isCompletedEnvelope(envelope, receipt)
                    || client.getCurrentUserId() !== receipt.profileUserId
                    || client.accessToken() !== envelope.activeSession.credentialRef.token) {
                    showUnavailable(expectedGeneration);
                    return;
                }

                const user = await client.getCurrentUser();
                if (!mounted || generation !== expectedGeneration) return;
                const currentEnvelope = ServerConnections.getSessionSwitchEnvelope(receipt.serverId);
                if (!isCompletedEnvelope(currentEnvelope, receipt)
                    || client !== ServerConnections.currentApiClient()
                    || client.getCurrentUserId() !== receipt.profileUserId
                    || client.accessToken() !== currentEnvelope.activeSession.credentialRef.token
                    || user?.Id !== receipt.profileUserId
                    || user.ServerId && user.ServerId !== receipt.serverId) {
                    showUnavailable(expectedGeneration);
                    return;
                }

                const published = createPublishedContext(client, user, receipt.serverId);
                cancelPendingCompletion();
                completionInProgress = false;
                setContext(published);
                setAvailability('ready');
            } catch {
                showUnavailable(expectedGeneration);
            }
        };

        const onSessionSwitchCompleted = (_e: Event, receipt: SessionSwitchCompletionReceipt) => {
            cancelPendingCompletion();
            if (!mounted) return;
            completionInProgress = true;
            const expectedGeneration = generation;
            flushSync(() => {
                setContext({});
                setAvailability('pending');
            });
            void queryClient.cancelQueries();
            queryClient.clear();
            viewContainer.reset();

            let resolving = false;
            const inspectEnvelope = (value: unknown) => {
                if (!mounted || generation !== expectedGeneration || resolving
                    || !isCompletedEnvelope(value, receipt)) return;
                resolving = true;
                void resolveCompletion(receipt, expectedGeneration);
            };

            try {
                unsubscribeEnvelope = ServerConnections.subscribeSessionSwitchEnvelope(
                    receipt.serverId,
                    inspectEnvelope
                );
                inspectEnvelope(ServerConnections.getSessionSwitchEnvelope(receipt.serverId));
                completionTimeout = window.setTimeout(() => showUnavailable(expectedGeneration), COMPLETION_WAIT_MS);
            } catch {
                showUnavailable(expectedGeneration);
            }
        };

        events.on(ServerConnections, 'localusersignedin', updateApiUser);
        events.on(ServerConnections, 'localusersignedout', resetApiUser);
        events.on(ServerConnections, 'sessionswitchcompleted', onSessionSwitchCompleted);

        const initialGeneration = generation;
        const initialClient = ServerConnections.currentApiClient();
        if (initialClient) {
            try {
                const initialEnvelope = ServerConnections.getSessionSwitchEnvelope(initialClient.serverId());
                if (!initialEnvelope?.marker) {
                    void initialClient.getCurrentUser()
                        .then(user => {
                            if (mounted && generation === initialGeneration) updateApiUser(undefined, user);
                        })
                        .catch(err => {
                            if (mounted && generation === initialGeneration) {
                                console.info('[ApiProvider] Could not get current user', err);
                            }
                        });
                }
            } catch {
                setAvailability('unavailable');
            }
        }

        return () => {
            mounted = false;
            cancelPendingCompletion();
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

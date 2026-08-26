import { AUTHORIZATION_HEADER } from '@jellyfin/sdk/lib/constants';
import { getAuthorizationHeader } from '@jellyfin/sdk/lib/utils';
import { MINIMUM_VERSION } from '@jellyfin/sdk/lib/versions';
import { ApiClient } from 'jellyfin-apiclient';

import events from 'utils/events';
import { ajax } from 'utils/fetch';
import { equalsIgnoreCase } from 'utils/string';
import { compareVersions } from 'utils/versions';

import { ConnectionMode } from './connectionMode';
import { ConnectionState } from './connectionState';

const DEFAULT_CONNECTION_TIMEOUT = 20000;

const SESSION_AUTHORITY_FIELDS = new Set([
    'AccessToken',
    'ExchangeToken',
    'OwnerAccessToken',
    'OwnerUserId',
    'SessionSwitchAuthorityRevision',
    'SessionSwitchEnvelope',
    'UserId'
]);

export function revokeSavedSessionAuthority(server) {
    server.UserId = null;
    server.AccessToken = null;
    server.ExchangeToken = null;
    server.OwnerUserId = null;
    server.OwnerAccessToken = null;
    server.SessionSwitchEnvelope = null;
}

function getServerAddress(server, mode) {
    switch (mode) {
        case ConnectionMode.Local:
            return server.LocalAddress;
        case ConnectionMode.Manual:
            return server.ManualAddress;
        case ConnectionMode.Remote:
            return server.RemoteAddress;
        default:
            return server.ManualAddress || server.LocalAddress || server.RemoteAddress;
    }
}

function updateServerInfo(server, systemInfo) {
    server.Name = systemInfo.ServerName;

    if (systemInfo.Id) {
        server.Id = systemInfo.Id;
    }

    if (systemInfo.LocalAddress) {
        server.LocalAddress = systemInfo.LocalAddress;
    }
}

function normalizeAddress(address) {
    // Attempt to correct bad input
    address = address.trim();

    // Seeing failures in iOS when protocol isn't lowercase
    address = address.replace('Http:', 'http:');
    address = address.replace('Https:', 'https:');

    return address;
}

function sortByAccess(a, b) {
    return (b.DateLastAccessed || 0) - (a.DateLastAccessed || 0);
}

function findSavedServer(servers, candidate) {
    return servers.find(server => candidate.Id && server.Id === candidate.Id)
        || servers.find(server =>
            (candidate.ManualAddress && equalsIgnoreCase(server.ManualAddress, candidate.ManualAddress))
            || (candidate.LocalAddress && equalsIgnoreCase(server.LocalAddress, candidate.LocalAddress))
            || (candidate.RemoteAddress && equalsIgnoreCase(server.RemoteAddress, candidate.RemoteAddress)));
}

function mergeServerMetadata(target, source) {
    Object.entries(source).forEach(([ key, value ]) => {
        if (!SESSION_AUTHORITY_FIELDS.has(key)) {
            target[key] = value;
        }
    });
    return target;
}

export default class ConnectionManager {
    constructor(credentialProvider, appName, appVersion, deviceName, deviceId, capabilities) {
        console.log('Begin ConnectionManager constructor');

        const self = this;
        this._apiClients = [];

        self.mutateCredentials = mutation => {
            const credentials = credentialProvider.credentials();
            const result = mutation(credentials);
            credentialProvider.credentials(credentials);
            return Promise.resolve(result);
        };

        // Set the minimum version to match the SDK
        self._minServerVersion = MINIMUM_VERSION;

        self.appVersion = () => appVersion;

        self.appName = () => appName;

        self.capabilities = () => capabilities;

        self.deviceId = () => deviceId;

        self.credentialProvider = () => credentialProvider;

        self.getServerInfo = (id) => {
            const servers = credentialProvider.credentials().Servers;

            return servers.filter((s) => s.Id === id)[0];
        };

        self.getLastUsedServer = () => {
            const servers = credentialProvider.credentials().Servers;

            servers.sort(sortByAccess);

            if (!servers.length) {
                return null;
            }

            return servers[0];
        };

        self.addApiClient = (apiClient) => {
            self._apiClients.push(apiClient);

            const existingServers = credentialProvider
                .credentials()
                .Servers.filter(
                    (s) =>
                        equalsIgnoreCase(s.ManualAddress, apiClient.serverAddress())
                        || equalsIgnoreCase(s.LocalAddress, apiClient.serverAddress())
                        || equalsIgnoreCase(s.RemoteAddress, apiClient.serverAddress())
                );

            const existingServer = existingServers.length ? existingServers[0] : apiClient.serverInfo();
            existingServer.DateLastAccessed = new Date().getTime();
            existingServer.LastConnectionMode = ConnectionMode.Manual;
            existingServer.ManualAddress = apiClient.serverAddress();

            if (apiClient.manualAddressOnly) {
                existingServer.manualAddressOnly = true;
            }

            apiClient.serverInfo(existingServer);

            apiClient.onAuthenticated = (instance, result) => onAuthenticated(instance, result, {}, true);

            if (!existingServers.length) {
                void self.mutateCredentials(credentials => {
                    if (!findSavedServer(credentials.Servers, existingServer)) {
                        credentials.Servers.push(mergeServerMetadata({}, existingServer));
                    }
                });
            }

            events.trigger(self, 'apiclientcreated', [apiClient]);
        };

        self.clearData = () => {
            console.log('connection manager clearing data');

            return self.mutateCredentials(credentials => {
                credentials.Servers = [];
            });
        };

        self._getOrAddApiClient = (server, serverUrl) => {
            let apiClient = self.getApiClient(server.Id);

            if (!apiClient) {
                apiClient = new ApiClient(serverUrl, appName, appVersion, deviceName, deviceId);

                self._apiClients.push(apiClient);

                apiClient.serverInfo(server);

                apiClient.onAuthenticated = (instance, result) => {
                    return onAuthenticated(instance, result, {}, true);
                };

                events.trigger(self, 'apiclientcreated', [apiClient]);
            }

            console.log('returning instance from getOrAddApiClient');
            return apiClient;
        };

        self.getOrCreateApiClient = (serverId) => {
            const credentials = credentialProvider.credentials();
            const servers = credentials.Servers.filter((s) => equalsIgnoreCase(s.Id, serverId));

            if (!servers.length) {
                throw new Error(`Server not found: ${serverId}`);
            }

            const server = servers[0];

            return self._getOrAddApiClient(server, getServerAddress(server, server.LastConnectionMode));
        };

        function onAuthenticated(apiClient, result, options, saveCredentials) {
            return self.mutateCredentials(credentials => {
                const sourceServer = apiClient.serverInfo();
                const server = credentials.Servers.find(savedServer => savedServer.Id === result.ServerId)
                    || mergeServerMetadata({ Id: result.ServerId }, sourceServer);
                mergeServerMetadata(server, sourceServer);
                if (options.updateDateLastAccessed !== false) {
                    server.DateLastAccessed = new Date().getTime();
                }
                server.Id = result.ServerId;
                revokeSavedSessionAuthority(server);
                server.UserId = saveCredentials ? result.User.Id : null;
                server.AccessToken = saveCredentials ? result.AccessToken : null;
                credentialProvider.addOrUpdateServer(credentials.Servers, server);
                return { ...server };
            }).then(server => {
                apiClient.enableAutomaticBitrateDetection = options.enableAutomaticBitrateDetection;
                apiClient.serverInfo(server);
                apiClient.setAuthenticationInfo(result.AccessToken, result.User.Id);
                afterConnected(apiClient, options);
                return onLocalUserSignIn(server, apiClient.serverAddress(), result.User);
            });
        }

        function afterConnected(apiClient, options = {}) {
            if (options.reportCapabilities !== false) {
                apiClient.reportCapabilities(capabilities);
            }
            apiClient.enableAutomaticBitrateDetection = options.enableAutomaticBitrateDetection;

            if (options.enableWebSocket !== false) {
                console.log('calling apiClient.ensureWebSocket');

                apiClient.ensureWebSocket();
            }
        }

        function onLocalUserSignIn(server, serverUrl, user) {
            // Ensure this is created so that listeners of the event can get the apiClient instance
            self._getOrAddApiClient(server, serverUrl);

            // This allows the app to have a single hook that fires before any other
            const promise = self.onLocalUserSignedIn ? self.onLocalUserSignedIn.call(self, user) : Promise.resolve();

            return promise.then(() => {
                events.trigger(self, 'localusersignedin', [user]);
            });
        }

        function validateAuthentication(server, serverUrl) {
            return ajax({
                type: 'GET',
                url: `${serverUrl}/System/Info`,
                dataType: 'json',
                headers: {
                    [AUTHORIZATION_HEADER]: getAuthorizationHeader(
                        {
                            name: appName,
                            version: appVersion
                        },
                        {
                            id: deviceId,
                            name: deviceName
                        },
                        server.AccessToken
                    )
                }
            }).then(
                (systemInfo) => {
                    updateServerInfo(server, systemInfo);
                    return true;
                },
                () => false
            );
        }

        function getImageUrl(localUser) {
            if (localUser && localUser.PrimaryImageTag) {
                const apiClient = self.getApiClient(localUser);

                const url = apiClient.getUserImageUrl(localUser.Id, {
                    tag: localUser.PrimaryImageTag,
                    type: 'Primary'
                });

                return {
                    url,
                    supportsParams: true
                };
            }

            return {
                url: null,
                supportsParams: false
            };
        }

        self.user = (apiClient) =>
            new Promise((resolve) => {
                let localUser;

                function onLocalUserDone() {
                    if (apiClient && apiClient.getCurrentUserId()) {
                        apiClient.getCurrentUser().then((u) => {
                            localUser = u;
                            const image = getImageUrl(localUser);

                            resolve({
                                localUser,
                                name: localUser ? localUser.Name : null,
                                imageUrl: image.url,
                                supportsImageParams: image.supportsParams
                            });
                        });
                    }
                }

                if (apiClient && apiClient.getCurrentUserId()) {
                    onLocalUserDone();
                }
            });

        self.logout = () => {
            const promises = [];

            for (let i = 0, length = self._apiClients.length; i < length; i++) {
                const apiClient = self._apiClients[i];

                if (apiClient.accessToken()) {
                    promises.push(logoutOfServer(apiClient));
                }
            }

            return Promise.all(promises).then(() => {
                return self.mutateCredentials(credentials => {
                    credentials.Servers
                        .filter(server => server.UserLinkType !== 'Guest')
                        .forEach(revokeSavedSessionAuthority);
                });
            });
        };

        function logoutOfServer(apiClient) {
            const serverInfo = apiClient.serverInfo() || {};

            const logoutInfo = {
                serverId: serverInfo.Id
            };

            return apiClient.logout().then(
                () => {
                    events.trigger(self, 'localusersignedout', [logoutInfo]);
                },
                () => {
                    events.trigger(self, 'localusersignedout', [logoutInfo]);
                }
            );
        }

        self.getSavedServers = () => {
            const credentials = credentialProvider.credentials();

            const servers = credentials.Servers.slice(0);

            servers.sort(sortByAccess);

            return servers;
        };

        self.getAvailableServers = () => {
            console.debug('[ConnectionManager] Begin getAvailableServers');

            return findServers().then(foundServers => {
                return self.mutateCredentials(credentials => {
                    foundServers.forEach(foundServer => {
                        const existingServer = findSavedServer(credentials.Servers, foundServer);
                        if (existingServer) {
                            mergeServerMetadata(existingServer, foundServer);
                        } else {
                            credentials.Servers.push({ ...foundServer });
                        }
                    });

                    credentials.Servers.sort(sortByAccess);
                    return credentials.Servers.slice(0);
                });
            });
        };

        function findServers() {
            return new Promise((resolve) => {
                const onFinish = function (foundServers) {
                    const servers = foundServers.map((foundServer) => {
                        const info = {
                            Id: foundServer.Id,
                            LocalAddress: convertEndpointAddressToManualAddress(foundServer) || foundServer.Address,
                            Name: foundServer.Name
                        };
                        info.LastConnectionMode = info.ManualAddress ? ConnectionMode.Manual : ConnectionMode.Local;
                        return info;
                    });
                    resolve(servers);
                };

                if (window && window.NativeShell && typeof window.NativeShell.findServers === 'function') {
                    window.NativeShell.findServers(1e3).then(onFinish, function () {
                        onFinish([]);
                    });
                } else {
                    resolve([]);
                }
            });
        }

        function convertEndpointAddressToManualAddress(info) {
            if (info.Address && info.EndpointAddress) {
                let address = info.EndpointAddress.split(':')[0];

                // Determine the port, if any
                const parts = info.Address.split(':');
                if (parts.length > 1) {
                    const portString = parts[parts.length - 1];

                    if (!isNaN(parseInt(portString, 10))) {
                        address += `:${portString}`;
                    }
                }

                return normalizeAddress(address);
            }

            return null;
        }

        self.connectToServers = (servers, options) => {
            console.log(`Begin connectToServers, with ${servers.length} servers`);

            const firstServer = servers.length ? servers[0] : null;
            // See if we have any saved credentials and can auto sign in
            if (firstServer) {
                return self.connectToServer(firstServer, options).then((result) => {
                    console.log('resolving connectToServers with result.State: ' + result.State);
                    return result;
                });
            }

            return Promise.resolve({
                Servers: servers,
                State: ConnectionState.ServerSelection
            });
        };

        function getTryConnectPromise(url, connectionMode, state, resolve, reject) {
            console.log('getTryConnectPromise ' + url);

            ajax({
                url: `${url}/System/Info/Public`,
                timeout: DEFAULT_CONNECTION_TIMEOUT,
                type: 'GET',
                dataType: 'json'
            }).then(
                (result) => {
                    if (!state.resolved) {
                        state.resolved = true;

                        console.log('Reconnect succeeded to ' + url);
                        resolve({
                            url: url,
                            connectionMode: connectionMode,
                            data: result
                        });
                    }
                },
                () => {
                    console.log('Reconnect failed to ' + url);

                    if (!state.resolved) {
                        state.rejects++;
                        if (state.rejects >= state.numAddresses) {
                            reject();
                        }
                    }
                }
            );
        }

        function tryReconnect(serverInfo) {
            const addresses = [];
            const addressesStrings = [];

            // the timeouts are a small hack to try and ensure the remote address doesn't resolve first

            // manualAddressOnly is used for the local web app that always connects to a fixed address
            if (
                !serverInfo.manualAddressOnly
                && serverInfo.LocalAddress
                && addressesStrings.indexOf(serverInfo.LocalAddress) === -1
            ) {
                addresses.push({
                    url: serverInfo.LocalAddress,
                    mode: ConnectionMode.Local,
                    timeout: 0
                });
                addressesStrings.push(addresses[addresses.length - 1].url);
            }
            if (serverInfo.ManualAddress && addressesStrings.indexOf(serverInfo.ManualAddress) === -1) {
                addresses.push({
                    url: serverInfo.ManualAddress,
                    mode: ConnectionMode.Manual,
                    timeout: 100
                });
                addressesStrings.push(addresses[addresses.length - 1].url);
            }
            if (
                !serverInfo.manualAddressOnly
                && serverInfo.RemoteAddress
                && addressesStrings.indexOf(serverInfo.RemoteAddress) === -1
            ) {
                addresses.push({
                    url: serverInfo.RemoteAddress,
                    mode: ConnectionMode.Remote,
                    timeout: 200
                });
                addressesStrings.push(addresses[addresses.length - 1].url);
            }

            console.info('[ConnectionManager] tryReconnect addresses', addressesStrings);

            return new Promise((resolve, reject) => {
                const state = {};
                state.numAddresses = addresses.length;
                state.rejects = 0;

                addresses.forEach((url) => {
                    setTimeout(() => {
                        if (!state.resolved) {
                            getTryConnectPromise(url.url, url.mode, state, resolve, reject);
                        }
                    }, url.timeout);
                });
            });
        };

        self.connectToServer = (server, options) => {
            console.debug('[ConnectionManager] begin connectToServer');

            return new Promise((resolve) => {
                options = options || {};

                tryReconnect(server).then(
                    (result) => {
                        const serverUrl = result.url;
                        const connectionMode = result.connectionMode;
                        result = result.data;

                        if (compareVersions(self.minServerVersion(), result.Version) === 1) {
                            console.warn('[ConnectionManager] minServerVersion requirement not met. Server version:', result.Version);
                            resolve({
                                State: ConnectionState.ServerUpdateNeeded,
                                Servers: [server]
                            });
                        } else if (server.Id && result.Id !== server.Id) {
                            console.warn(
                                '[ConnectionManager] http request succeeded, but found a different server Id than what was expected'
                            );
                            resolve({
                                State: ConnectionState.ServerMismatch
                            });
                        } else {
                            onSuccessfulConnection(server, result, connectionMode, serverUrl, true, resolve, options);
                        }
                    },
                    () => {
                        resolve({
                            State: ConnectionState.Unavailable
                        });
                    }
                );
            });
        };

        function onSuccessfulConnection(server, systemInfo, connectionMode, serverUrl, verifyLocalAuthentication, resolve, options = {}) {
            if (options.enableAutoLogin !== false && server.AccessToken && verifyLocalAuthentication) {
                void validateAuthentication(server, serverUrl).then(function (isValid) {
                    onSuccessfulConnection(
                        server,
                        systemInfo,
                        connectionMode,
                        serverUrl,
                        false,
                        resolve,
                        {
                            ...options,
                            invalidateSavedAuthentication: !isValid
                        }
                    );
                });
                return;
            }

            void self.mutateCredentials(credentials => {
                const savedServer = findSavedServer(credentials.Servers, server)
                    || mergeServerMetadata({}, server);
                mergeServerMetadata(savedServer, server);
                if (options.enableAutoLogin === false || options.invalidateSavedAuthentication) {
                    revokeSavedSessionAuthority(savedServer);
                }
                updateServerInfo(savedServer, systemInfo);
                savedServer.LastConnectionMode = connectionMode;
                if (options.updateDateLastAccessed !== false) {
                    savedServer.DateLastAccessed = new Date().getTime();
                }
                credentialProvider.addOrUpdateServer(credentials.Servers, savedServer);
                return { ...savedServer };
            }).then(savedServer => {
                finishSuccessfulConnection(savedServer, systemInfo, connectionMode, serverUrl, resolve, options);
            }, () => {
                resolve({
                    State: ConnectionState.Unavailable
                });
            });
        }

        function finishSuccessfulConnection(server, systemInfo, _connectionMode, serverUrl, resolve, options) {
            const result = {
                Servers: []
            };

            result.ApiClient = self._getOrAddApiClient(server, serverUrl);

            result.ApiClient.setSystemInfo(systemInfo);
            result.SystemInfo = systemInfo;

            result.State = server.AccessToken && options.enableAutoLogin !== false ? ConnectionState.SignedIn : ConnectionState.ServerSignIn;

            result.Servers.push(server);

            // set this now before updating server info, otherwise it won't be set in time
            result.ApiClient.enableAutomaticBitrateDetection = options.enableAutomaticBitrateDetection;

            result.ApiClient.updateServerInfo(server, serverUrl);
            result.ApiClient.setAuthenticationInfo(server.AccessToken, server.UserId);

            const resolveActions = function () {
                resolve(result);

                events.trigger(self, 'connected', [result]);
            };

            if (result.State === ConnectionState.SignedIn) {
                afterConnected(result.ApiClient, options);

                result.ApiClient.getCurrentUser().then((user) => {
                    onLocalUserSignIn(server, serverUrl, user).then(resolveActions, resolveActions);
                }, resolveActions);
            } else {
                resolveActions();
            }
        }

        self.updateSavedServerId = async (server) => {
            const previousServerId = server.Id;
            const { data: serverResponse } = await tryReconnect(server);
            await self.mutateCredentials(credentials => {
                const savedServer = credentials.Servers.find(candidate => candidate.Id === previousServerId)
                    || mergeServerMetadata({}, server);
                mergeServerMetadata(savedServer, server);
                savedServer.Id = serverResponse.Id;
                revokeSavedSessionAuthority(savedServer);
                credentials.Servers = credentials.Servers.filter(candidate => candidate.Id !== previousServerId);
                credentialProvider.addOrUpdateServer(credentials.Servers, savedServer);
            });
        };

        function tryConnectToAddress(address, options) {
            const server = {
                ManualAddress: address,
                LastConnectionMode: ConnectionMode.Manual
            };

            return self.connectToServer(server, options).then((result) => {
                // connectToServer never rejects, but resolves with State=ConnectionState.Unavailable
                if (result.State === ConnectionState.Unavailable) {
                    return Promise.reject();
                }
                return result;
            });
        }

        self.connectToAddress = function (address, options) {
            if (!address) {
                return Promise.reject();
            }

            address = normalizeAddress(address);

            const urls = [];

            if (/^[^:]+:\/\//.test(address)) {
                // Protocol specified - connect as is
                urls.push(address);
            } else {
                urls.push(`https://${address}`);
                urls.push(`http://${address}`);
            }

            let i = 0;

            function onFail() {
                console.log(`connectToAddress ${urls[i]} failed`);

                if (++i < urls.length) {
                    return tryConnectToAddress(urls[i], options).catch(onFail);
                }

                return Promise.resolve({
                    State: ConnectionState.Unavailable
                });
            }

            return tryConnectToAddress(urls[i], options).catch(onFail);
        };

        self.deleteServer = (serverId) => {
            if (!serverId) {
                throw new Error('null serverId');
            }

            return self.mutateCredentials(credentials => {
                credentials.Servers = credentials.Servers.filter(server => server.Id !== serverId);
            });
        };
    }

    connect(options) {
        console.log('Begin connect');

        return this.getAvailableServers().then((servers) => {
            return this.connectToServers(servers, options);
        });
    }

    handleMessageReceived(msg) {
        const serverId = msg.ServerId;
        if (serverId) {
            const apiClient = this.getApiClient(serverId);
            if (apiClient) {
                if (typeof msg.Data === 'string') {
                    try {
                        msg.Data = JSON.parse(msg.Data);
                    } catch (err) {
                        console.log('unable to parse json content: ' + err);
                    }
                }

                apiClient.handleMessageReceived(msg);
            }
        }
    }

    getApiClients() {
        const servers = this.getSavedServers();

        for (let i = 0, length = servers.length; i < length; i++) {
            const server = servers[i];
            if (server.Id) {
                this._getOrAddApiClient(server, getServerAddress(server, server.LastConnectionMode));
            }
        }

        return this._apiClients;
    }

    /**
     * Gets the ApiClient for a given BaseItem or ServerId.
     * @param {import('@jellyfin/sdk/lib/generated-client').BaseItemDto | string | undefined} item
     * @returns {ApiClient}
     */
    getApiClient(item) {
        if (!item) {
            throw new Error('item or serverId cannot be null');
        }

        // Accept string + object
        if (item.ServerId) {
            item = item.ServerId;
        }

        return this._apiClients.filter((a) => {
            const serverInfo = a.serverInfo();

            // We have to keep this hack in here because of the addApiClient method
            return !serverInfo || serverInfo.Id === item;
        })[0];
    }

    minServerVersion(val) {
        if (val) {
            this._minServerVersion = val;
        }

        return this._minServerVersion;
    }
}

import appSettings from '../../scripts/settings/appSettings';
import * as userSettings from '../../scripts/settings/userSettings';
import { playbackManager } from '../../components/playback/playbackmanager';
import globalize from '../../lib/globalize';
import CastSenderApi from './castSenderApi';
import alert from '../../components/alert';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import { getItems } from '../../utils/jellyfin-apiclient/getItems.ts';
import {
    checkCastConnectionReceipt,
    clearCastConnectionReceipt,
    createCastActivationOwner,
    readRestoredCastReceipt,
    reserveCastConnectionReceipt,
    writeCastConnectionReceipt
} from '../../components/playback/castActivationAuthority';

// Based on https://github.com/googlecast/CastVideos-chrome/blob/master/CastVideos.js

const PlayerName = 'Google Cast';

/**
 * Constants of states for Chromecast device
 **/
const DEVICE_STATE = {
    'IDLE': 0,
    'ACTIVE': 1,
    'WARNING': 2,
    'ERROR': 3
};

/**
 * Constants of states for CastPlayer
 **/
const PLAYER_STATE = {
    'IDLE': 'IDLE',
    'LOADING': 'LOADING',
    'LOADED': 'LOADED',
    'PLAYING': 'PLAYING',
    'PAUSED': 'PAUSED',
    'STOPPED': 'STOPPED',
    'SEEKING': 'SEEKING',
    'ERROR': 'ERROR'
};

const messageNamespace = 'urn:x-cast:com.connectsdk';

function rejectedDelivery(reason) {
    const result = Promise.reject(new Error(reason));
    result.catch(() => undefined);
    return result;
}

function detachListener(remove) {
    try {
        remove();
    } catch {
        // The local owner still retires if the Cast SDK has already torn down the session.
    }
}

class CastPlayer {
    constructor() {
        this.initializationOwner = createCastActivationOwner();
        this.connection = null;
        this.candidate = null;
        this.restoreSelectionRevision = playbackManager.observeCastRestoreAuthority(this.initializationOwner);
        this.unsubscribeCastSelection = playbackManager.subscribeCastSelection(() => {
            this.rejectPending();
            this.discardCandidate();
            this.detachConnection();
        });
        this.pending = null;
        this.retryTimer = null;
        this.retired = false;
        /* device variables */
        // @type {DEVICE_STATE} A state for device
        this.deviceState = DEVICE_STATE.IDLE;

        /* Cast player variables */
        // @type {Object} a chrome.cast.media.Media object
        this.currentMediaSession = null;

        // @type {string} a chrome.cast.Session object
        this.session = null;
        // @type {PLAYER_STATE} A state for Cast media player
        this.castPlayerState = PLAYER_STATE.IDLE;

        this.hasReceivers = false;

        this.initializationOwner?.onInvalidated(() => this.retire());
        this.initializeCastPlayer();
    }

    retire() {
        if (this.retired) return;
        this.retired = true;
        this.unsubscribeCastSelection();
        clearTimeout(this.retryTimer);
        this.rejectPending();
        this.discardCandidate();
        this.detachConnection();
        this.initializationOwner?.retire();
    }

    rejectPending(pending = this.pending) {
        if (!pending || this.pending !== pending) return;
        this.pending = null;
        pending.unsubscribe?.();
        if (this.candidate?.pending === pending) this.discardCandidate();
        if (pending.reservation?.token) void clearCastConnectionReceipt(pending.owner, null, pending.reservation.token);
        pending.reject(new Error('Cast activation expired'));
    }

    currentConnection(connection = this.connection) {
        return !this.retired && !!connection && this.connection === connection && connection.owner.current()
            && this.session === connection.session
            && connection.selectionRevision === playbackManager.getCastSelectionRevision()
            && (!connection.restored || playbackManager.canRestoreOwnedCast(connection.owner, this.restoreSelectionRevision));
    }

    currentCandidate(connection) {
        return !this.retired && this.candidate === connection && connection.owner.current()
            && (!connection.pending || this.pending === connection.pending)
            && connection.selectionRevision === playbackManager.getCastSelectionRevision()
            && (!connection.restored || playbackManager.canRestoreOwnedCast(connection.owner, this.restoreSelectionRevision));
    }

    discardCandidate(connection = this.candidate) {
        if (!connection || this.candidate !== connection) return false;
        this.candidate = null;
        for (const cancel of connection.pendingMessages) cancel();
        connection.pendingMessages.clear();
        void clearCastConnectionReceipt(connection.owner, connection.session, connection.receiptToken);
        return true;
    }

    detachConnection(connection = this.connection) {
        if (!connection || this.connection !== connection) return;
        this.connection = null;
        const { session, listeners, media, owner } = connection;
        for (const cancel of connection.pendingMessages) cancel();
        connection.pendingMessages.clear();
        detachListener(() => session.removeMessageListener?.(messageNamespace, listeners.message));
        detachListener(() => session.removeMediaListener?.(listeners.media));
        detachListener(() => session.removeUpdateListener?.(listeners.update));
        detachListener(() => media?.removeUpdateListener?.(listeners.mediaUpdate));
        connection.unsubscribe?.();
        void clearCastConnectionReceipt(owner, session, connection.receiptToken);
        if (this.session === session) this.session = null;
        this.currentMediaSession = null;
        this.deviceState = DEVICE_STATE.IDLE;
        this.castPlayerState = PLAYER_STATE.IDLE;
        document.removeEventListener('volumeupbutton', onVolumeUpKeyDown, false);
        document.removeEventListener('volumedownbutton', onVolumeDownKeyDown, false);
        playbackManager.removeOwnedCastPlayer(owner);
    }

    /**
     * Initialize Cast media player
     * Initializes the API. Note that either successCallback and errorCallback will be
     * invoked once the API has finished initialization. The sessionListener and
     * receiverListener may be invoked at any time afterwards, and possibly more than once.
     */
    initializeCastPlayer() {
        const chrome = window.chrome;
        const owner = this.initializationOwner;
        if (this.retired || !owner?.current() || this.isInitialized) return;
        if (!chrome) {
            console.warn('Not initializing chromecast: chrome object is missing');
            return;
        }

        if (!chrome.cast?.isAvailable) {
            clearTimeout(this.retryTimer);
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                if (owner.current()) this.initializeCastPlayer();
            }, 1000);
            return;
        }

        const apiClient = ServerConnections.currentApiClient();
        if (!owner.current()) return;

        apiClient.getUser(owner.profileUserId).then(user => {
            if (!owner.current() || this.retired) return;
            const applicationID = user.Configuration.CastReceiverId;
            if (!applicationID) {
                console.warn(`Not initializing chromecast: CastReceiverId is ${applicationID}`);
                return;
            }

            // request session
            const sessionRequest = new chrome.cast.SessionRequest(applicationID);
            const apiConfig = new chrome.cast.ApiConfig(sessionRequest,
                session => this.sessionListener(session, owner),
                availability => this.receiverListener(availability, owner));

            console.debug(`chromecast.initialize (applicationId=${applicationID})`);
            if (owner.current()) {
                chrome.cast.initialize(apiConfig,
                    () => this.onInitSuccess(owner), () => this.onError(owner));
            }
        }).catch(() => this.onError(owner));
    }

    /**
     * Callback function for init success
     */
    onInitSuccess(owner) {
        if (this.retired || !owner.current()) return;
        this.isInitialized = true;
        console.debug('[chromecastPlayer] init success');
    }

    /**
     * Generic error callback function
     */
    onError(owner = this.connection?.owner) {
        if (owner && !owner.current()) return;
        console.debug('[chromecastPlayer] error');
    }

    /**
     * @param {!Object} e A new session
     * This handles auto-join when a page is reloaded
     * When active session is detected, playback will automatically
     * join existing session and occur in Cast mode and media
     * status gets synced up with current media of the session
     */
    async sessionListener(session, owner) {
        if (this.retired || !owner.current() || !session || this.pending
            || !playbackManager.canRestoreOwnedCast(owner, this.restoreSelectionRevision)) return;
        const claim = await readRestoredCastReceipt(owner, session, PlayerName);
        if (claim.status !== 'claimed') return;
        if (this.retired || !owner.current() || this.pending
            || !playbackManager.canRestoreOwnedCast(owner, this.restoreSelectionRevision)) {
            void clearCastConnectionReceipt(owner, session, claim.token);
            return;
        }
        this.onSessionConnected(session, owner, null, true, claim.token);
    }

    // messageListener - receive callback messages from the Cast receiver
    messageListener(namespace, message, connection) {
        if (!this.currentConnection(connection)) return;
        if (typeof (message) === 'string') {
            try {
                message = JSON.parse(message);
            } catch {
                return;
            }
        }
        if (!message || typeof message !== 'object') return;

        if (message.type === 'playbackerror') {
            const errorCode = message.data;
            setTimeout(() => {
                if (this.currentConnection(connection)) alertText(globalize.translate('MessagePlaybackError' + errorCode), globalize.translate('HeaderPlaybackError'));
            }, 300);
        } else if (message.type === 'connectionerror') {
            setTimeout(() => {
                if (this.currentConnection(connection)) alertText(globalize.translate('MessageChromecastConnectionError'), globalize.translate('HeaderError'));
            }, 300);
        } else if (message.type) {
            Events.trigger(this, message.type, [message.data]);
        }
    }

    /**
     * @param {string} e Receiver availability
     * This indicates availability of receivers but
     * does not provide a list of device IDs
     */
    receiverListener(e, owner) {
        if (this.retired || !owner.current()) return;
        if (e === 'available') {
            console.debug('[chromecastPlayer] receiver found');
            this.hasReceivers = true;
        } else {
            console.debug('[chromecastPlayer] receiver list empty');
            this.hasReceivers = false;
        }
    }

    /**
     * session update listener
     */
    sessionUpdateListener(isAlive, connection) {
        if (!this.currentConnection(connection)) return;
        if (isAlive) {
            console.debug('[chromecastPlayer] sessionUpdateListener: already alive');
        } else {
            void clearCastConnectionReceipt(connection.owner, connection.session, connection.receiptToken);
            this.detachConnection(connection);
        }
    }

    /**
     * Requests that a receiver application session be created or joined. By default, the SessionRequest
     * passed to the API at initialization time is used; this may be overridden by passing a different
     * session request in opt_sessionRequest.
     */
    launchApp(pending) {
        if (!pending.owner.current() || this.pending !== pending) return;
        console.debug('[chromecastPlayer] launching app...');
        window.chrome.cast.requestSession(
            session => this.onRequestSessionSuccess(session, pending),
            () => this.onLaunchError(pending));
    }

    /**
     * Callback function for request session success
     * @param {Object} e A chrome.cast.Session object
     */
    onRequestSessionSuccess(session, pending) {
        if (this.pending !== pending || !pending.owner.current() || this.retired) return;
        if (this.candidate?.pending === pending) return;
        this.onSessionConnected(session, pending.owner, pending, false, pending.reservation?.token);
    }

    onSessionConnected(session, owner, pending, restored, receiptToken) {
        if (this.retired || !owner.current() || pending && this.pending !== pending) return;
        if (!session?.sessionId || !session.receiver?.label) {
            if (pending) this.rejectPending(pending);
            return;
        }
        this.discardCandidate();
        const connection = {
            owner, session, pending, restored, selectionRevision: playbackManager.getCastSelectionRevision(),
            media: null, listeners: null, unsubscribe: null,
            receiptToken, pendingMessages: new Set()
        };
        connection.listeners = {
            message: (namespace, message) => this.messageListener(namespace, message, connection),
            media: media => this.sessionMediaListener(media, connection),
            update: alive => this.sessionUpdateListener(alive, connection),
            mediaUpdate: alive => this.onMediaStatusUpdate(alive, connection)
        };
        this.candidate = connection;
        void this.completeCandidate(connection);
    }

    async completeCandidate(connection) {
        const { owner, session, restored, receiptToken } = connection;
        const currentReceipt = receiptToken ? checkCastConnectionReceipt(owner, receiptToken) :
            Promise.resolve({ status: restored ? 'missing' : 'unavailable' });
        try {
            const result = await currentReceipt;
            if (!this.currentCandidate(connection)) return;
            const accepted = restored ? result.status === 'current' :
                result.status === 'current' || result.status === 'unavailable';
            if (!accepted) {
                this.failCandidate(connection);
                return;
            }
            await this.sendIdentify(connection);
            if (!this.currentCandidate(connection)) return;
            let persistence = { status: 'unavailable' };
            if (restored) {
                persistence = await checkCastConnectionReceipt(owner, receiptToken);
            } else if (receiptToken) {
                persistence = await writeCastConnectionReceipt(owner, PlayerName, session, receiptToken);
            }
            if (!this.currentCandidate(connection)) return;
            const confirmed = restored ? persistence.status === 'current' :
                persistence.status === 'confirmed' || persistence.status === 'unavailable';
            if (!confirmed) {
                this.failCandidate(connection);
                return;
            }
            this.publishCandidate(connection);
        } catch {
            this.failCandidate(connection);
        }
    }

    sendIdentify(connection) {
        if (!this.currentCandidate(connection)) return rejectedDelivery('Cast activation expired');
        const { owner, session } = connection;
        const payload = {
            options: {}, command: 'Identify', ...owner.credential,
            receiverName: session.receiver?.friendlyName ?? null
        };
        const bitrateSetting = appSettings.maxChromecastBitrate();
        if (bitrateSetting) payload.maxBitrate = bitrateSetting;
        return this.sendMessageInternal(payload, connection, () => this.currentCandidate(connection));
    }

    failCandidate(connection) {
        if (this.discardCandidate(connection) && connection.pending) this.rejectPending(connection.pending);
    }

    keepPublishedConnection(connection) {
        if (this.currentConnection(connection)) return true;
        this.detachConnection(connection);
        if (connection.pending) this.rejectPending(connection.pending);
        return false;
    }

    publishCandidate(connection) {
        if (!this.currentCandidate(connection)) return;
        this.detachConnection();
        if (!this.currentCandidate(connection)) return;
        const { owner, session, pending, restored } = connection;
        this.candidate = null;
        this.connection = connection;
        this.session = session;
        this.deviceState = DEVICE_STATE.ACTIVE;
        connection.unsubscribe = owner.onInvalidated(() => this.detachConnection(connection));
        if (!this.keepPublishedConnection(connection)) return;
        try {
            session.addMessageListener(messageNamespace, connection.listeners.message);
            if (!this.keepPublishedConnection(connection)) return;
            session.addMediaListener(connection.listeners.media);
            if (!this.keepPublishedConnection(connection)) return;
            session.addUpdateListener(connection.listeners.update);
        } catch {
            this.detachConnection(connection);
            if (pending) this.rejectPending(pending);
            return;
        }
        if (!this.keepPublishedConnection(connection)) return;
        document.addEventListener('volumeupbutton', onVolumeUpKeyDown, false);
        document.addEventListener('volumedownbutton', onVolumeDownKeyDown, false);
        if (restored && session.media?.[0]) this.onMediaDiscovered('activeSession', session.media[0], connection);
        if (!this.keepPublishedConnection(connection)) return;
        Events.trigger(this, 'connect', [connection]);
        if (!this.keepPublishedConnection(connection)) return;
        if (pending) {
            this.pending = null;
            pending.unsubscribe?.();
            pending.resolve();
        }
    }

    /**
     * session update listener
     */
    sessionMediaListener(e, connection) {
        if (!this.currentConnection(connection)) return;
        this.currentMediaSession = e;
        connection.media = e;
        e.addUpdateListener(connection.listeners.mediaUpdate);
    }

    /**
     * Callback function for launch error
     */
    onLaunchError(pending) {
        if (this.pending !== pending || !pending.owner.current()) return;
        console.debug('[chromecastPlayer] launch error');
        this.deviceState = DEVICE_STATE.ERROR;
        this.rejectPending(pending);
    }

    pair(attempt) {
        const owner = attempt?.owner;
        if (!owner?.current() || this.retired || !this.isInitialized || this.pending) {
            return Promise.reject(new Error('Cast activation unavailable'));
        }
        return new Promise((resolve, reject) => {
            const pending = { attempt, owner, resolve, reject, unsubscribe: null };
            this.pending = pending;
            pending.unsubscribe = owner.onInvalidated(() => this.rejectPending(pending));
            void reserveCastConnectionReceipt(owner, PlayerName).then(async reservation => {
                pending.reservation = reservation;
                if (this.pending !== pending || !owner.current()) {
                    if (reservation.token) void clearCastConnectionReceipt(owner, null, reservation.token);
                    return;
                }
                if (reservation.status !== 'reserved' && reservation.status !== 'unavailable') {
                    this.rejectPending(pending);
                    return;
                }
                if (reservation.token) {
                    const current = await checkCastConnectionReceipt(owner, reservation.token);
                    if (this.pending !== pending || !owner.current()) return;
                    if (current.status !== 'current' && current.status !== 'unavailable') {
                        this.rejectPending(pending);
                        return;
                    }
                }
                try {
                    this.launchApp(pending);
                } catch {
                    this.rejectPending(pending);
                }
            }).catch(() => this.rejectPending(pending));
        });
    }

    /**
     * Stops the running receiver application associated with the session.
     */
    stopApp() {
        const connection = this.connection;
        if (this.currentConnection(connection)) {
            connection.session.stop(() => this.onStopAppSuccess('Session stopped', connection),
                () => this.onError(connection.owner));
        }
    }

    /**
     * Callback function for stop app success
     */
    onStopAppSuccess(message, connection) {
        if (!this.currentConnection(connection)) return;
        console.debug(message);
        void clearCastConnectionReceipt(connection.owner, connection.session, connection.receiptToken);
        this.detachConnection(connection);
    }

    /**
     * Loads media into a running receiver application
     * @param {Number} mediaIndex - An index number to indicate current media content
     * @returns Promise
     */
    loadMedia(options, command, connection = this.connection) {
        if (!this.currentConnection(connection)) return rejectedDelivery('Cast connection expired');

        // convert items to smaller stubs to send minimal amount of information
        options.items = options.items.map(function (i) {
            return {
                Id: i.Id,
                ServerId: i.ServerId,
                Name: i.Name,
                Type: i.Type,
                MediaType: i.MediaType,
                IsFolder: i.IsFolder
            };
        });

        return this.sendMessage({
            options: options,
            command: command
        }, connection);
    }

    sendMessage(message, connection = this.connection) {
        if (!this.currentConnection(connection)) return rejectedDelivery('Cast connection expired');
        const { owner, session } = connection;
        const options = message.options || {};
        if (options.ServerId && options.ServerId !== owner.serverId
            || options.serverId && options.serverId !== owner.serverId
            || options.items?.some(item => item.ServerId !== owner.serverId)) {
            return rejectedDelivery('Cast item belongs to a different server');
        }
        const payload = {
            ...message,
            ...owner.credential,
            receiverName: session.receiver?.friendlyName ?? null
        };

        const bitrateSetting = appSettings.maxChromecastBitrate();
        if (bitrateSetting) {
            payload.maxBitrate = bitrateSetting;
        }

        if (options.items) {
            payload.subtitleAppearance = userSettings.getSubtitleAppearanceSettings();
            payload.subtitleBurnIn = appSettings.get('subtitleburnin') || '';
        }

        const delivery = this.sendMessageInternal(payload, connection);
        delivery.catch(() => undefined);
        return delivery;
    }

    sendMessageInternal(message, connection = this.connection, current = () => this.currentConnection(connection)) {
        if (!current()) return rejectedDelivery('Cast connection expired');
        return new Promise((resolve, reject) => {
            const fail = () => {
                connection.pendingMessages.delete(fail);
                reject(new Error('Cast message delivery failed'));
            };
            connection.pendingMessages.add(fail);
            try {
                connection.session.sendMessage(messageNamespace, JSON.stringify(message), () => {
                    if (!current()) return fail();
                    connection.pendingMessages.delete(fail);
                    this.onPlayCommandSuccess();
                    resolve();
                }, fail);
            } catch {
                fail();
            }
        });
    }

    onPlayCommandSuccess() {
        console.debug('Message was sent to receiver ok.');
    }

    /**
     * Callback function for loadMedia success
     * @param {Object} media A new media object.
     */
    onMediaDiscovered(how, media, connection = this.connection) {
        if (!this.currentConnection(connection)) return;
        console.debug('[chromecastPlayer] new media session ID:' + media.mediaSessionId + ' (' + how + ')');
        this.currentMediaSession = media;

        if (how === 'loadMedia') {
            this.castPlayerState = PLAYER_STATE.PLAYING;
        }

        if (how === 'activeSession') {
            this.castPlayerState = media.playerState;
        }

        connection.media = media;
        media.addUpdateListener(connection.listeners.mediaUpdate);
    }

    /**
     * Callback function for media status update from receiver
     * @param {!Boolean} e true/false
     */
    onMediaStatusUpdate(e, connection) {
        if (!this.currentConnection(connection)) return;
        console.debug('[chromecastPlayer] updating media: ' + e);
        if (e === false) {
            this.castPlayerState = PLAYER_STATE.IDLE;
        }
    }

    /**
     * Set media volume in Cast mode
     * @param {Boolean} mute A boolean
     */
    setReceiverVolume(mute, vol) {
        const connection = this.connection;
        if (!this.currentConnection(connection)) return;
        if (!this.currentMediaSession) {
            console.debug('this.currentMediaSession is null');
            return;
        }

        if (!mute) {
            connection.session.setReceiverVolumeLevel((vol || 1),
                () => { if (this.currentConnection(connection)) this.mediaCommandSuccessCallback(); },
                () => this.onError(connection.owner));
        } else {
            connection.session.setReceiverMuted(true,
                () => { if (this.currentConnection(connection)) this.mediaCommandSuccessCallback(); },
                () => this.onError(connection.owner));
        }
    }

    /**
     * Mute CC
     */
    mute() {
        this.setReceiverVolume(true);
    }

    /**
     * Callback function for media command success
     */
    mediaCommandSuccessCallback(info) {
        console.debug(info);
    }
}

function alertText(text, title) {
    alert({
        text,
        title
    });
}

function onVolumeUpKeyDown() {
    playbackManager.volumeUp();
}

function onVolumeDownKeyDown() {
    playbackManager.volumeDown();
}

function normalizeImages(state) {
    if (state?.NowPlayingItem) {
        const item = state.NowPlayingItem;

        if ((!item.ImageTags?.Primary) && item.PrimaryImageTag) {
            item.ImageTags = item.ImageTags || {};
            item.ImageTags.Primary = item.PrimaryImageTag;
        }
        if (item.BackdropImageTag && item.BackdropItemId === item.Id) {
            item.BackdropImageTags = [item.BackdropImageTag];
        }
        if (item.BackdropImageTag && item.BackdropItemId !== item.Id) {
            item.ParentBackdropImageTags = [item.BackdropImageTag];
            item.ParentBackdropItemId = item.BackdropItemId;
        }
    }
}

function getItemsForPlayback(apiClient, query) {
    const userId = apiClient.getCurrentUserId();

    if (query.Ids && query.Ids.split(',').length === 1) {
        return apiClient.getItem(userId, query.Ids.split(',')).then(function (item) {
            return {
                Items: [item],
                TotalRecordCount: 1
            };
        });
    } else {
        query.Limit = query.Limit || 100;
        query.ExcludeLocationTypes = 'Virtual';
        query.EnableTotalRecordCount = false;

        return getItems(apiClient, userId, query);
    }
}

/*
 * relay castPlayer events to ChromecastPlayer events and include state info
 */
function bindEventForRelay(instance, eventName) {
    Events.on(instance._castPlayer, eventName, function (e, data) {
        console.debug('[chromecastPlayer] ' + eventName);
        // skip events without data
        if (data?.ItemId) {
            const state = instance.getPlayerStateInternal(data);
            Events.trigger(instance, eventName, [state]);
        }
    });
}

function initializeChromecast() {
    const instance = this;
    instance._castPlayer?.retire();
    instance._castPlayer = new CastPlayer();

    // To allow the native android app to override
    document.dispatchEvent(new CustomEvent('chromecastloaded', {
        detail: {
            player: instance
        }
    }));

    Events.on(instance._castPlayer, 'connect', function (_event, connection) {
        if (instance._castPlayer?.connection !== connection || !connection.owner.current()) return;
        if (!instance._castPlayer.pending) {
            if (!playbackManager.setOwnedCastPlayer(PlayerName, instance.getCurrentTargetInfo(), connection.owner, connection.selectionRevision)) {
                instance._castPlayer.detachConnection(connection);
                return;
            }
        }

        console.debug('[chromecastPlayer] connect');
        // Reset this so that statechange will fire
        instance.lastPlayerData = null;
    });

    Events.on(instance._castPlayer, 'playbackstart', function (e, data) {
        console.debug('[chromecastPlayer] playbackstart');

        instance._castPlayer.initializeCastPlayer();

        const state = instance.getPlayerStateInternal(data);
        Events.trigger(instance, 'playbackstart', [state]);

        // be prepared that after this media item a next one may follow. See playbackManager
        instance._playNextAfterEnded = true;
    });

    Events.on(instance._castPlayer, 'playbackstop', function (e, data) {
        console.debug('[chromecastPlayer] playbackstop');

        let state = instance.getPlayerStateInternal(data);

        if (!instance._playNextAfterEnded) {
            // mark that no next media items are to be processed.
            state.nextItem = null;
            state.NextMediaType = null;
        }
        Events.trigger(instance, 'playbackstop', [state]);

        state = instance.lastPlayerData.PlayState || {};
        const volume = state.VolumeLevel || 0.5;
        const mute = state.IsMuted || false;

        // Reset this so the next query doesn't make it appear like content is playing.
        instance.lastPlayerData = {
            PlayState: {
                VolumeLevel: volume,
                IsMuted: mute
            }
        };
    });

    Events.on(instance._castPlayer, 'playbackprogress', function (e, data) {
        console.debug('[chromecastPlayer] positionchange');
        const state = instance.getPlayerStateInternal(data);

        Events.trigger(instance, 'timeupdate', [state]);
    });

    bindEventForRelay(instance, 'timeupdate');
    bindEventForRelay(instance, 'pause');
    bindEventForRelay(instance, 'unpause');
    bindEventForRelay(instance, 'volumechange');
    bindEventForRelay(instance, 'repeatmodechange');
    bindEventForRelay(instance, 'shufflequeuemodechange');

    Events.on(instance._castPlayer, 'playstatechange', function (e, data) {
        console.debug('[chromecastPlayer] playstatechange');

        // Updates the player and nowPlayingBar state to the current 'pause' state.
        const state = instance.getPlayerStateInternal(data);
        Events.trigger(instance, 'pause', [state]);
    });
}

class ChromecastPlayer {
    constructor() {
        // playbackManager needs this
        this.name = PlayerName;
        this.type = PluginType.MediaPlayer;
        this.id = 'chromecast';
        this.isLocalPlayer = false;
        this.lastPlayerData = {};

        new CastSenderApi().load().then(() => {
            Events.on(ServerConnections, 'localusersignedin', () => {
                initializeChromecast.call(this);
            });

            if (ServerConnections.currentUserId) {
                initializeChromecast.call(this);
            }
        });
    }

    /*
     * Cast button handling: select and connect to chromecast receiver
     */
    tryPair(_target, attempt) {
        const castPlayer = this._castPlayer;

        if (!castPlayer || castPlayer.deviceState === DEVICE_STATE.ACTIVE) return Promise.reject(new Error('Cast already active'));
        return castPlayer.pair(attempt);
    }

    getConnectionOwner() {
        const connection = this._castPlayer?.connection;
        return this._castPlayer?.currentConnection(connection) ? connection.owner : null;
    }

    getTargets() {
        const targets = [];

        if (this._castPlayer?.hasReceivers && this._castPlayer.initializationOwner?.current()) {
            targets.push(this.getCurrentTargetInfo());
        }

        return Promise.resolve(targets);
    }

    // This is a privately used method
    getCurrentTargetInfo() {
        let appName = null;

        const castPlayer = this._castPlayer;

        if (castPlayer.session?.receiver?.friendlyName) {
            appName = castPlayer.session.receiver.friendlyName;
        }

        return {
            name: PlayerName,
            id: PlayerName,
            playerName: PlayerName,
            playableMediaTypes: ['Audio', 'Video'],
            isLocalPlayer: false,
            appName: PlayerName,
            deviceName: appName,
            deviceType: 'cast',
            supportedCommands: [
                'VolumeUp',
                'VolumeDown',
                'Mute',
                'Unmute',
                'ToggleMute',
                'SetVolume',
                'SetAudioStreamIndex',
                'SetSubtitleStreamIndex',
                'DisplayContent',
                'SetRepeatMode'
            ]
        };
    }

    getPlayerStateInternal(data) {
        let triggerStateChange = false;
        if (data && !this.lastPlayerData) {
            triggerStateChange = true;
        }

        data = data || this.lastPlayerData;
        this.lastPlayerData = data;

        normalizeImages(data);

        if (triggerStateChange) {
            Events.trigger(this, 'statechange', [data]);
        }

        return data;
    }

    loadForConnection(options, command, castPlayer, connection) {
        if (this._castPlayer !== castPlayer || !castPlayer?.currentConnection(connection)) {
            return rejectedDelivery('Cast connection expired');
        }
        return castPlayer.loadMedia(options, command, connection);
    }

    playWithCommand(options, command, castPlayer = this._castPlayer, connection = castPlayer?.connection) {
        if (this._castPlayer !== castPlayer || !castPlayer?.currentConnection(connection)) {
            return rejectedDelivery('Cast connection expired');
        }
        if (options.serverId && options.serverId !== connection.owner.serverId) {
            return rejectedDelivery('Cast item belongs to a different server');
        }
        if (!options.items) {
            const apiClient = ServerConnections.getApiClient(options.serverId);
            return apiClient.getItem(apiClient.getCurrentUserId(), options.ids[0]).then(item =>
                this.playWithCommand({ ...options, items: [item] }, command, castPlayer, connection));
        }

        if (options.items.length > 1 && options?.ids) {
            // Use the original request id array for sorting the result in the proper order
            options.items.sort(function (a, b) {
                return options.ids.indexOf(a.Id) - options.ids.indexOf(b.Id);
            });
        }

        return this.loadForConnection(options, command, castPlayer, connection);
    }

    seek(position) {
        position = parseInt(position, 10);

        position = position / 10000000;

        this._castPlayer.sendMessage({
            options: {
                position: position
            },
            command: 'Seek'
        });
    }

    setAudioStreamIndex(index) {
        this._castPlayer.sendMessage({
            options: {
                index: index
            },
            command: 'SetAudioStreamIndex'
        });
    }

    setSubtitleStreamIndex(index) {
        this._castPlayer.sendMessage({
            options: {
                index: index
            },
            command: 'SetSubtitleStreamIndex'
        });
    }

    setMaxStreamingBitrate(options) {
        this._castPlayer.sendMessage({
            options: options,
            command: 'SetMaxStreamingBitrate'
        });
    }

    isFullscreen() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.IsFullscreen;
    }

    nextTrack() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'NextTrack'
        });
    }

    previousTrack() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'PreviousTrack'
        });
    }

    volumeDown() {
        const castPlayer = this._castPlayer;
        const connection = castPlayer?.connection;
        if (!castPlayer?.currentConnection(connection)) return;
        let vol = connection.session.receiver.volume.level;
        if (vol == null) {
            vol = 0.5;
        }
        vol -= 0.05;
        vol = Math.max(vol, 0);

        if (castPlayer.currentConnection(connection)) connection.session.setReceiverVolumeLevel(vol);
    }

    endSession() {
        const castPlayer = this._castPlayer;
        const connection = castPlayer?.connection;
        if (!castPlayer?.currentConnection(connection)) return;
        this.stop().then(() => {
            setTimeout(() => {
                if (castPlayer.currentConnection(connection)) castPlayer.stopApp();
            }, 1000);
        }).catch(() => undefined);
    }

    volumeUp() {
        const castPlayer = this._castPlayer;
        const connection = castPlayer?.connection;
        if (!castPlayer?.currentConnection(connection)) return;
        let vol = connection.session.receiver.volume.level;
        if (vol == null) {
            vol = 0.5;
        }
        vol += 0.05;
        vol = Math.min(vol, 1);

        if (castPlayer.currentConnection(connection)) connection.session.setReceiverVolumeLevel(vol);
    }

    setVolume(vol) {
        const castPlayer = this._castPlayer;
        const connection = castPlayer?.connection;
        if (!castPlayer?.currentConnection(connection)) return;
        vol = Math.min(vol, 100);
        vol = Math.max(vol, 0);
        vol = vol / 100;

        if (castPlayer.currentConnection(connection)) connection.session.setReceiverVolumeLevel(vol);
    }

    unpause() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'Unpause'
        });
    }

    playPause() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'PlayPause'
        });
    }

    pause() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'Pause'
        });
    }

    stop() {
        // suppress playing a next media item after this one. See playbackManager
        this._playNextAfterEnded = false;
        return this._castPlayer.sendMessage({
            options: {},
            command: 'Stop'
        });
    }

    displayContent(options) {
        this._castPlayer.sendMessage({
            options: options,
            command: 'DisplayContent'
        });
    }

    setMute(isMuted) {
        const castPlayer = this._castPlayer;

        if (isMuted) {
            castPlayer.sendMessage({
                options: {},
                command: 'Mute'
            });
        } else {
            castPlayer.sendMessage({
                options: {},
                command: 'Unmute'
            });
        }
    }

    getRepeatMode() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.RepeatMode;
    }

    getQueueShuffleMode() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.ShuffleMode;
    }

    playTrailers() {
        console.warn('[chromecastPlayer] Playing trailers is not supported.');
    }

    setRepeatMode(mode) {
        this._castPlayer.sendMessage({
            options: {
                RepeatMode: mode
            },
            command: 'SetRepeatMode'
        });
    }

    setQueueShuffleMode() {
        console.warn('[chromecastPlayer] Setting shuffle queue mode is not supported.');
    }

    toggleMute() {
        this._castPlayer.sendMessage({
            options: {},
            command: 'ToggleMute'
        });
    }

    audioTracks() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        const streams = state.MediaStreams || [];
        return streams.filter(function (s) {
            return s.Type === 'Audio';
        });
    }

    getAudioStreamIndex() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.AudioStreamIndex;
    }

    subtitleTracks() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        const streams = state.MediaStreams || [];
        return streams.filter(function (s) {
            return s.Type === 'Subtitle';
        });
    }

    getSubtitleStreamIndex() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.SubtitleStreamIndex;
    }

    getMaxStreamingBitrate() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.MaxStreamingBitrate;
    }

    getVolume() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};

        return state.VolumeLevel == null ? 100 : state.VolumeLevel;
    }

    isPlaying(mediaType) {
        const state = this.lastPlayerData || {};
        return state.NowPlayingItem != null && (state.NowPlayingItem.MediaType === mediaType || !mediaType);
    }

    isPlayingVideo() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.MediaType === 'Video';
    }

    isPlayingAudio() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.MediaType === 'Audio';
    }

    currentTime(val) {
        if (val != null) {
            return this.seek(val * 10000);
        }

        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.PositionTicks / 10000;
    }

    duration() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.RunTimeTicks;
    }

    getBufferedRanges() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.BufferedRanges || [];
    }

    paused() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};

        return state.IsPaused;
    }

    isMuted() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};

        return state.IsMuted;
    }

    shuffle(item) {
        const castPlayer = this._castPlayer;
        const connection = castPlayer?.connection;
        if (!castPlayer?.currentConnection(connection) || connection.owner.serverId !== item.ServerId) return;
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        const userId = apiClient.getCurrentUserId();
        void apiClient.getItem(userId, item.Id).then(fetchedItem => {
            void this.playWithCommand({
                items: [fetchedItem]
            }, 'Shuffle', castPlayer, connection);
        }).catch(() => undefined);
    }

    instantMix(item) {
        const castPlayer = this._castPlayer;
        const connection = castPlayer?.connection;
        if (!castPlayer?.currentConnection(connection) || connection.owner.serverId !== item.ServerId) return;
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        const userId = apiClient.getCurrentUserId();
        void apiClient.getItem(userId, item.Id).then(fetchedItem => {
            void this.playWithCommand({
                items: [fetchedItem]
            }, 'InstantMix', castPlayer, connection);
        }).catch(() => undefined);
    }

    canPlayMediaType(mediaType) {
        mediaType = (mediaType || '').toLowerCase();
        return mediaType === 'audio' || mediaType === 'video';
    }

    canQueueMediaType(mediaType) {
        return this.canPlayMediaType(mediaType);
    }

    queue(options) {
        this.playWithCommand(options, 'PlayLast');
    }

    queueNext(options) {
        this.playWithCommand(options, 'PlayNext');
    }

    /*
     * play
     * options.items[]: Id, IsFolder, MediaType, Name, ServerId, Type, ...
     */
    play(options) {
        if (options.items) {
            return this.playWithCommand(options, 'PlayNow');
        } else {
            if (!options.serverId) {
                throw new Error('serverId required!');
            }

            const castPlayer = this._castPlayer;
            const connection = castPlayer?.connection;
            if (!castPlayer?.currentConnection(connection) || connection.owner.serverId !== options.serverId) {
                return rejectedDelivery('Cast connection expired');
            }
            const apiClient = ServerConnections.getApiClient(options.serverId);

            return getItemsForPlayback(apiClient, {
                Ids: options.ids.join(',')
            }).then(result => this.playWithCommand({ ...options, items: result.Items }, 'PlayNow', castPlayer, connection));
        }
    }

    toggleFullscreen() {
        // not supported
    }

    beginPlayerUpdates() {
        // Setup polling here
    }

    endPlayerUpdates() {
        // Stop polling here
    }

    getPlaylist() {
        return Promise.resolve([]);
    }

    getCurrentPlaylistItemId() {
        // not supported?
    }

    setCurrentPlaylistItem() {
        return Promise.resolve();
    }

    removeFromPlaylist() {
        return Promise.resolve();
    }

    getPlayerState() {
        return this.getPlayerStateInternal() || {};
    }

    getCurrentPlaylistIndex() {
        // tbd: update to support playlists and not only album with tracks
        return this.getPlayerStateInternal()?.NowPlayingItem?.IndexNumber;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    clearQueue(currentTime) {
        // not supported yet
    }
}

export default ChromecastPlayer;

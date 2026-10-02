let generation = 0;
const players = new WeakMap();
const elements = new WeakMap();

export function createPlaybackIdentity(options) {
    if (generation === Number.MAX_SAFE_INTEGER) throw new Error('Playback generation exhausted.');
    return Object.freeze({
        itemId: options.item?.Id,
        playSessionId: options.playSessionId,
        generation: ++generation
    });
}

export function samePlaybackIdentity(left, right) {
    return Boolean(left && right && left.generation === right.generation
        && left.itemId === right.itemId && left.playSessionId === right.playSessionId);
}

export function beginMediaPlayback(player, options) {
    const playback = {
        identity: options.playbackIdentity || createPlaybackIdentity(options),
        ended: false,
        element: null,
        stopPromise: null
    };
    players.set(player, playback);
    return playback;
}

export function bindMediaPlayback(playback, element) {
    if (elements.has(element)) throw new Error('A media element cannot be reused by another playback execution.');
    elements.set(element, playback);
    playback.element = element;
}

export function mediaPlaybackFor(element) {
    return element ? elements.get(element) : undefined;
}

export function captureMediaSettings(element) {
    return element ? {
        volume: mediaPlaybackFor(element)?.restoreVolume ?? element.volume,
        muted: element.muted,
        playbackRate: element.playbackRate
    } : undefined;
}

export function restoreMediaSettings(element, settings) {
    if (settings) Object.assign(element, settings);
}

export function ownsMediaPlayback(player, playback) {
    return Boolean(playback && !playback.ended && players.get(player) === playback);
}

export function finishMediaPlayback(player, playback) {
    const owned = ownsMediaPlayback(player, playback);
    playback.ended = true;
    if (owned) players.delete(player);
    return owned;
}

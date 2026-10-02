const MAX_OPTIONS_BYTES = 64 * 1024;
const MAX_SPLASH_BYTES = 8 * 1024 * 1024;
const RASTER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

function selectedBasePath(address) {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash) throw new Error('Invalid selected server');
    return url.href.replace(/\/$/, '');
}

async function readBody(response, maximum, signal, assertCurrent) {
    if (!response.ok || response.redirected || response.type === 'opaque' || !response.body
        || Number(response.headers.get('Content-Length')) > maximum) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Branding response unavailable');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    let finished = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            assertCurrent();
            if (signal.aborted) throw new Error('Branding request cancelled');
            if (done) {
                finished = true;
                return chunks;
            }
            size += value.byteLength;
            if (size > maximum) throw new Error('Branding response exceeded budget');
            chunks.push(Uint8Array.from(value));
        }
    } finally {
        if (!finished) void reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

async function publicGet(base, path, signal, assertCurrent) {
    assertCurrent();
    const response = await fetch(`${base}${path}`, {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal
    });
    assertCurrent();
    return response;
}

function decodeOptions(bytes, signal) {
    if (window['TextDecoder']) return Promise.resolve(new window['TextDecoder']().decode(bytes));
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const cancel = () => reader.abort();
        const finish = () => signal.removeEventListener('abort', cancel);
        reader.onload = () => {
            finish();
            resolve(String(reader.result));
        };
        reader.onerror = () => {
            finish();
            reject(new Error('Branding options unavailable'));
        };
        reader.onabort = () => {
            finish();
            reject(new Error('Branding request cancelled'));
        };
        signal.addEventListener('abort', cancel, { once: true });
        reader.readAsText(new Blob([bytes]), 'UTF-8');
        if (signal.aborted) cancel();
    });
}

export async function readPublicSplashscreen(address, signal, assertCurrent) {
    const base = selectedBasePath(address);
    const optionsResponse = await publicGet(base, '/Branding/Configuration', signal, assertCurrent);
    const optionsType = optionsResponse.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (optionsType !== 'application/json') {
        void optionsResponse.body?.cancel().catch(() => undefined);
        throw new Error('Branding options unavailable');
    }
    const optionsBytes = await readBody(optionsResponse, MAX_OPTIONS_BYTES, signal, assertCurrent);
    const length = optionsBytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of optionsBytes) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const options = JSON.parse(await decodeOptions(joined, signal));
    assertCurrent();
    if (options?.SplashscreenEnabled !== true) return null;

    const imageResponse = await publicGet(base, '/Branding/Splashscreen', signal, assertCurrent);
    const mime = imageResponse.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (!RASTER_TYPES.has(mime)) {
        void imageResponse.body?.cancel().catch(() => undefined);
        throw new Error('Splashscreen unavailable');
    }
    const imageBytes = await readBody(imageResponse, MAX_SPLASH_BYTES, signal, assertCurrent);
    assertCurrent();
    return new Blob(imageBytes, { type: mime });
}

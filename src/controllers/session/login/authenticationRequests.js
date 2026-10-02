export async function requestManualAuthentication(apiClient, username, password) {
    if (!username) {
        throw new TypeError('A username is required.');
    }

    return apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl('Users/authenticatebyname'),
        data: JSON.stringify({ Username: username, Pw: password || '' }),
        dataType: 'json',
        contentType: 'application/json'
    });
}

export async function requestQuickConnectAuthentication(apiClient, secret) {
    if (!secret) {
        throw new TypeError('A Quick Connect secret is required.');
    }

    return apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl('Users/AuthenticateWithQuickConnect'),
        data: JSON.stringify({ Secret: secret }),
        dataType: 'json',
        contentType: 'application/json'
    });
}

export async function readQuickConnectState(apiClient, secret) {
    if (!secret) {
        throw new TypeError('A Quick Connect secret is required.');
    }

    const headers = { accept: 'application/json' };
    apiClient.setRequestHeaders(headers);
    const url = apiClient.getUrl(`/QuickConnect/Connect?Secret=${encodeURIComponent(secret)}`);
    const response = await fetch(url, {
        method: 'GET',
        headers,
        credentials: 'same-origin'
    });
    if (!response.ok) {
        throw new Error('Quick Connect polling failed.');
    }
    return response.json();
}

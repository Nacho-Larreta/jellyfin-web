import { CancelledError } from '@tanstack/react-query';

import { getBoundUserViewsQuery } from 'utils/jellyfin-apiclient/boundUserViewsQuery';
import { SessionReadCancelledError } from 'utils/jellyfin-apiclient/sessionReadApi';

export function createLibraryMenuViews({
    captureRead,
    prepareDrawer,
    currentDrawer,
    clear,
    renderUser,
    renderViews,
    getLinks,
    renderLinks,
    subscribeAuthority,
    queryClient,
    onError
}) {
    let generation = 0;
    let unsubscribeAuthority;

    const isCurrent = (expected, read, container) => {
        if (expected !== generation || !container?.isConnected || currentDrawer() !== container) return false;
        try {
            read.assertCurrent();
            return true;
        } catch {
            return false;
        }
    };

    const invalidate = () => {
        generation++;
        unsubscribeAuthority?.();
        unsubscribeAuthority = undefined;
        clear();
    };

    const refresh = async () => {
        invalidate();
        const expected = generation;
        let read;
        try {
            read = captureRead();
            read?.assertCurrent();
        } catch {
            return false;
        }
        if (!read) return false;
        try {
            unsubscribeAuthority = subscribeAuthority?.(read, () => {
                if (expected !== generation) return;
                try {
                    read.assertCurrent();
                } catch {
                    invalidate();
                }
            });
        } catch {
            invalidate();
            return false;
        }

        let container;
        try {
            const [ preparedContainer, user ] = await Promise.all([ prepareDrawer(), read.getCurrentUser() ]);
            container = preparedContainer;
            if (!isCurrent(expected, read, container)) return false;
            if (user?.Id !== read.identity.profileUserId
                || user.ServerId && user.ServerId !== read.identity.serverId) {
                throw new SessionReadCancelledError();
            }

            const targets = renderUser(container, user);
            if (!isCurrent(expected, read, container)) return false;

            if (targets.links) {
                void Promise.resolve().then(getLinks).then(links => {
                    if (isCurrent(expected, read, container)
                        && targets.links.isConnected && container.contains(targets.links)) {
                        renderLinks(targets.links, links);
                    }
                }).catch(() => {
                    if (isCurrent(expected, read, container)) onError();
                });
            }

            const result = await queryClient.fetchQuery(getBoundUserViewsQuery(read, user.Id));
            if (isCurrent(expected, read, container)
                && targets.libraries?.isConnected && container.contains(targets.libraries)) {
                renderViews(targets.libraries, result);
                return true;
            }
        } catch (error) {
            if (error instanceof CancelledError || !isCurrent(expected, read, container)) return false;
            onError();
        }
        return false;
    };

    return { refresh, invalidate };
}

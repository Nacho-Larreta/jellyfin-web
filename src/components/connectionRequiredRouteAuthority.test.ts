import { describe, expect, it } from 'vitest';

import {
    RouteValidationAuthority,
    createConnectionRouteKey,
    isAuthorizedRoute
} from './connectionRequiredRouteAuthority';

describe('ConnectionRequired route validation authority', () => {
    it('invalidates route A before an out-of-order result can authorize route B', () => {
        const authority = new RouteValidationAuthority();
        const routeA = createConnectionRouteKey('user', 'a', '/home', '');
        const routeB = createConnectionRouteKey('user', 'b', '/search', '?q=movie');
        const ticketA = authority.begin(routeA);

        authority.observe(routeB);
        const ticketB = authority.begin(routeB);

        expect(authority.isCurrent(ticketA)).toBe(false);
        expect(authority.isCurrent(ticketB)).toBe(true);
    });

    it('rejects an older same-route validation when a newer validation starts', () => {
        const authority = new RouteValidationAuthority();
        const route = createConnectionRouteKey('admin', 'admin-a', '/dashboard', '');
        const first = authority.begin(route);
        const second = authority.begin(route);

        expect(authority.isCurrent(first)).toBe(false);
        expect(authority.isCurrent(second)).toBe(true);
    });

    it('invalidates cleanup tickets so unmounted work cannot authorize an Outlet', () => {
        const authority = new RouteValidationAuthority();
        const ticket = authority.begin(createConnectionRouteKey('user', 'a', '/home', ''));

        authority.invalidate(ticket);

        expect(authority.isCurrent(ticket)).toBe(false);
    });

    it('keeps the Outlet closed after a route transition until that exact key is authorized', () => {
        const routeA = createConnectionRouteKey('user', 'a', '/home', '');
        const routeB = createConnectionRouteKey('user', 'b', '/search', '?q=movie');
        let authorizedRouteKey: string | null = routeA;

        expect(isAuthorizedRoute(routeA, authorizedRouteKey)).toBe(true);
        expect(isAuthorizedRoute(routeB, authorizedRouteKey)).toBe(false);

        authorizedRouteKey = routeB;
        expect(isAuthorizedRoute(routeB, authorizedRouteKey)).toBe(true);
    });
});

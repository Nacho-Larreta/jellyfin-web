import { describe, expect, it } from 'vitest';

import {
    RouteValidationAuthority,
    createConnectionRouteKey,
    isAuthorizedRoute,
    isSearchQueryPresentationTransition
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

    it('admits only a Search query edit as a presentation transition', () => {
        const before = createConnectionRouteKey('user', 'a', '/search', '?genre=Family&query=Ca&parentId=library');
        const after = createConnectionRouteKey('user', 'b', '/search', '?genre=Family&query=Cat&parentId=library');

        expect(isSearchQueryPresentationTransition(before, after)).toBe(true);
        expect(isSearchQueryPresentationTransition(before, createConnectionRouteKey(
            'user', 'c', '/search', '?genre=Family&parentId=library'
        ))).toBe(true);
        expect(isSearchQueryPresentationTransition(before, createConnectionRouteKey(
            'user', 'd', '/search', '?genre=Family&query=Cat&parentId=library&sort=date'
        ))).toBe(false);
        expect(isSearchQueryPresentationTransition(before, createConnectionRouteKey(
            'user', 'e', '/search', '?parentId=library&query=Cat&genre=Family'
        ))).toBe(false);
        expect(isSearchQueryPresentationTransition(before, createConnectionRouteKey(
            'user', 'f', '/search', '?genre=Family&query=Cat&parentId=library&genre=Family'
        ))).toBe(false);
        expect(isSearchQueryPresentationTransition(before, createConnectionRouteKey(
            'admin', 'g', '/search', '?genre=Family&query=Cat&parentId=library'
        ))).toBe(false);
        expect(isSearchQueryPresentationTransition(before, createConnectionRouteKey(
            'user', 'h', '/home', '?genre=Family&query=Cat&parentId=library'
        ))).toBe(false);
        expect(isSearchQueryPresentationTransition(null, after)).toBe(false);
    });

    it('does not let duplicate or reordered parameters conceal another change', () => {
        const before = createConnectionRouteKey('user', 'a', '/search', '?query=Cat&tag=A&tag=B');
        expect(isSearchQueryPresentationTransition(before, createConnectionRouteKey(
            'user', 'b', '/search', '?query=Dog&tag=B&tag=A'
        ))).toBe(false);
        expect(isSearchQueryPresentationTransition(before, createConnectionRouteKey(
            'user', 'c', '/search', '?query=Dog&query=Cat&tag=A&tag=B'
        ))).toBe(false);
    });
});

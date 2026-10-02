export interface RouteValidationTicket {
    readonly routeKey: string;
    readonly generation: number;
}

export class RouteValidationAuthority {
    private routeKey = '';
    private generation = 0;

    observe(routeKey: string): void {
        if (routeKey !== this.routeKey) {
            this.routeKey = routeKey;
            this.generation += 1;
        }
    }

    begin(routeKey: string): RouteValidationTicket {
        this.observe(routeKey);
        this.generation += 1;
        return Object.freeze({ routeKey, generation: this.generation });
    }

    isCurrent(ticket: RouteValidationTicket): boolean {
        return ticket.routeKey === this.routeKey
            && ticket.generation === this.generation;
    }

    invalidate(ticket: RouteValidationTicket): void {
        if (this.isCurrent(ticket)) this.generation += 1;
    }
}

export function createConnectionRouteKey(
    level: string,
    locationKey: string,
    pathname: string,
    search: string
): string {
    return JSON.stringify([ level, locationKey, pathname, search ]);
}

export function isAuthorizedRoute(
    currentRouteKey: string,
    authorizedRouteKey: string | null
): boolean {
    return currentRouteKey === authorizedRouteKey;
}

export function isSearchQueryPresentationTransition(
    authorizedRouteKey: string | null,
    currentRouteKey: string
): boolean {
    if (!authorizedRouteKey) return false;

    let authorized: unknown;
    let current: unknown;
    try {
        authorized = JSON.parse(authorizedRouteKey);
        current = JSON.parse(currentRouteKey);
    } catch {
        return false;
    }

    if (!isRouteIdentity(authorized) || !isRouteIdentity(current)) return false;
    const [ authorizedLevel, , authorizedPath, authorizedSearch ] = authorized;
    const [ currentLevel, , currentPath, currentSearch ] = current;
    if (authorizedLevel !== 'user' || currentLevel !== 'user'
        || authorizedPath !== '/search' || currentPath !== '/search'
        || authorizedSearch === currentSearch) return false;

    const previous = splitSearchQuery(authorizedSearch);
    const next = splitSearchQuery(currentSearch);
    return previous !== null && next !== null
        && previous.otherParameters === next.otherParameters
        && previous.query !== next.query;
}

function isRouteIdentity(value: unknown): value is [string, string, string, string] {
    return Array.isArray(value) && value.length === 4
        && value.every(part => typeof part === 'string');
}

function splitSearchQuery(search: string): { query: string | null; otherParameters: string } | null {
    if (search && !search.startsWith('?')) return null;
    const segments = search ? search.slice(1).split('&') : [];
    const others: string[] = [];
    let query: string | null = null;
    for (const segment of segments) {
        const separator = segment.indexOf('=');
        const rawName = separator < 0 ? segment : segment.slice(0, separator);
        if (new URLSearchParams(`${rawName}=`).has('query')) {
            if (query !== null) return null;
            query = segment;
        } else {
            others.push(segment);
        }
    }

    return { query, otherParameters: others.join('&') };
}

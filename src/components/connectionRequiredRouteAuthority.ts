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

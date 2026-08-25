export const PLAYER_AUTOHIDE_DELAY_MS = 3_000;

type FocusTarget = HTMLElement | undefined;

interface PointerCoordinates {
    readonly clientX?: number;
    readonly clientY?: number;
    readonly pointerType?: string;
    readonly screenX?: number;
    readonly screenY?: number;
}

interface PointerActivityPresentation {
    readonly canAutohide: () => boolean;
    readonly conceal: () => void;
    readonly reveal: (focusTarget?: FocusTarget) => void;
    readonly showCursor: () => void;
}

interface Point {
    readonly x: number;
    readonly y: number;
}

export class PlayerPointerActivityController {
    private autohideTimeout?: ReturnType<typeof setTimeout>;
    private isStarted = false;
    private lastPointerPosition?: Point;

    constructor(private readonly presentation: PointerActivityPresentation) {}

    start() {
        if (this.isStarted) return;

        this.isStarted = true;
        this.lastPointerPosition = undefined;
        this.reveal();
    }

    stop() {
        this.isStarted = false;
        this.lastPointerPosition = undefined;
        this.cancelAutohideClock();
    }

    reveal(focusTarget?: FocusTarget) {
        if (!this.isStarted) return;

        this.presentation.reveal(focusTarget);
        this.resetAutohideClock();
    }

    conceal() {
        if (!this.isStarted) return;

        this.cancelAutohideClock();
        this.presentation.conceal();
    }

    onPointerMove(event: PointerCoordinates) {
        if (!this.isStarted || event.pointerType === 'touch') return false;

        const point = this.getPoint(event);
        if (!point || this.isStationary(point)) return false;

        this.lastPointerPosition = point;
        this.presentation.showCursor();
        this.reveal();
        return true;
    }

    onControlsActivity(focusTarget?: FocusTarget) {
        this.reveal(focusTarget);
    }

    onFullscreenChange() {
        this.reveal();
    }

    resetAutohideClock() {
        this.cancelAutohideClock();

        if (!this.isStarted || !this.presentation.canAutohide()) return;

        this.autohideTimeout = setTimeout(() => {
            this.autohideTimeout = undefined;
            if (this.presentation.canAutohide()) {
                this.presentation.conceal();
            }
        }, PLAYER_AUTOHIDE_DELAY_MS);
    }

    private cancelAutohideClock() {
        if (this.autohideTimeout === undefined) return;

        clearTimeout(this.autohideTimeout);
        this.autohideTimeout = undefined;
    }

    private getPoint(event: PointerCoordinates): Point | undefined {
        const x = event.screenX ?? event.clientX;
        const y = event.screenY ?? event.clientY;

        if (x === undefined || y === undefined) return undefined;

        return { x, y };
    }

    private isStationary(point: Point) {
        return this.lastPointerPosition?.x === point.x
            && this.lastPointerPosition.y === point.y;
    }
}

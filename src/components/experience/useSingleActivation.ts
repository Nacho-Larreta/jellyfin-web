import {
    useCallback,
    useEffect,
    useRef,
    type FocusEvent,
    type KeyboardEvent,
    type MouseEvent,
    type PointerEvent
} from 'react';

type ActivationKey = 'Enter' | ' ';

interface SingleActivationHandlers<T extends HTMLElement> {
    onBlur: (event: FocusEvent<T>) => void;
    onClick: (event: MouseEvent<T>) => void;
    onKeyDown: (event: KeyboardEvent<T>) => void;
    onKeyUp: (event: KeyboardEvent<T>) => void;
    onPointerCancel: (event: PointerEvent<T>) => void;
}

const normalizeActivationKey = (key: string): ActivationKey | null => {
    if (key === 'Enter') return 'Enter';
    if (key === ' ' || key === 'Spacebar') return ' ';
    return null;
};

export const useSingleActivation = <T extends HTMLElement>(
    onActivate: () => void,
    disabled: boolean
): SingleActivationHandlers<T> => {
    const pressedKey = useRef<ActivationKey | null>(null);
    const suppressGeneratedClick = useRef(false);
    const suppressTimer = useRef<number>();

    const cancelPress = useCallback(() => {
        pressedKey.current = null;
    }, []);

    useEffect(() => {
        const cancelWhenHidden = () => {
            if (document.visibilityState !== 'visible') cancelPress();
        };

        window.addEventListener('blur', cancelPress);
        document.addEventListener('visibilitychange', cancelWhenHidden);

        return () => {
            window.removeEventListener('blur', cancelPress);
            document.removeEventListener('visibilitychange', cancelWhenHidden);
            if (suppressTimer.current !== undefined) window.clearTimeout(suppressTimer.current);
        };
    }, [cancelPress]);

    const onKeyDown = useCallback((event: KeyboardEvent<T>) => {
        const key = normalizeActivationKey(event.key);
        if (!key) return;

        event.preventDefault();
        if (disabled || event.repeat || pressedKey.current) return;
        pressedKey.current = key;
    }, [disabled]);

    const onKeyUp = useCallback((event: KeyboardEvent<T>) => {
        const key = normalizeActivationKey(event.key);
        if (!key || pressedKey.current !== key) return;

        event.preventDefault();
        pressedKey.current = null;
        if (disabled) return;

        suppressGeneratedClick.current = true;
        if (suppressTimer.current !== undefined) window.clearTimeout(suppressTimer.current);
        suppressTimer.current = window.setTimeout(() => {
            suppressGeneratedClick.current = false;
        }, 0);
        onActivate();
    }, [disabled, onActivate]);

    const onClick = useCallback((event: MouseEvent<T>) => {
        if (disabled || suppressGeneratedClick.current) {
            event.preventDefault();
            suppressGeneratedClick.current = false;
            return;
        }

        onActivate();
    }, [disabled, onActivate]);

    const onBlur = useCallback(() => {
        cancelPress();
    }, [cancelPress]);
    const onPointerCancel = useCallback(() => {
        cancelPress();
    }, [cancelPress]);

    return { onBlur, onClick, onKeyDown, onKeyUp, onPointerCancel };
};

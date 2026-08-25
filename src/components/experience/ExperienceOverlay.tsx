import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import React, { type FC, type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';

import './experiencePrimitives.scss';

export type ExperienceOverlayCloseReason = 'back' | 'escape' | 'outside' | 'request';

const EMPTY_RESTORE_IDS: readonly string[] = [];

interface ExperienceOverlayProps {
    actions?: ReactNode;
    children: ReactNode;
    description?: string;
    initialFocusId?: string;
    label: string;
    onClose: (reason: ExperienceOverlayCloseReason) => void;
    open: boolean;
    restoreFallbackIds?: readonly string[];
    triggerId: string;
}

const isFocusable = (element: HTMLElement | null): element is HTMLElement => Boolean(
    element
    && !element.hasAttribute('disabled')
    && element.getAttribute('aria-disabled') !== 'true'
);

const findNearestFocusableSibling = (trigger: HTMLElement | null): HTMLElement | null => {
    const siblings = trigger?.parentElement?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!siblings?.length) return null;

    const triggerIndex = Array.from(siblings).indexOf(trigger as HTMLElement);
    return siblings[Math.max(0, triggerIndex - 1)] || siblings[Math.min(siblings.length - 1, triggerIndex + 1)] || null;
};

export const ExperienceOverlay: FC<ExperienceOverlayProps> = ({
    actions,
    children,
    description,
    initialFocusId,
    label,
    onClose,
    open,
    restoreFallbackIds = EMPTY_RESTORE_IDS,
    triggerId
}) => {
    const wasOpen = useRef(false);
    const triggerAtOpen = useRef<HTMLElement | null>(null);
    const focusInitialControl = useCallback(() => {
        if (initialFocusId) document.getElementById(initialFocusId)?.focus();
    }, [initialFocusId]);
    const transitionProps = useMemo(() => ({
        onEntered: focusInitialControl
    }), [focusInitialControl]);
    const dialogSlotProps = useMemo(() => ({
        transition: transitionProps
    }), [transitionProps]);

    useEffect(() => {
        if (open && !wasOpen.current) {
            triggerAtOpen.current = document.getElementById(triggerId);
            wasOpen.current = true;
        }

        if (!open && wasOpen.current) {
            wasOpen.current = false;
            const restoreCandidates = [
                document.getElementById(triggerId),
                findNearestFocusableSibling(triggerAtOpen.current),
                ...restoreFallbackIds.map(id => document.getElementById(id))
            ];

            window.requestAnimationFrame(() => {
                restoreCandidates.find(isFocusable)?.focus();
            });
        }
    }, [open, restoreFallbackIds, triggerId]);

    useEffect(() => {
        if (!open || !initialFocusId) return;
        const animationFrame = window.requestAnimationFrame(focusInitialControl);
        return () => window.cancelAnimationFrame(animationFrame);
    }, [focusInitialControl, initialFocusId, open]);

    const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'GoBack' && event.key !== 'BrowserBack') return;
        event.preventDefault();
        event.stopPropagation();
        onClose('back');
    }, [onClose]);

    const onDialogClose = useCallback((
        _event: object,
        reason: 'backdropClick' | 'escapeKeyDown'
    ) => onClose(reason === 'escapeKeyDown' ? 'escape' : 'outside'), [onClose]);

    return (
        <Dialog
            aria-describedby={description ? `${triggerId}-overlay-description` : undefined}
            aria-labelledby={`${triggerId}-overlay-title`}
            className='experience-overlay'
            fullWidth
            maxWidth='sm'
            onClose={onDialogClose}
            onKeyDown={onKeyDown}
            open={open}
            slotProps={dialogSlotProps}
        >
            <DialogTitle id={`${triggerId}-overlay-title`}>{label}</DialogTitle>
            <DialogContent>
                {description ? <p id={`${triggerId}-overlay-description`}>{description}</p> : null}
                {children}
            </DialogContent>
            {actions ? <DialogActions>{actions}</DialogActions> : null}
        </Dialog>
    );
};

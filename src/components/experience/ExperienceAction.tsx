import Button, { type ButtonProps } from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import type { Theme } from '@mui/material/styles';
import type { SystemStyleObject } from '@mui/system';
import React, { type FC, type ReactNode, useCallback } from 'react';

import { isExperienceControlDisabled, type ExperienceAvailability, type ExperienceSize } from './types';
import { useSingleActivation } from './useSingleActivation';
import './experiencePrimitives.scss';

export type ExperienceActionVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';

interface ExperienceActionColors {
    container: string;
    content: string;
}

interface ExperienceActionProps extends Omit<ButtonProps, 'aria-label' | 'children' | 'color' | 'disabled' | 'onClick' | 'size' | 'variant'> {
    availability?: ExperienceAvailability;
    icon?: ReactNode;
    label: string;
    onActivate: () => void;
    presentation?: 'labelled' | 'icon-only';
    selected?: boolean;
    size?: ExperienceSize;
    variant?: ExperienceActionVariant;
}

const MUI_SIZE: Record<ExperienceSize, ButtonProps['size']> = {
    small: 'small',
    medium: 'medium',
    large: 'large'
};

const getActionColors = (theme: Theme, variant: ExperienceActionVariant): ExperienceActionColors => {
    const { action } = theme.vars.palette.semantic;
    switch (variant) {
        case 'primary':
            return { container: action.primary.container, content: action.primary.onPrimary };
        case 'secondary':
            return { container: action.secondary.container, content: action.secondary.onSecondary };
        case 'tertiary':
            return { container: action.tertiary.container, content: action.tertiary.onTertiary };
        case 'destructive':
            return { container: action.destructive.container, content: action.destructive.onDestructive };
    }
};

const getActionSx = (theme: Theme, variant: ExperienceActionVariant): SystemStyleObject<Theme> => {
    const semantic = theme.vars.palette.semantic;
    const colors = getActionColors(theme, variant);

    return {
        backgroundColor: colors.container,
        color: colors.content,
        '@media (prefers-reduced-motion: reduce)': {
            transitionDuration: theme.vars.semantic.motion.reduced.decorativeDuration
        },
        '&[aria-pressed="true"]': {
            backgroundColor: semantic.state.selected.container,
            color: semantic.state.selected.onSelected
        }
    };
};

export const ExperienceAction: FC<ExperienceActionProps> = ({
    availability = 'ready',
    icon,
    label,
    onActivate,
    presentation = 'labelled',
    selected,
    size = 'medium',
    variant = 'primary',
    ...buttonProps
}) => {
    const disabled = isExperienceControlDisabled(availability);
    const activation = useSingleActivation<HTMLButtonElement>(onActivate, disabled);
    const isLoading = availability === 'loading';
    const actionSx = useCallback((theme: Theme) => getActionSx(theme, variant), [variant]);

    return (
        <Button
            {...buttonProps}
            {...activation}
            aria-busy={isLoading || undefined}
            aria-label={presentation === 'icon-only' ? label : undefined}
            aria-pressed={selected}
            className={`experience-action experience-action--${variant}`}
            data-availability={availability}
            disabled={disabled}
            size={MUI_SIZE[size]}
            startIcon={presentation === 'labelled' ? icon : undefined}
            sx={actionSx}
            variant={variant === 'tertiary' ? 'text' : 'contained'}
        >
            {isLoading ? <CircularProgress aria-hidden size='1em' /> : null}
            {presentation === 'icon-only' ? icon : label}
        </Button>
    );
};

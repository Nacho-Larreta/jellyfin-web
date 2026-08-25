import React, { type CSSProperties, type FC } from 'react';

import './experiencePrimitives.scss';

interface ExperienceProgressStyle extends CSSProperties {
    '--jf-component-progress-buffered': string;
    '--jf-component-progress-played': string;
}

interface ExperienceProgressProps {
    bufferedValue?: number;
    label: string;
    max?: number;
    state?: 'ready' | 'loading' | 'error';
    value?: number;
}

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

export const ExperienceProgress: FC<ExperienceProgressProps> = ({
    bufferedValue = 0,
    label,
    max = 100,
    state = 'ready',
    value = 0
}) => {
    const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
    const safeValue = clamp(Number.isFinite(value) ? value : 0, safeMax);
    const safeBuffered = clamp(Number.isFinite(bufferedValue) ? bufferedValue : 0, safeMax);
    const style: ExperienceProgressStyle = {
        '--jf-component-progress-buffered': `${(safeBuffered / safeMax) * 100}%`,
        '--jf-component-progress-played': `${(safeValue / safeMax) * 100}%`
    };

    if (state === 'error') {
        return <span className='experience-progress__error' role='alert'>{label}</span>;
    }

    return (
        <span
            aria-busy={state === 'loading' || undefined}
            aria-label={label}
            aria-valuemax={safeMax}
            aria-valuemin={0}
            aria-valuenow={state === 'loading' ? undefined : safeValue}
            aria-valuetext={state === 'loading' ? 'Loading' : `${Math.round((safeValue / safeMax) * 100)}%`}
            className='experience-progress'
            data-state={state}
            role='progressbar'
            style={style}
        >
            <span aria-hidden className='experience-progress__buffered' />
            <span aria-hidden className='experience-progress__played' />
        </span>
    );
};

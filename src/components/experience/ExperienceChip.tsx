import React, { type FC } from 'react';

import { isExperienceControlDisabled, type ExperienceAvailability, type ExperienceSize } from './types';
import { useSingleActivation } from './useSingleActivation';
import './experiencePrimitives.scss';

interface ExperienceChipProps {
    availability?: ExperienceAvailability;
    count?: number;
    id?: string;
    label: string;
    onActivate: () => void;
    selected?: boolean;
    size?: ExperienceSize;
}

export const ExperienceChip: FC<ExperienceChipProps> = ({
    availability = 'ready',
    count,
    id,
    label,
    onActivate,
    selected = false,
    size = 'medium'
}) => {
    const disabled = isExperienceControlDisabled(availability);
    const activation = useSingleActivation<HTMLButtonElement>(onActivate, disabled);

    return (
        <button
            {...activation}
            aria-pressed={selected}
            className={`experience-chip experience-chip--${size}`}
            data-availability={availability}
            disabled={disabled}
            id={id}
            type='button'
        >
            <span>{label}</span>
            {count === undefined ? null : <span aria-label={`${count} items`} className='experience-chip__count'>{count}</span>}
        </button>
    );
};

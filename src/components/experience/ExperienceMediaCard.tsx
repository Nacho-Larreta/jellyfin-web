import React, { type FC } from 'react';

import { ExperienceAvatar } from './ExperienceAvatar';
import { ExperienceProgress } from './ExperienceProgress';
import { isExperienceControlDisabled, type ExperienceAvailability } from './types';
import { useSingleActivation } from './useSingleActivation';
import './experiencePrimitives.scss';

interface ExperienceMediaCardImage {
    src?: string;
}

interface ExperienceMediaCardProgress {
    bufferedValue?: number;
    label: string;
    max?: number;
    value: number;
}

type ExperienceMediaAvailability = ExperienceAvailability | 'empty';

interface ExperienceMediaCardProps {
    active?: boolean;
    availability?: ExperienceMediaAvailability;
    image?: ExperienceMediaCardImage;
    label?: string;
    onActivate: () => void;
    progress?: ExperienceMediaCardProgress;
    selected?: boolean;
    subtitle?: string;
    title: string;
}

const STATUS_COPY: Partial<Record<ExperienceMediaAvailability, string>> = {
    empty: 'No media available',
    error: 'Media unavailable',
    loading: 'Loading media'
};

const getRestrictionCopy = (availability: ExperienceMediaCardProps['availability']): string | null => {
    if (availability === 'locked') return 'Locked';
    if (availability === 'restricted') return 'Restricted';
    return null;
};

export const ExperienceMediaCard: FC<ExperienceMediaCardProps> = ({
    active = false,
    availability = 'ready',
    image,
    label,
    onActivate,
    progress,
    selected = false,
    subtitle,
    title
}) => {
    const statusCopy = STATUS_COPY[availability];
    const disabled = availability === 'empty' || isExperienceControlDisabled(availability);
    const activation = useSingleActivation<HTMLButtonElement>(onActivate, disabled);
    const restrictionCopy = getRestrictionCopy(availability);
    const accessibleName = label || [ title, subtitle, restrictionCopy, active ? 'Playing' : null ].filter(Boolean).join(', ');

    if (statusCopy) {
        return (
            <article
                aria-busy={availability === 'loading' || undefined}
                className='experience-media-card experience-media-card--placeholder'
                data-availability={availability}
                role={availability === 'error' ? 'alert' : 'status'}
            >
                {statusCopy}
            </article>
        );
    }

    return (
        <article className='experience-media-card' data-availability={availability}>
            <button
                {...activation}
                aria-label={accessibleName}
                aria-pressed={selected}
                className='experience-media-card__control'
                data-active={active || undefined}
                disabled={disabled}
                type='button'
            >
                <span className='experience-media-card__artwork'>
                    <ExperienceAvatar decorative name={title} size='large' src={image?.src} />
                    {restrictionCopy ? <span className='experience-media-card__badge'>{restrictionCopy}</span> : null}
                    {active ? <span className='experience-media-card__badge experience-media-card__badge--active'>Playing</span> : null}
                </span>
                <span className='experience-media-card__body'>
                    <span className='experience-media-card__title'>{title}</span>
                    {subtitle ? <span className='experience-media-card__subtitle'>{subtitle}</span> : null}
                    {progress ? <ExperienceProgress {...progress} /> : null}
                </span>
            </button>
        </article>
    );
};

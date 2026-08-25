import React, { type FC, useCallback, useState } from 'react';

import type { ExperienceAvailability, ExperienceSize } from './types';
import './experiencePrimitives.scss';

interface ExperienceAvatarProps {
    availability?: Extract<ExperienceAvailability, 'ready' | 'loading' | 'locked' | 'restricted' | 'error'>;
    decorative?: boolean;
    name: string;
    size?: ExperienceSize;
    src?: string;
}

const getInitials = (name: string): string => name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('') || '?';

const getAvatarStateLabel = (availability: ExperienceAvatarProps['availability']): string | null => {
    if (availability === 'locked') return 'Locked';
    if (availability === 'restricted') return 'Restricted';
    return null;
};

export const ExperienceAvatar: FC<ExperienceAvatarProps> = ({
    availability = 'ready',
    decorative = false,
    name,
    size = 'medium',
    src
}) => {
    const [imageFailed, setImageFailed] = useState(false);
    const showImage = Boolean(src) && !imageFailed && availability !== 'error';
    const stateLabel = getAvatarStateLabel(availability);
    const onImageError = useCallback(() => setImageFailed(true), []);

    return (
        <span
            aria-hidden={decorative || undefined}
            aria-label={decorative ? undefined : [ name, stateLabel ].filter(Boolean).join(', ')}
            className={`experience-avatar experience-avatar--${size}`}
            data-availability={availability}
            role={decorative ? undefined : 'img'}
        >
            {showImage ? (
                <img
                    alt=''
                    className='experience-avatar__image'
                    onError={onImageError}
                    src={src}
                />
            ) : (
                <span aria-hidden className='experience-avatar__initials'>{getInitials(name)}</span>
            )}
            {stateLabel ? <span aria-hidden className='clipForScreenReader'>{stateLabel}</span> : null}
        </span>
    );
};

export type ExperienceAvailability =
    | 'ready'
    | 'loading'
    | 'disabled'
    | 'restricted'
    | 'locked'
    | 'error';

export type ExperienceSize = 'small' | 'medium' | 'large';

export const isExperienceControlDisabled = (
    availability: ExperienceAvailability
): boolean => availability === 'disabled' || availability === 'loading' || availability === 'error';

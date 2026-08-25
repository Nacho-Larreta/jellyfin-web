export const SEMANTIC_REFERENCE_TOKENS = {
    brandAccent: '#e50914',
    motion: {
        duration: {
            base: '200ms',
            fast: '120ms',
            hero: '700ms',
            slow: '400ms'
        },
        easing: {
            enter: 'cubic-bezier(0, 0, 0.2, 1)',
            standard: 'cubic-bezier(0.4, 0, 0.2, 1)'
        },
        reduced: {
            decorativeDuration: '0ms',
            transform: 'none'
        }
    },
    overlayScrim: 'rgba(0, 0, 0, 0.7)',
    protection: {
        bottom: 'linear-gradient(0deg, rgba(0, 0, 0, 0.95) 0%, rgba(0, 0, 0, 0) 100%)',
        side: 'linear-gradient(90deg, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0) 60%)',
        top: 'linear-gradient(180deg, rgba(0, 0, 0, 0.7) 0%, rgba(0, 0, 0, 0) 100%)'
    },
    shape: {
        extraLarge: '1rem',
        extraSmall: '0.125rem',
        full: '999px',
        large: '0.5rem',
        medium: '0.375rem',
        none: '0'
    },
    space: {
        0: '0',
        1: '0.25rem',
        2: '0.5rem',
        3: '0.75rem',
        4: '1rem',
        5: '1.5rem',
        6: '2rem',
        7: '2.5rem',
        8: '3.5rem',
        9: '5rem'
    },
    transparent: 'transparent'
} as const;

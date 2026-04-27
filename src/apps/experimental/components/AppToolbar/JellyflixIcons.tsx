import SvgIcon, { SvgIconProps } from '@mui/material/SvgIcon';
import React, { type FC } from 'react';

const iconProps = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    strokeWidth: 2
} as const;

export const JellyflixSearchIcon: FC<SvgIconProps> = props => (
    <SvgIcon
        viewBox='0 0 24 24'
        {...props}
    >
        <g {...iconProps}>
            <circle
                cx='11'
                cy='11'
                r='7'
            />
            <path d='m20 20-3-3' />
        </g>
    </SvgIcon>
);

export const JellyflixUsersIcon: FC<SvgIconProps> = props => (
    <SvgIcon
        viewBox='0 0 24 24'
        {...props}
    >
        <g {...iconProps}>
            <circle
                cx='9'
                cy='8'
                r='3.5'
            />
            <circle
                cx='17'
                cy='9'
                r='2.5'
            />
            <path d='M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6' />
            <path d='M15 20c0-2 1.3-4 3-4s3 1 3 4' />
        </g>
    </SvgIcon>
);

export const JellyflixCastIcon: FC<SvgIconProps> = props => (
    <SvgIcon
        viewBox='0 0 24 24'
        {...props}
    >
        <g {...iconProps}>
            <path d='M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7' />
            <path d='M3 14a6 6 0 0 1 6 6' />
            <path d='M3 18a2 2 0 0 1 2 2' />
        </g>
    </SvgIcon>
);

export const JellyflixBellIcon: FC<SvgIconProps> = props => (
    <SvgIcon
        viewBox='0 0 24 24'
        {...props}
    >
        <g {...iconProps}>
            <path d='M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9z' />
            <path d='M10 21a2 2 0 0 0 4 0' />
        </g>
    </SvgIcon>
);

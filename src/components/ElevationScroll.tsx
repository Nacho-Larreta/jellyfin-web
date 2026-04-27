import useScrollTrigger from '@mui/material/useScrollTrigger';
import React, { ReactElement } from 'react';

/**
 * Component that changes the elevation of a child component when scrolled.
 */
interface ElevationScrollProps {
    children: ReactElement
    elevate?: boolean
    threshold?: number
}

const ElevationScroll = ({ children, elevate = false, threshold = 0 }: ElevationScrollProps) => {
    const trigger = useScrollTrigger({
        disableHysteresis: true,
        threshold
    });

    const isElevated = elevate || trigger;

    return React.cloneElement(children, {
        color: isElevated ? 'default' : 'transparent',
        elevation: isElevated ? 4 : 0
    });
};

export default ElevationScroll;

import React, { FC, useEffect, useRef } from 'react';

interface AppHeaderParams {
    isHidden?: boolean
}

const AppHeader: FC<AppHeaderParams> = ({
    isHidden = false
}) => {
    const header = useRef<HTMLDivElement>(null);
    const drawer = useRef<HTMLDivElement>(null);
    const drawerHandle = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let active = true;
        let unmount: (() => void) | undefined;
        void import('../scripts/libraryMenu').then(({ mountHeader }) => {
            if (active && header.current && drawer.current && drawerHandle.current) {
                unmount = mountHeader(header.current, drawer.current, drawerHandle.current);
            }
        });
        return () => {
            active = false;
            unmount?.();
        };
    }, []);

    return (
        /**
         * NOTE: These components are not used with the new layouts, but legacy views interact with the elements
         * directly so they need to be present in the DOM. We use display: none to hide them and prevent errors.
         */
        <div style={isHidden ? { display: 'none' } : undefined}>
            <div ref={drawer} className='mainDrawer hide'>
                <div className='mainDrawer-scrollContainer scrollContainer focuscontainer-y' />
            </div>
            <div ref={header} className='skinHeader focuscontainer-x' />
            <div ref={drawerHandle} className='mainDrawerHandle' />
        </div>
    );
};

export default AppHeader;

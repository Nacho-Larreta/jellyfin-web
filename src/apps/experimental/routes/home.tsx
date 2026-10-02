import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import globalize from '../../../lib/globalize';
import { clearBackdrop } from '../../../components/backdrop/backdrop';
import layoutManager from '../../../components/layoutManager';
import Page from '../../../components/Page';
import { EventType } from 'constants/eventType';
import Events from 'utils/events';

import '../../../elements/emby-tabs/emby-tabs';
import '../../../elements/emby-button/emby-button';
import '../../../elements/emby-scroller/emby-scroller';

type OnResumeOptions = {
    autoFocus?: boolean;
    refresh?: boolean
};

type ControllerProps = {
    onResume: (
        options: OnResumeOptions
    ) => void;
    refreshed: boolean;
    onPause: () => void;
    destroy: () => void;
};

const Home = () => {
    const [ searchParams ] = useSearchParams();
    const initialTabIndex = parseInt(searchParams.get('tab') ?? '0', 10);

    const libraryMenu = useMemo(async () => ((await import('../../../scripts/libraryMenu')).default), []);
    const mainTabsManager = useMemo(() => import('../../../components/maintabsmanager'), []);
    const tabController = useRef<ControllerProps | null>();
    const tabControllers = useMemo<ControllerProps[]>(() => [], []);

    const documentRef = useRef<Document>(document);
    const element = useRef<HTMLDivElement>(null);

    const setTitle = useCallback(async () => {
        (await libraryMenu).setTitle(null);
    }, [ libraryMenu ]);

    const getTabs = () => {
        return [{
            name: globalize.translate('Home')
        }, {
            name: globalize.translate('Favorites')
        }];
    };

    const getTabContainers = () => {
        return element.current?.querySelectorAll('.tabContent');
    };

    const getTabController = useCallback((index: number) => {
        if (index == null) {
            throw new Error('index cannot be null');
        }
        const homeElement = element.current;
        if (!homeElement?.isConnected) return Promise.resolve(null);

        let depends = '';

        switch (index) {
            case 0:
                depends = 'hometab';
                break;

            case 1:
                depends = 'favorites';
        }

        return import(/* webpackChunkName: "[request]" */ `../../../controllers/${depends}`).then(({ default: ControllerFactory }) => {
            if (element.current !== homeElement || !homeElement.isConnected) return null;
            let controller = tabControllers[index];

            if (!controller) {
                const tabContent = homeElement.querySelector(".tabContent[data-index='" + index + "']");
                if (!tabContent) return null;
                controller = new ControllerFactory(tabContent, null);
                tabControllers[index] = controller;
            }

            return controller;
        });
    }, [ tabControllers ]);

    const loadTab = useCallback((index: number, previousIndex: number | null) => {
        const homeElement = element.current;
        if (!homeElement?.isConnected) return;
        getTabController(index).then((controller) => {
            if (!controller || element.current !== homeElement || !homeElement.isConnected) return;
            const refresh = !controller.refreshed;

            controller.onResume({
                autoFocus: previousIndex == null && layoutManager.tv,
                refresh: refresh
            });

            controller.refreshed = true;
            tabController.current = controller;
        }).catch(err => {
            console.error('[Home] failed to get tab controller', err);
        });
    }, [ getTabController ]);

    const onTabChange = useCallback((e: { detail: { selectedTabIndex: string; previousIndex: number | null }; }) => {
        const newIndex = parseInt(e.detail.selectedTabIndex, 10);
        const previousIndex = e.detail.previousIndex;

        const previousTabController = previousIndex == null ? null : tabControllers[previousIndex];
        if (previousTabController?.onPause) {
            previousTabController.onPause();
        }

        loadTab(newIndex, previousIndex);
    }, [ loadTab, tabControllers ]);

    const onSetTabs = useCallback(async () => {
        const homeElement = element.current;
        if (!homeElement?.isConnected) return;
        const tabsManager = await mainTabsManager;
        if (element.current !== homeElement || !homeElement.isConnected) return;
        tabsManager.setTabs(homeElement, initialTabIndex, getTabs, getTabContainers, null, onTabChange, false);
    }, [ initialTabIndex, mainTabsManager, onTabChange ]);

    const onResume = useCallback(async () => {
        const homeElement = element.current;
        if (!homeElement?.isConnected) return;
        void setTitle();
        clearBackdrop();

        const currentTabController = tabController.current;

        if (!currentTabController) {
            const tabsManager = await mainTabsManager;
            if (element.current !== homeElement || !homeElement.isConnected) return;
            tabsManager.selectedTabIndex(initialTabIndex);
        } else if (currentTabController?.onResume) {
            currentTabController.onResume({});
        }
        if (element.current !== homeElement || !homeElement.isConnected) return;
        documentRef.current.querySelector('.skinHeader')?.classList.add('noHomeButtonHeader');
    }, [ initialTabIndex, mainTabsManager, setTitle ]);

    const onPause = useCallback(() => {
        const currentTabController = tabController.current;
        if (currentTabController?.onPause) {
            currentTabController.onPause();
        }
        documentRef.current.querySelector('.skinHeader')?.classList.remove('noHomeButtonHeader');
    }, []);

    const renderHome = useCallback(() => {
        void onSetTabs();
        void onResume();
    }, [ onResume, onSetTabs ]);

    useEffect(() => {
        if (documentRef.current?.querySelector('.headerTabs')) {
            renderHome();
        }

        return () => {
            onPause();
        };
    }, [onPause, renderHome]);

    useEffect(() => {
        const doc = documentRef.current;
        if (doc) Events.on(doc, EventType.HEADER_RENDERED, renderHome);

        return () => {
            if (doc) Events.off(doc, EventType.HEADER_RENDERED, renderHome);
        };
    }, [ renderHome ]);

    return (
        <div ref={element}>
            <Page
                id='indexPage'
                className='mainAnimatedPage homePage libraryPage allLibraryPage backdropPage pageWithAbsoluteTabs withTabs'
                isBackButtonEnabled={false}
                backDropType='movie,series,book'
            >
                <div className='tabContent pageTabContent' id='homeTab' data-index='0'>
                    <div className='tvHomeHero hide'></div>
                    <div className='tvHomeDashboard hide'></div>
                    <div className='sections'></div>
                </div>
                <div className='tabContent pageTabContent' id='favoritesTab' data-index='1'>
                    <div className='sections'></div>
                </div>
            </Page>
        </div>
    );
};

export default Home;

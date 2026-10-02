import dom from '../utils/dom';
import browser from '../scripts/browser';
import Events from '../utils/events.ts';
import '../elements/emby-tabs/emby-tabs';
import '../elements/emby-button/emby-button';

let tabOwnerView;
let headerTabsContainer;
let tabsElem;
let managedHeaderTabsContainer;

export function bindHeaderTabs(container) {
    managedHeaderTabsContainer = container;
    ensureElements();
}

export function clearHeaderTabs(container) {
    if (managedHeaderTabsContainer !== container) return;
    container.innerHTML = '';
    container.classList.add('hide');
    document.body.classList.remove('withSectionTabs');
    managedHeaderTabsContainer = null;
    ensureElements();
}

function ensureElements() {
    const currentContainer = managedHeaderTabsContainer === undefined ?
        document.querySelector('.skinHeader .headerTabs') :
        managedHeaderTabsContainer;
    if (headerTabsContainer !== currentContainer) {
        headerTabsContainer = currentContainer;
        tabOwnerView = null;
        tabsElem = null;
    }
}

function onViewTabsReady() {
    this.selectedIndex(this.readySelectedIndex);
    this.readySelectedIndex = null;
}

function allowSwipe(target) {
    function allowSwipeOn(elem) {
        if (dom.parentWithTag(elem, 'input')) {
            return false;
        }

        const classList = elem.classList;
        if (classList) {
            return !classList.contains('scrollX') && !classList.contains('animatedScrollX');
        }

        return true;
    }

    let parent = target;
    while (parent != null) {
        if (!allowSwipeOn(parent)) {
            return false;
        }
        parent = parent.parentNode;
    }

    return true;
}

function configureSwipeTabs(view, currentElement) {
    if (!browser.touch) {
        return;
    }

    // implement without hammer
    const onSwipeLeft = function (e, target) {
        if (allowSwipe(target) && view.contains(target)) {
            currentElement.selectNext();
        }
    };

    const onSwipeRight = function (e, target) {
        if (allowSwipe(target) && view.contains(target)) {
            currentElement.selectPrevious();
        }
    };

    import('../scripts/touchHelper').then(({ default: TouchHelper }) => {
        const touchHelper = new TouchHelper(view.parentNode.parentNode);

        Events.on(touchHelper, 'swipeleft', onSwipeLeft);
        Events.on(touchHelper, 'swiperight', onSwipeRight);

        view.addEventListener('viewdestroy', function () {
            touchHelper.destroy();
        });
    });
}

export function setTabs(view, selectedIndex, getTabsFn, getTabContainersFn, onBeforeTabChange, onTabChange, setSelectedIndex) {
    ensureElements();

    if (!headerTabsContainer) {
        return { tabsContainer: null, replaced: false };
    }

    if (!view) {
        if (tabOwnerView) {
            document.body.classList.remove('withSectionTabs');

            headerTabsContainer.innerHTML = '';
            headerTabsContainer.classList.add('hide');

            tabOwnerView = null;
        }
        return {
            tabsContainer: headerTabsContainer,
            replaced: false
        };
    }

    const tabsContainerElem = headerTabsContainer;

    if (!tabOwnerView) {
        tabsContainerElem.classList.remove('hide');
    }

    if (tabOwnerView !== view) {
        let index = 0;

        const indexAttribute = selectedIndex == null ? '' : (' data-index="' + selectedIndex + '"');
        const tabsHtml = '<div is="emby-tabs"' + indexAttribute + ' class="tabs-viewmenubar"><div class="emby-tabs-slider" style="white-space:nowrap;">' + getTabsFn().map(function (t) {
            let tabClass = 'emby-tab-button';

            if (t.enabled === false) {
                tabClass += ' hide';
            }

            let tabHtml;

            if (t.cssClass) {
                tabClass += ' ' + t.cssClass;
            }

            if (t.href) {
                tabHtml = '<a href="' + t.href + '" is="emby-linkbutton" class="' + tabClass + '" data-index="' + index + '"><div class="emby-button-foreground">' + t.name + '</div></a>';
            } else {
                tabHtml = '<button type="button" is="emby-button" class="' + tabClass + '" data-index="' + index + '"><div class="emby-button-foreground">' + t.name + '</div></button>';
            }

            index++;
            return tabHtml;
        }).join('') + '</div></div>';

        tabsContainerElem.innerHTML = tabsHtml;
        window.CustomElements.upgradeSubtree(tabsContainerElem);

        document.body.classList.add('withSectionTabs');
        tabOwnerView = view;

        tabsElem = tabsContainerElem.querySelector('[is="emby-tabs"]');

        configureSwipeTabs(view, tabsElem);

        if (getTabContainersFn) {
            tabsElem.addEventListener('beforetabchange', function (e) {
                const tabContainers = getTabContainersFn();
                if (e.detail.previousIndex != null) {
                    const previousPanel = tabContainers[e.detail.previousIndex];
                    if (previousPanel) {
                        previousPanel.classList.remove('is-active');
                    }
                }

                const newPanel = tabContainers[e.detail.selectedTabIndex];

                if (newPanel) {
                    newPanel.classList.add('is-active');
                }
            });
        }

        if (onBeforeTabChange) {
            tabsElem.addEventListener('beforetabchange', onBeforeTabChange);
        }
        if (onTabChange) {
            tabsElem.addEventListener('tabchange', onTabChange);
        }

        if (setSelectedIndex !== false) {
            if (tabsElem.selectedIndex) {
                tabsElem.selectedIndex(selectedIndex);
            } else {
                tabsElem.readySelectedIndex = selectedIndex;
                tabsElem.addEventListener('ready', onViewTabsReady);
            }
        }

        return {
            tabsContainer: tabsContainerElem,
            tabs: tabsElem,
            replaced: true
        };
    }

    tabsElem.selectedIndex(selectedIndex);

    return {
        tabsContainer: tabsContainerElem,
        tabs: tabsElem,
        replaced: false
    };
}

export function selectedTabIndex(index) {
    if (index != null) {
        tabsElem.selectedIndex(index);
    } else {
        tabsElem.triggerTabChange();
    }
}

export function getTabsElement() {
    return document.querySelector('.tabs-viewmenubar');
}

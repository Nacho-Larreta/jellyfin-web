import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import type { Section } from '../types';
import {
    addSection,
    getCardOptionsFromType,
    getTitleFromType,
    sortSections
} from './search';

export type SearchResultData = {
    sections: Section[];
    topResult?: BaseItemDto;
};

export const buildSearchResultData = (
    initialSections: Section[],
    itemTypes: BaseItemKind[],
    rankedItems: BaseItemDto[] = []
): SearchResultData => {
    const sections = [ ...initialSections ];

    for (const itemType of itemTypes) {
        const sectionItems = rankedItems.filter(searchItem => searchItem.Type === itemType);
        addSection(sections, getTitleFromType(itemType), sectionItems, getCardOptionsFromType(itemType));
    }

    return {
        sections: sortSections(sections),
        topResult: rankedItems[0] || initialSections[0]?.items[0]
    };
};

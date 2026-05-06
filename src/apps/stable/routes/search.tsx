import type { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import React, { type FC, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebounceValue } from 'usehooks-ts';

import { useRecordSearchHistory } from 'apps/stable/features/search/api/useSearchDiscovery';
import SearchFields from 'apps/stable/features/search/components/SearchFields';
import SearchResults from 'apps/stable/features/search/components/SearchResults';
import SearchSuggestions from 'apps/stable/features/search/components/SearchSuggestions';
import Page from 'components/Page';
import useSearchParam from 'hooks/useSearchParam';
import globalize from 'lib/globalize';
import 'apps/stable/features/search/components/searchfields.scss';

const COLLECTION_TYPE_PARAM = 'collectionType';
const GENRE_PARAM = 'genre';
const PARENT_ID_PARAM = 'parentId';
const QUERY_PARAM = 'query';
const COLLECTION_NAME_PARAM = 'collectionName';

const Search: FC = () => {
    const [searchParams] = useSearchParams();
    const genreQuery = searchParams.get(GENRE_PARAM) || undefined;
    const parentIdQuery = searchParams.get(PARENT_ID_PARAM) || undefined;
    const collectionNameQuery = searchParams.get(COLLECTION_NAME_PARAM) || undefined;
    const collectionTypeQuery = (searchParams.get(COLLECTION_TYPE_PARAM) || undefined) as CollectionType | undefined;
    const [ query, setQuery ] = useSearchParam(QUERY_PARAM);
    const [debouncedQuery] = useDebounceValue(query, 500);
    const lastRecordedQuery = useRef('');
    const { mutate: recordSearchHistory } = useRecordSearchHistory();
    const hasBrowseFilter = Boolean(genreQuery || parentIdQuery || collectionNameQuery);

    useEffect(() => {
        const normalizedQuery = debouncedQuery.trim();
        if (normalizedQuery.length < 2 || normalizedQuery === lastRecordedQuery.current) {
            return;
        }

        lastRecordedQuery.current = normalizedQuery;
        recordSearchHistory(normalizedQuery);
    }, [ debouncedQuery, recordSearchHistory ]);

    useEffect(() => {
        const page = document.getElementById('searchPage');
        if (!page) {
            return;
        }

        const onFocusIn = (event: FocusEvent) => {
            const target = event.target;
            if (!(target instanceof HTMLElement) || target.id === 'searchTextInput') {
                return;
            }

            target.scrollIntoView({
                block: 'nearest',
                inline: 'nearest'
            });
        };

        page.addEventListener('focusin', onFocusIn);

        return () => {
            page.removeEventListener('focusin', onFocusIn);
        };
    }, []);

    return (
        <Page
            id='searchPage'
            title={globalize.translate('Search')}
            className='mainAnimatedPage libraryPage allLibraryPage noSecondaryNavPage'
        >
            <SearchFields query={query} onSearch={setQuery} />
            {!debouncedQuery && !hasBrowseFilter ? (
                <SearchSuggestions
                    parentId={parentIdQuery}
                    onSearch={setQuery}
                />
            ) : (
                <SearchResults
                    parentId={parentIdQuery}
                    collectionType={collectionTypeQuery}
                    genre={genreQuery}
                    collectionName={collectionNameQuery}
                    query={debouncedQuery}
                />
            )}
        </Page>
    );
};

export default Search;

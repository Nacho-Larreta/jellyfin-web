import React, { type ChangeEvent, type FC, useCallback, useRef } from 'react';
import AlphaPicker from 'components/alphaPicker/AlphaPickerComponent';
import globalize from 'lib/globalize';
import layoutManager from 'components/layoutManager';
import browser from 'scripts/browser';
import 'material-design-icons-iconfont';

interface SearchFieldsProps {
    query: string,
    onSearch?: (query: string) => void
}

const SearchFields: FC<SearchFieldsProps> = ({
    onSearch = () => { /* no-op */ },
    query
}) => {
    const inputRef = useRef<HTMLInputElement>(null);

    const onAlphaPicked = useCallback((e: Event) => {
        const value = (e as CustomEvent).detail.value;
        const inputValue = inputRef.current?.value || '';

        if (value === 'backspace') {
            onSearch(inputValue.length ? inputValue.substring(0, inputValue.length - 1) : '');
        } else {
            onSearch(inputValue + value);
        }
    }, [onSearch]);

    const onChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        onSearch(e.target.value);
    }, [ onSearch ]);

    const onClear = useCallback(() => {
        onSearch('');
        inputRef.current?.focus();
    }, [ onSearch ]);

    const stabilizeTvFocus = useCallback(() => {
        if (!layoutManager.tv) return;

        const page = document.querySelector('#searchPage') as HTMLElement | null;
        const pageScrollTop = page?.scrollTop;
        const windowScrollY = window.scrollY;

        window.requestAnimationFrame(() => {
            if (page && pageScrollTop !== undefined) {
                page.scrollTop = pageScrollTop;
            }

            window.scrollTo(window.scrollX, windowScrollY);
        });
    }, []);

    return (
        <div className='search-screen__hero padded-left padded-right'>
            <div className='search-hero'>
                <label className='search-input' htmlFor='searchTextInput'>
                    <span className='search-input__icon material-icons search' aria-hidden='true' />
                    <input
                        ref={inputRef}
                        id='searchTextInput'
                        className='search-input__control'
                        type='text'
                        {...(!layoutManager.tv ? { 'data-keyboard': 'true' } : {})}
                        placeholder='Busca títulos, personas, géneros...'
                        aria-label={globalize.translate('Search')}
                        autoComplete='off'
                        maxLength={40}
                        value={query}
                        onChange={onChange}
                        onFocus={stabilizeTvFocus}
                    />
                </label>
                {query && (
                    <button
                        type='button'
                        className='search-input__clear'
                        aria-label='Limpiar búsqueda'
                        onClick={onClear}
                    >
                        <span aria-hidden='true'>&times;</span>
                    </button>
                )}
            </div>
            {layoutManager.tv && !browser.tv
                && <AlphaPicker onAlphaPicked={onAlphaPicked} />
            }
        </div>
    );
};

export default SearchFields;

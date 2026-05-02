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
                        data-keyboard='true'
                        placeholder={globalize.translate('Search')}
                        aria-label={globalize.translate('Search')}
                        autoComplete='off'
                        maxLength={40}
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                        value={query}
                        onChange={onChange}
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

import React, { useCallback } from 'react';

export type GenreSortOption = 'relevance' | 'recent' | 'rating';

type CountFilterProps = {
    id: string;
    label: string;
    count: number;
    isActive: boolean;
    onSelect: (id: string) => void;
};

export const GenreFilterButton = ({ id, label, count, isActive, onSelect }: CountFilterProps) => {
    const onClick = useCallback(() => onSelect(id), [ id, onSelect ]);

    return (
        <button
            type='button'
            className={`genre-filter-button${isActive ? ' genre-filter-button--active' : ''}`}
            aria-pressed={isActive}
            onClick={onClick}
        >
            <span>{label}</span>
            <span className='genre-filter-button__count'>{count}</span>
        </button>
    );
};

export const FilterPill = ({ id, label, count, isActive, onSelect }: CountFilterProps) => {
    const onClick = useCallback(() => onSelect(id), [ id, onSelect ]);

    return (
        <button
            type='button'
            className={`filter-pill${isActive ? ' filter-pill--active' : ''}`}
            aria-pressed={isActive}
            onClick={onClick}
        >
            <span>{label}</span>
            <span className='filter-pill__count'>{count}</span>
        </button>
    );
};

export const GenreSortButton = ({
    id,
    label,
    activeSort,
    onSelect
}: {
    id: GenreSortOption;
    label: string;
    activeSort: GenreSortOption;
    onSelect: (id: GenreSortOption) => void;
}) => {
    const onClick = useCallback(() => onSelect(id), [ id, onSelect ]);

    return (
        <button
            type='button'
            className={`genre-sort-button${activeSort === id ? ' genre-sort-button--active' : ''}`}
            aria-pressed={activeSort === id}
            onClick={onClick}
        >
            {label}
        </button>
    );
};

import type { BaseItemDto, ParentalRating } from '@jellyfin/sdk/lib/generated-client/models';

export const SCREENSAVER_AGE_CEILINGS = [ 0, 5, 10, 13, 14, 16, 18, 21, -1 ] as const;

export type ScreensaverAgeCeiling = typeof SCREENSAVER_AGE_CEILINGS[number];

type ParentalRatingWithLegacyValue = ParentalRating & {
    Value?: number | null;
};

export interface ScreensaverItemQuery {
    EnableImageTypes: 'Backdrop';
    Fields: 'Taglines,CustomRating';
    HasParentalRating: true;
    ImageTypeLimit: 10;
    ImageTypes: 'Backdrop';
    IncludeItemTypes: 'Movie,Series';
    Limit: 200;
    MaxOfficialRating?: number;
    Recursive: true;
    SortBy: 'Random';
    StartIndex: 0;
}

const supportedCeilings = new Set<number>(SCREENSAVER_AGE_CEILINGS);
const canonicalNumericRating = /^(?:0|[1-9]|1\d|2[01])$/;

export function normalizeScreensaverAgeCeiling(value: unknown): ScreensaverAgeCeiling {
    if (typeof value === 'number') {
        return Number.isInteger(value) && supportedCeilings.has(value) ? value as ScreensaverAgeCeiling : 0;
    }

    if (typeof value === 'string' && /^(?:-1|0|[1-9]\d*)$/.test(value)) {
        const parsedValue = Number(value);
        return supportedCeilings.has(parsedValue) ? parsedValue as ScreensaverAgeCeiling : 0;
    }

    return 0;
}

export class ScreensaverContentPolicy {
    readonly ageCeiling: ScreensaverAgeCeiling;

    constructor(persistedAgeCeiling: unknown) {
        this.ageCeiling = normalizeScreensaverAgeCeiling(persistedAgeCeiling);
    }

    buildQuery(): ScreensaverItemQuery {
        const query: ScreensaverItemQuery = {
            ImageTypes: 'Backdrop',
            EnableImageTypes: 'Backdrop',
            IncludeItemTypes: 'Movie,Series',
            SortBy: 'Random',
            Recursive: true,
            Fields: 'Taglines,CustomRating',
            ImageTypeLimit: 10,
            HasParentalRating: true,
            StartIndex: 0,
            Limit: 200
        };

        if (this.ageCeiling !== -1) {
            query.MaxOfficialRating = this.ageCeiling;
        }

        return query;
    }

    filterEligibleItems(items: readonly BaseItemDto[], catalog: readonly ParentalRating[]): BaseItemDto[] {
        const ratingScores = buildRatingCatalog(catalog);
        if (ratingScores.size === 0) {
            return [];
        }

        return items.filter(item => this.isEligible(item, ratingScores));
    }

    private isEligible(item: BaseItemDto | null | undefined, ratingScores: ReadonlyMap<string, number>): boolean {
        if (!item || (item.Type !== 'Movie' && item.Type !== 'Series')) {
            return false;
        }

        if (!Array.isArray(item.BackdropImageTags)
            || !item.BackdropImageTags.some(tag => typeof tag === 'string' && tag.length > 0)) {
            return false;
        }

        const effectiveRating = getEffectiveRating(item);
        const ratingScore = effectiveRating ? resolveRatingScore(effectiveRating, ratingScores) : undefined;

        if (ratingScore === undefined) {
            return false;
        }

        return this.ageCeiling === -1 || ratingScore <= this.ageCeiling;
    }
}

function getEffectiveRating(item: BaseItemDto): string | undefined {
    if (item.CustomRating != null && typeof item.CustomRating !== 'string') {
        return undefined;
    }

    const customRating = item.CustomRating?.trim();
    if (customRating) {
        return customRating;
    }

    if (item.OfficialRating != null && typeof item.OfficialRating !== 'string') {
        return undefined;
    }

    const officialRating = item.OfficialRating?.trim();
    return officialRating || undefined;
}

function buildRatingCatalog(catalog: readonly ParentalRating[]): ReadonlyMap<string, number> {
    const ratingScores = new Map<string, number>();

    for (const entry of catalog) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }

        const name = typeof entry.Name === 'string' ? entry.Name.trim() : undefined;
        const legacyEntry = entry as ParentalRatingWithLegacyValue;
        const score = entry.RatingScore?.score ?? legacyEntry.Value;

        if (name && typeof score === 'number' && Number.isInteger(score) && score >= 0) {
            ratingScores.set(name.toLowerCase(), score);
        }
    }

    return ratingScores;
}

function resolveRatingScore(rating: string, catalog: ReadonlyMap<string, number>): number | undefined {
    if (canonicalNumericRating.test(rating)) {
        return Number(rating);
    }

    return catalog.get(rating.toLowerCase());
}

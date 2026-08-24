export type HomeLoadState = 'ready' | 'empty' | 'partial' | 'error';
export type HomeSectionStatus = 'fulfilled' | 'rejected';

export type HomeSectionAggregation<T> = {
    items: T[];
    status: HomeSectionStatus;
};

export const aggregateHomeSectionResults = <T>(
    results: PromiseSettledResult<T[]>[]
): HomeSectionAggregation<T> => ({
    items: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    status: results.some(result => result.status === 'rejected') ? 'rejected' : 'fulfilled'
});

export const getHomeLoadState = (
    hasLibraries: boolean,
    sectionStatuses: HomeSectionStatus[],
    hasMedia: boolean
): HomeLoadState => {
    const failedSections = sectionStatuses.filter(status => status === 'rejected').length;

    if (failedSections === sectionStatuses.length && !hasLibraries) {
        return 'error';
    }

    if (failedSections > 0) {
        return 'partial';
    }

    return hasLibraries || hasMedia ? 'ready' : 'empty';
};

export const JellyflixCollectionType = {
    Courses: 'courses',
    AdultVideos: 'adultvideos'
} as const;

export type JellyflixCollectionTypeValue =
    typeof JellyflixCollectionType[keyof typeof JellyflixCollectionType];

export const isAdultVideosCollectionType = (collectionType: string | null | undefined) =>
    collectionType === JellyflixCollectionType.AdultVideos;

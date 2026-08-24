export const normalizeRouterUrl = (url: string) => url.startsWith('#') ? url.substring(1) : url;

export const getGenreBrowseUrl = (name: string) => `/search?genre=${encodeURIComponent(name)}`;

export const getCollectionBrowseUrl = (id: string, name: string) => (
    `/search?parentId=${encodeURIComponent(id)}&collectionName=${encodeURIComponent(name)}`
);

export interface Theme {
    name: string
    default?: boolean;
    id: string
    color: string
}

interface MenuLink {
    name: string
    icon?: string
    url: string
}

interface JellyflixConfig {
    syncPlayEnabled?: boolean
}

export interface WebConfig {
    includeCorsCredentials?: boolean
    multiserver?: boolean
    themes?: Theme[]
    menuLinks?: MenuLink[]
    servers?: string[]
    plugins?: string[]
    jellyflix?: JellyflixConfig
}

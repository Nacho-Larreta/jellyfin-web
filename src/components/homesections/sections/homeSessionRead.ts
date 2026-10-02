import type { UserDto } from '@jellyfin/sdk/lib/generated-client';
import type { ApiClient } from 'jellyfin-apiclient';

import type { SessionScopedHomeReadApi } from 'utils/jellyfin-apiclient/sessionReadApi';

export interface HomeSessionRead {
    readonly apiClient: ApiClient;
    readonly read: SessionScopedHomeReadApi;
    readonly user: UserDto;
    assertCurrent(): void;
}

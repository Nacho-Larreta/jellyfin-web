import React, { type FC } from 'react';
import type { UserDto } from '@jellyfin/sdk/lib/generated-client/models/user-dto';
import Avatar, { type AvatarProps } from '@mui/material/Avatar';
import type {} from '@mui/material/themeCssVarsAugmentation';

import { useApi } from 'hooks/useApi';

interface UserAvatarProps extends AvatarProps {
    user?: UserDto,
    size?: number,
    profileGradient?: string | null
}

const UserAvatar: FC<UserAvatarProps> = ({
    user,
    size,
    profileGradient
}) => {
    const { api } = useApi();
    const hasPrimaryImage = Boolean(api && user?.Id && user.PrimaryImageTag);
    const initial = user?.Name?.trim().charAt(0).toUpperCase();

    return user ? (
        <Avatar
            alt={user.Name ?? undefined}
            src={
                hasPrimaryImage ?
                    `${api?.basePath}/Users/${user.Id}/Images/Primary?tag=${user.PrimaryImageTag}` :
                    undefined
            }
            // eslint-disable-next-line react/jsx-no-bind
            sx={theme => ({
                bgcolor: hasPrimaryImage ?
                    theme.vars.palette.background.paper :
                    undefined,
                background: hasPrimaryImage ?
                    undefined :
                    profileGradient || 'linear-gradient(135deg, #00a4dc 0%, #00729a 100%)',
                color: '#fff',
                fontFamily: '"Figtree", "Helvetica Neue", Arial, sans-serif',
                fontSize: size ? `${Math.max(size * 0.44, 13)}px` : undefined,
                fontWeight: 800,
                width: size,
                height: size
            })}
        >
            {hasPrimaryImage ? null : initial}
        </Avatar>
    ) : null;
};

export default UserAvatar;

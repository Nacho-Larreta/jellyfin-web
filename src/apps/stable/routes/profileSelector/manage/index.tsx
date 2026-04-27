import React, { type FC } from 'react';

import ViewManagerPage from 'components/viewManager/ViewManagerPage';

const ProfileSelectorManageRoute: FC = () => (
    <ViewManagerPage
        controller='session/profileSelector/manage/index'
        view='session/profileSelector/manage/index.html'
    />
);

export default ProfileSelectorManageRoute;

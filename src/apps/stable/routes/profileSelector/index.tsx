import React, { type FC } from 'react';

import ViewManagerPage from 'components/viewManager/ViewManagerPage';

const ProfileSelectorRoute: FC = () => (
    <ViewManagerPage
        controller='session/profileSelector/index'
        view='session/profileSelector/index.html'
    />
);

export default ProfileSelectorRoute;

import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot } from 'react-dom/client';

import appTheme from 'themes';
import 'themes/_base/_semantic.scss';
import { ExperiencePrimitivesFixture } from './ExperiencePrimitivesFixture';

document.documentElement.dataset.theme = 'dark';
document.title = 'Jellyfin experience primitives';

const fixtureRoot = document.createElement('div');
fixtureRoot.id = 'experience-fixture-root';
document.body.append(fixtureRoot);

createRoot(fixtureRoot).render(
    <ThemeProvider theme={appTheme}>
        <CssBaseline />
        <ExperiencePrimitivesFixture />
    </ThemeProvider>
);

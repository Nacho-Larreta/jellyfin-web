import { buildCustomColorScheme } from 'themes/utils';

/** The default "Dark" color scheme. */
const theme = buildCustomColorScheme({
    palette: {
        mode: 'dark',
        SnackbarContent: {
            bg: '#303030',
            color: 'rgba(255, 255, 255, 0.87)'
        }
    }
});

export default theme;

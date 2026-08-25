const HtmlWebpackPlugin = require('html-webpack-plugin');
const path = require('path');

module.exports = {
    context: path.resolve(__dirname, 'src'),
    devtool: false,
    entry: './components/experience/fixtureEntry.tsx',
    mode: 'development',
    module: {
        rules: [
            {
                test: /\.(ts|tsx)$/,
                use: {
                    loader: 'ts-loader',
                    options: { transpileOnly: true }
                }
            },
            {
                test: /\.scss$/,
                use: [ 'style-loader', 'css-loader', 'postcss-loader', 'sass-loader' ]
            }
        ]
    },
    output: {
        clean: true,
        filename: 'fixture.js',
        path: path.resolve(__dirname, '.artifacts/experience-primitives')
    },
    plugins: [
        new HtmlWebpackPlugin({
            title: 'Jellyfin experience primitives'
        })
    ],
    resolve: {
        extensions: [ '.tsx', '.ts', '.js' ],
        modules: [ path.resolve(__dirname, 'src'), path.resolve(__dirname, 'node_modules') ]
    },
    target: 'web'
};

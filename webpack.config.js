const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

const commonModule = {
  rules: [
    { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
    { test: /\.css$/, use: ['style-loader', 'css-loader'] },
  ],
};

const commonResolve = { extensions: ['.ts', '.js'] };

const chromeConfig = {
  name: 'chrome',
  entry: {
    background: './src/background/service-worker.ts',
    sidepanel: './src/sidepanel/sidepanel.ts',
    content: './src/content/content-script.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/chrome'),
    filename: '[name].js',
    clean: true,
  },
  module: commonModule,
  resolve: commonResolve,
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' },
        { from: 'src/sidepanel/sidepanel.html', to: 'sidepanel.html' },
        { from: 'src/sidepanel/sidepanel.css', to: 'sidepanel.css' },
        { from: 'icons', to: 'icons', noErrorOnMissing: true },
      ],
    }),
  ],
  devtool: 'cheap-module-source-map',
};

const firefoxConfig = {
  name: 'firefox',
  entry: {
    background: './src/firefox/background.ts',
    sidepanel: './src/sidepanel/sidepanel.ts',
    content: './src/content/content-script.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/firefox'),
    filename: '[name].js',
    clean: true,
  },
  module: commonModule,
  resolve: commonResolve,
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/firefox/manifest.json', to: 'manifest.json' },
        { from: 'src/sidepanel/sidepanel.html', to: 'sidepanel.html' },
        { from: 'src/sidepanel/sidepanel.css', to: 'sidepanel.css' },
        { from: 'icons', to: 'icons', noErrorOnMissing: true },
      ],
    }),
  ],
  devtool: 'cheap-module-source-map',
};

module.exports = [chromeConfig, firefoxConfig];

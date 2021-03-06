const path = require("path");
const rimraf = require("rimraf");
const webpack = require("webpack");
const browserslist = require("browserslist");
const ExtractCSSPlugin = require("mini-css-extract-plugin");
const InjectPlugin = require("webpack-inject-plugin").default;
const MinifyCSSPlugin = require("optimize-css-assets-webpack-plugin");
const MinifyImgPlugin = require("imagemin-webpack-plugin").default;
const CompressionPlugin = require("compression-webpack-plugin");
const MarkoPlugin = require("@marko/webpack/plugin").default;

const { getUserAgentRegExp } = require("browserslist-useragent-regexp");
const { useAppModuleOrFallback, getRouterCode } = require("./util");

const SERVER_FILE = path.join(__dirname, "./files/server.js");
const CWD = process.cwd();

module.exports = ({
  dir,
  file,
  production = true,
  output = "build",
  serverPlugins = [],
  clientPlugins = []
}) => {
  const ENTRY_FILENAME_TEMPLATE = `[${
    production ? "id" : "name"
  }].[contenthash:8]`;
  const FILENAME_TEMPLATE = `${production ? "" : "[name]."}[contenthash:8]`;
  const NODE_ENV = production
    ? (process.env.NODE_ENV = "production")
    : undefined;
  const MODE = production ? "production" : "development";
  const DEVTOOL = production ? "source-map" : "cheap-module-source-map";
  const BUILD_PATH = path.resolve(CWD, output);
  const ASSETS_PATH = path.join(BUILD_PATH, "assets");
  const PUBLIC_PATH = "/assets/";
  const APP_DIR = dir || path.dirname(file);

  // getClientCompilerName gets stringified and added to the output bundle
  // if it is instrumented, the cov_${id} variable will cause a ReferenceError
  /* istanbul ignore next */
  const markoPlugin = new MarkoPlugin();

  const markoCompiler = (() => {
    process.env.APP_DIR = APP_DIR;
    return require.resolve("./marko-compiler");
  })();

  const isMarko5 = !markoCompiler.createBuilder;

  const legacyBrowsers =
    browserslist.loadConfig({
      path: dir || file,
      env: "legacy"
    }) || browserslist.defaults;

  const modernBrowsers = browserslist.loadConfig({
    path: dir || file,
    env: "modern"
  }) || [
    "last 3 Chrome versions",
    "last 2 Firefox versions",
    "last 1 Edge versions",
    "last 1 Safari versions",
    "unreleased versions"
  ];

  const sharedAliases = () => ({
    marko: useAppModuleOrFallback(APP_DIR, "marko"),
    "connect-gzip-static": useAppModuleOrFallback(
      APP_DIR,
      "connect-gzip-static"
    ),
    "source-map-support": useAppModuleOrFallback(APP_DIR, "source-map-support")
  });

  const babelConfig = targets => ({
    presets: [[require.resolve("@babel/preset-env"), { targets }]],
    plugins: [require.resolve("babel-plugin-macros")],
    babelrc: false,
    configFile: false
  });

  const babelLoader = targets => ({
    loader: require.resolve("babel-loader"),
    options: {
      ...babelConfig(targets),
      cacheDirectory: true
    }
  });

  const sharedRules = ({ isServer, targets }) => [
    {
      test: /\.js$/,
      exclude: !production || isServer ? /node_modules/ : undefined,
      use: [babelLoader(targets)]
    },
    {
      test: /\.marko$/,
      use: (isMarko5 ? [] : [babelLoader(targets)]).concat({
        loader: require.resolve("@marko/webpack/loader"),
        options: {
          compiler: markoCompiler,
          babelConfig: isMarko5 && babelConfig(targets)
        }
      })
    },
    {
      test: /\.css$/,
      use: isServer
        ? [require.resolve("ignore-loader")]
        : [
            ExtractCSSPlugin.loader,
            {
              loader: require.resolve("css-loader"),
              options: {
                sourceMap: true
              }
            },
            {
              loader: require.resolve("postcss-loader"),
              options: {
                config: {
                  path: __dirname,
                  ctx: { browsers: targets }
                }
              }
            }
          ]
    },
    {
      test: file => !/\.(m?js|json|css|wasm|marko)$/.test(file),
      loader: require.resolve("file-loader"),
      options: {
        publicPath: PUBLIC_PATH,
        name: `${FILENAME_TEMPLATE}.[ext]`,
        outputPath: path.relative(
          isServer ? BUILD_PATH : ASSETS_PATH,
          ASSETS_PATH
        )
      }
    }
  ];

  const sharedConfig = options => ({
    mode: MODE,
    context: __dirname,
    devtool: DEVTOOL,
    resolve: {
      alias: sharedAliases(options),
      extensions: [".wasm", ".mjs", ".js", ".json", ".marko"]
    },
    module: { rules: sharedRules(options) }
  });

  if (production) {
    const getSharedCompressionPlugins = test => [
      new MinifyImgPlugin({ test }),
      new CompressionPlugin({
        test,
        algorithm: "gzip",
        filename: "[path].gz[query]"
      }),
      new CompressionPlugin({
        test,
        algorithm: "brotliCompress",
        filename: "[path].br[query]",
        compressionOptions: { level: 11 }
      })
    ];

    serverPlugins = serverPlugins.concat(
      getSharedCompressionPlugins(/^assets/)
    );

    clientPlugins = clientPlugins.concat(
      new MinifyCSSPlugin(),
      getSharedCompressionPlugins()
    );
  } else {
    serverPlugins = serverPlugins.concat(
      new InjectPlugin(() => `import "source-map-support/register"`)
    );
  }

  const serverConfig = {
    name: "Server",
    target: "async-node",
    entry: SERVER_FILE,
    output: {
      path: BUILD_PATH,
      publicPath: PUBLIC_PATH,
      filename: "index.js",
      chunkFilename: `${ENTRY_FILENAME_TEMPLATE}.js`,
      libraryTarget: "commonjs2",
      devtoolModuleFilenameTemplate: "[resource-path]"
    },
    plugins: [
      new webpack.DefinePlugin({
        "typeof window": "'undefined'",
        "process.browser": undefined,
        "process.env.BUNDLE": true,
        "global.PORT": production ? 3000 : 0,
        "process.env.NODE_ENV": NODE_ENV && `'${NODE_ENV}'`
      }),
      new InjectPlugin(
        () =>
          `global.MODERN_BROWSERS_REGEXP = ${getUserAgentRegExp({
            browsers: modernBrowsers,
            allowHigherVersions: true
          })}`
      ),
      new InjectPlugin(async function() {
        const parts = [];
        this.cacheable(false);

        if (dir) {
          parts.push(await getRouterCode(dir, [BUILD_PATH, "**/node_modules"]));
        } else if (file.endsWith(".js")) {
          parts.push(
            `import middleware from JSON.stringify(file)`,
            `global.MARKO_MIDDLEWARE = middleware`
          );
        } else {
          parts.push(
            `import template from ${JSON.stringify(file)}`,
            `global.GET_ROUTE = () => ({ key: 'main', template })`
          );
        }

        return parts.join(";\n");
      }),
      markoPlugin.server,
      ...serverPlugins
    ],
    ...sharedConfig({ isServer: true, targets: { node: true } })
  };

  const getBrowserConfig = ({ targetsName, targets }) => ({
    name: `Browser-${targetsName}`,
    entry: markoPlugin.emptyEntry,
    optimization: {
      splitChunks: {
        chunks: "all",
        maxInitialRequests: 3
      }
    },
    output: {
      publicPath: PUBLIC_PATH,
      path: ASSETS_PATH,
      filename: `${ENTRY_FILENAME_TEMPLATE}.js`
    },
    plugins: [
      new webpack.DefinePlugin({
        "typeof window": "'object'",
        "process.browser": true,
        "process.env.NODE_ENV": NODE_ENV && `'${NODE_ENV}'`
      }),
      new ExtractCSSPlugin({
        filename: `${FILENAME_TEMPLATE}.css`
      }),
      markoPlugin.browser,
      ...clientPlugins
    ],
    ...sharedConfig({ isServer: false, targets })
  });

  const legacyBrowserConfig =
    production &&
    getBrowserConfig({ targetsName: "legacy", targets: legacyBrowsers });
  const modernBrowserConfig = getBrowserConfig({
    targetsName: "modern",
    targets: modernBrowsers
  });

  const compiler = webpack(
    production
      ? [legacyBrowserConfig, modernBrowserConfig, serverConfig]
      : [modernBrowserConfig, serverConfig]
  );

  if (production) {
    compiler.hooks.run.tapAsync("@marko/build", (_, done) =>
      rimraf(BUILD_PATH, done)
    );
  }

  return compiler;
};

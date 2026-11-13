import { defineConfig } from 'vite'
import { createBaseConfig } from './vite.config.base.js'
import webExtension from 'vite-plugin-web-extension'
import fs from 'fs-extra'
import { resolve } from 'path'
import { generateValidatedManifest } from '../manifest-generator.js'
import pkg from '../../package.json' with { type: 'json' };
import projectNaming from '../../scripts/shared/project-names.cjs'
import buildOutputPaths from '../../scripts/shared/build-output-paths.cjs'

const { artifactPrefix } = projectNaming.getProjectNames(pkg.name)
// Production and development builds write to separate directories so an
// unminified development build can never overwrite the release bundle.
const baseOutDir = buildOutputPaths.getBuildOutputDir({
  browser: 'chrome',
  version: pkg.version,
  artifactPrefix,
});
const watchDelay = Number(process.env.VITE_WATCH_DELAY || 0)

// Import production config for production builds
let productionConfig = null;
if (process.env.NODE_ENV === 'production') {
  productionConfig = (await import('./vite.config.production.js')).default;
}

// Plugin to copy static files and fix HTML paths for extension structure
function fixExtensionPaths() {
  const copyStaticFiles = async (outDir) => {
    // Ensure output directory exists
    await fs.ensureDir(outDir);
    await fs.ensureDir(resolve(outDir, 'src/html'));
    
    // Icons are copied later in transformManifest, skip here to avoid duplication
  };

  const fixHtmlPaths = async (outDir) => {
    const htmlDir = resolve(outDir, 'src/html');
    
    // Ensure html directory exists
    await fs.ensureDir(htmlDir);
    
    // Fix paths in HTML files
    const htmlFiles = ['popup.html', 'sidepanel.html', 'options.html', 'offscreen.html', 'subtitle.html', 'pdf.html'];
    
    for (const htmlFile of htmlFiles) {
      const srcPath = resolve(outDir, htmlFile);
      const destPath = resolve(htmlDir, htmlFile);
      
      if (await fs.pathExists(srcPath)) {
        let content = await fs.readFile(srcPath, 'utf-8');
        
        // Fix all absolute paths to relative paths
        if (htmlFile === 'offscreen.html') {
          // offscreen.js is now in the same directory
          content = content.replace(/src="\/offscreen\.js"/g, 'src="./offscreen.js"');
          content = content.replace(/src='\/offscreen\.js'/g, "src='./offscreen.js'");
        }
        
        content = content.replace(/src="\/([^"]+)"/g, 'src="../../$1"');
        content = content.replace(/href="\/([^"]+)"/g, 'href="../../$1"');
        content = content.replace(/src='\/([^']+)'/g, "src='../../$1'");
        content = content.replace(/href='\/([^']+)'/g, "href='../../$1'");
        
        // Write to src/html/ directory
        await fs.writeFile(destPath, content);
        
        // Remove original
        await fs.remove(srcPath);
      }
    }
  };
  
  return {
    name: 'fix-extension-paths',
    // Production build
    writeBundle: {
      order: 'pre',
      handler: async (options) => {
        console.log('🔧 writeBundle started with dir:', options.dir);
        await copyStaticFiles(options.dir);
        await fixHtmlPaths(options.dir);
      }
    },
    // Development server mode  
    configureServer(server) {
      // Serve HTML files from /src/html/ path with correct structure
      server.middlewares.use('/src/html', (req, res, next) => {
        if (req.url.endsWith('.html')) {
          const filename = 'src/html' + req.url; // req.url starts with /
          const rootPath = resolve(process.cwd(), filename);
          
          if (fs.existsSync(rootPath)) {
            let content = fs.readFileSync(rootPath, 'utf-8');
            
            // For development server, keep original paths but ensure they work from /src/html/ context
            // The development server will serve assets from root, so relative paths from src/html/ should go up two levels
            content = content.replace(/src="\/src\/app\/main\/([^"]+)"/g, 'src="/src/app/main/$1"');
            
            res.setHeader('Content-Type', 'text/html');
            res.end(content);
            return;
          }
        }
        next();
      });
      
      // Also handle direct HTML file access from root (deprecated, but kept for compatibility)
      server.middlewares.use((req, res, next) => {
        if (req.url.match(/\/(popup|sidepanel|options|pdf)\.html$/)) {
          const filename = 'src/html' + req.url;
          const rootPath = resolve(process.cwd(), filename);
          
          if (fs.existsSync(rootPath)) {
            let content = fs.readFileSync(rootPath, 'utf-8');
            
            // For root-level access, paths should work as-is for development
            res.setHeader('Content-Type', 'text/html');
            res.end(content);
            return;
          }
        }
        next();
      });
      
      // Handle offscreen files specifically for serve mode
      server.middlewares.use('/src/html/offscreen.html', (req, res, next) => {
        const offscreenPath = resolve(process.cwd(), 'src/html/offscreen.html');
        
        if (fs.existsSync(offscreenPath)) {
          let content = fs.readFileSync(offscreenPath, 'utf-8');
          res.setHeader('Content-Type', 'text/html');
          res.end(content);
          return;
        }
        
        res.status(404).send('offscreen.html not found');
      });
      
      // Handle offscreen.js for serve mode
      server.middlewares.use((req, res, next) => {
        if (req.url === '/offscreen.js' || req.url === '/src/html/offscreen.js') {
          const offscreenJsPath = resolve(process.cwd(), 'src/html/offscreen.js');
          
          if (fs.existsSync(offscreenJsPath)) {
            let content = fs.readFileSync(offscreenJsPath, 'utf-8');
            res.setHeader('Content-Type', 'application/javascript');
            res.end(content);
            return;
          }
        }
        next();
      });
    },
    // Handle hot updates in watch mode
    handleHotUpdate: {
      order: 'pre',
      handler: async (ctx) => {
        if (ctx.file.endsWith('.html')) {
          console.log('🔄 HTML file updated, fixing paths...');
          
          // Get the output directory from build options
          const outDir = baseOutDir;
          
          // Only fix paths if the output directory exists (not in pure dev mode)
          if (await fs.pathExists(outDir)) {
            await fixHtmlPaths(outDir);
          }
        }
      }
    }
  };
}

const baseConfig = createBaseConfig('chrome')

// Use production config if in production, otherwise use base config
const finalConfig = process.env.NODE_ENV === 'production' && productionConfig
  ? {
      ...baseConfig,
      ...productionConfig,
      build: {
        ...baseConfig.build,
        ...productionConfig.build,
        rollupOptions: {
          ...baseConfig.build?.rollupOptions,
          ...productionConfig.build?.rollupOptions,
          output: {
            ...baseConfig.build?.rollupOptions?.output,
            ...productionConfig.build?.rollupOptions?.output
          }
        }
      }
    }
  : baseConfig;

export default defineConfig({
  ...finalConfig,
  // Chrome-specific build definitions
  define: {
    ...(finalConfig.define || {}),
    __BROWSER__: JSON.stringify('chrome'),
    __MANIFEST_VERSION__: 3
  },
  build: {
    ...(finalConfig.build || {}),
    watch: finalConfig.build?.watch ? { ...finalConfig.build.watch, buildDelay: watchDelay } : undefined,
    outDir: baseOutDir,
    rollupOptions: {
      ...(finalConfig.build?.rollupOptions || {}),
      // Override entry points to remove them from production config
      input: undefined,
      output: {
        ...(finalConfig.build?.rollupOptions?.output || {}),
        format: 'es'
      }
    }
  },
  plugins: [
    ...(baseConfig.plugins || []),
    fixExtensionPaths(),
    webExtension({
      additionalInputs: ['src/core/content-scripts/index-iframe.js', 'src/features/live-dubbing/content/index-media-observer.js', 'src/html/offscreen.html', 'src/html/subtitle.html', 'src/html/pdf.html'],
      manifest: async () => {
          const manifest = generateValidatedManifest('chrome');
          manifest.background = {
            service_worker: 'src/core/background/index.js',
            type: 'module'
          };
          console.log('✅ Chrome manifest generated');
          return manifest;
        },
      htmlViteConfig: {
        ...baseConfig,
        build: {
          ...baseConfig.build,
          watch: baseConfig.build?.watch ? { ...baseConfig.build.watch, buildDelay: watchDelay } : undefined,
          outDir: baseOutDir,
          modulePreload: false,
          rollupOptions: {
            ...baseConfig.build?.rollupOptions,
            output: {
              ...baseConfig.build?.rollupOptions?.output,
              assetFileNames: (assetInfo) => {
                const info = assetInfo.name.split('.')
                const ext = info[info.length - 1]

                if (/\.(css)$/i.test(assetInfo.name)) {
                  return 'css/[name].[hash].[ext]'
                }

                if (/\.(png|jpe?g|svg|gif|webp|avif)$/i.test(assetInfo.name)) {
                  return 'images/[name].[hash].[ext]'
                }

                if (/\.(woff2?|eot|ttf|otf)$/i.test(assetInfo.name)) {
                  return 'fonts/[name].[hash].[ext]'
                }

                return 'assets/[name].[hash].[ext]'
              }
            }
          }
        }
      },
      scriptViteConfig: {
        ...baseConfig,
        build: {
          ...baseConfig.build,
          watch: baseConfig.build?.watch ? { ...baseConfig.build.watch, buildDelay: watchDelay } : undefined,
          outDir: baseOutDir,
          emptyOutDir: false,
          rollupOptions: {
            ...baseConfig.build?.rollupOptions,
            manualChunks: undefined,
            output: {
              ...baseConfig.build?.rollupOptions?.output,
              manualChunks: undefined,
              format: 'es'
            }
          }
        }
      },
      transformManifest: async (manifest) => {
        // Prevent Vite from injecting extracted content UI CSS into page scope.
        // Content UI styles are loaded manually into the ShadowRoot.        
        for (const contentScript of manifest.content_scripts || []) {
          if (contentScript.js?.includes('src/core/content-scripts/index-main.js')) {
            delete contentScript.css;
          }
        }

        const outDir = baseOutDir;
        await fs.ensureDir(outDir);
        await fs.ensureDir(resolve(outDir, 'src/html'));
        
        // Copy required assets
        const srcDir = process.cwd();
        await fs.copy(resolve(srcDir, 'src/_locales'), resolve(outDir, '_locales'));
        await fs.copy(resolve(srcDir, 'src/icons'), resolve(outDir, 'icons'));
        
        // Copy CSS files for content scripts (CRITICAL FIX)
        const stylesDir = resolve(srcDir, 'src/styles');
        const outStylesDir = resolve(outDir, 'src/styles');
        if (await fs.pathExists(stylesDir)) {
          await fs.ensureDir(outStylesDir);
          await fs.copy(stylesDir, outStylesDir);
          console.log('✅ Copied CSS files from src/styles/ to build directory');
        }
        
        // Copy Changelog.md for About page
        const changelogSrc = resolve(srcDir, 'docs/Changelog.md');
        const changelogDest = resolve(outDir, 'docs/Changelog.md');
        if (await fs.pathExists(changelogSrc)) {
          await fs.ensureDir(resolve(outDir, 'docs'));
          await fs.copy(changelogSrc, changelogDest);
        }
        
        // Copy browser polyfill
        const polyfillSrc = resolve(srcDir, 'node_modules/webextension-polyfill/dist/browser-polyfill.js');
        const polyfillDest = resolve(outDir, 'browser-polyfill.js');
        if (await fs.pathExists(polyfillSrc)) {
          await fs.copy(polyfillSrc, polyfillDest);
        }

        // Copy Tesseract assets
        const tesseractSrc = resolve(srcDir, 'src/features/screen-capture/assets');
        const tesseractDest = resolve(outDir, 'assets/ocr');
        if (await fs.pathExists(tesseractSrc)) {
          await fs.ensureDir(tesseractDest);
          await fs.copy(tesseractSrc, tesseractDest);
          console.log('✅ Copied Tesseract assets to assets/ocr/');
        }
        
        // HTML files are now handled by the fixExtensionPaths plugin
        
        const file = resolve(outDir, 'manifest.json');
        await fs.writeJson(file, manifest, { spaces: 2 });
        return manifest;
      },
      disableAutoLaunch: true,
      skipManifestValidation: true
    }),
  ],
  server: {
    port: 3000,
    strictPort: true,
    hmr: {
      port: 3000,
    },
  },
})

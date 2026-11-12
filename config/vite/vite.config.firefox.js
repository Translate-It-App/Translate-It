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
  browser: 'firefox',
  version: pkg.version,
  artifactPrefix,
});
const watchDelay = Number(process.env.VITE_WATCH_DELAY || 0)

// Import production config for production builds
let productionConfig = null;
if (process.env.NODE_ENV === 'production') {
  productionConfig = (await import('./vite.config.production.js')).default;
}

const baseConfig = createBaseConfig('firefox')

// Use production config if in production, otherwise use base config
const finalConfig = process.env.NODE_ENV === 'production' && productionConfig
  ? { ...productionConfig, ...baseConfig }
  : baseConfig;

// Plugin to copy CSS files for Firefox
function copyFirefoxAssets() {
  return {
    name: 'copy-firefox-assets',
    writeBundle: {
      order: 'pre',
      handler: async (options) => {
        // Copy CSS files for content scripts
        const stylesDir = resolve(process.cwd(), 'src/styles');
        const outStylesDir = resolve(options.dir, 'src/styles');
        if (await fs.pathExists(stylesDir)) {
          await fs.ensureDir(outStylesDir);
          await fs.copy(stylesDir, outStylesDir);
          console.log(`✅ Copied CSS files from src/styles/ to Firefox build directory: ${options.dir}`);
        }

        // Icons are copied later in transformManifest, skip here to avoid duplication
      }
    }
  };
}

export default defineConfig({
  ...finalConfig,

  // Firefox-specific build definitions
  define: {
    ...(finalConfig.define || {}),
    __BROWSER__: JSON.stringify('firefox'),
    __MANIFEST_VERSION__: 3
  },

  build: {
    ...(finalConfig.build || {}),
    watch: finalConfig.build?.watch ? { ...finalConfig.build.watch, buildDelay: watchDelay } : undefined,
    outDir: baseOutDir,
    sourcemap: false,
  },
  
  plugins: [
    ...(baseConfig.plugins || []),
    
    copyFirefoxAssets(),
    
    webExtension({
      additionalInputs: ['src/core/content-scripts/index-iframe.js', 'src/html/subtitle.html', 'src/html/pdf.html'],
      // Generate dynamic manifest for Firefox
      manifest: () => {
        const manifest = generateValidatedManifest('firefox');
        console.log('✅ Firefox manifest generated');
        return manifest;
      },
      
      // Firefox HTML config
      htmlViteConfig: {
        ...baseConfig,
        resolve: {
          ...baseConfig.resolve,
        },
        build: {
          ...baseConfig.build,
          watch: baseConfig.build?.watch ? { ...baseConfig.build.watch, buildDelay: watchDelay } : undefined,
          outDir: baseOutDir,
          modulePreload: false,
          sourcemap: false,
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
      
      // Firefox script config
      scriptViteConfig: {
        ...baseConfig,
        build: {
          ...baseConfig.build,
          watch: baseConfig.build?.watch ? { ...baseConfig.build.watch, buildDelay: watchDelay } : undefined,
          outDir: baseOutDir,
          emptyOutDir: false,
          sourcemap: false,
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

      // Write generated manifest.json to disk for dev mode to enable extension auto-install
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

        // Copy Tesseract assets
        const tesseractSrc = resolve(srcDir, 'src/features/screen-capture/assets');
        const tesseractDest = resolve(outDir, 'assets/ocr');
        if (await fs.pathExists(tesseractSrc)) {
          await fs.ensureDir(tesseractDest);
          await fs.copy(tesseractSrc, tesseractDest);
          console.log('✅ Copied Tesseract assets to assets/ocr/');
        }
        
        // Move HTML files to src/html/ directory and fix their paths
        const htmlFiles = [
          { file: 'popup.html', jsFile: 'popup.js', cssFile: 'popup.css' },
          { file: 'sidepanel.html', jsFile: 'sidepanel.js', cssFile: 'sidepanel.css' },
          { file: 'options.html', jsFile: 'options.js', cssFile: 'options.css' },
          { file: 'subtitle.html', jsFile: 'subtitle.js', cssFile: 'subtitle.css' },
          { file: 'pdf.html', jsFile: 'pdf.js', cssFile: 'pdf.css' }
        ];
        
        for (const {file, jsFile, cssFile} of htmlFiles) {
          const srcFile = resolve(outDir, file);
          const destFile = resolve(outDir, 'src/html', file);
          
          if (await fs.pathExists(srcFile)) {
            // Read HTML content
            let htmlContent = await fs.readFile(srcFile, 'utf-8');
            
            // Fix all absolute paths to relative paths
            htmlContent = htmlContent.replace(/src="\//g, 'src="../../');
            htmlContent = htmlContent.replace(/href="\//g, 'href="../../');
            htmlContent = htmlContent.replace(/src='\//g, "src='../../");
            htmlContent = htmlContent.replace(/href='\//g, "href='../../");
            // Fix double src/html/ paths
            htmlContent = htmlContent.replace(/src="..\/..\/ src\/html\//g, 'src="../../');
            htmlContent = htmlContent.replace(/href="..\/..\/ src\/html\//g, 'href="../../');
            htmlContent = htmlContent.replace(/src='..\/..\/ src\/html\//g, "src='../../");
            htmlContent = htmlContent.replace(/href='..\/..\/ src\/html\//g, "href='../../");
            
            // Write corrected HTML to src/html/ directory
            await fs.writeFile(destFile, htmlContent);
            
            // Remove original file
            await fs.remove(srcFile);
          }
        }
        
        const file = resolve(outDir, 'manifest.json');
        await fs.writeJson(file, manifest, { spaces: 2 });
        return manifest;
      },
      // Disable automatic browser launch in dev mode to avoid connection errors
      disableAutoLaunch: true,
      skipManifestValidation: true
    })
  ],
  server: {
    port: 3001,
    strictPort: true,
    hmr: {
      port: 3001,
    },
  },
})

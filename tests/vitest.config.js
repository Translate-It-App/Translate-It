import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith('translate-it-'),
        }
      }
    })
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [resolve(__dirname, './setup.js')],
    include: ['src/**/*.{test,spec}.{js,ts}', 'scripts/ci/*.test.js'],
    root: resolve(__dirname, '..'),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: resolve(__dirname, './coverage'),
      exclude: [
        'node_modules/',
        'tests/setup.js',
        '**/*.d.ts',
        'src/assets/**',
        'dist/**'
      ]
    },
    alias: {
      '@': resolve(__dirname, '../src'),
      '@components': resolve(__dirname, '../src/components'),
      '@views': resolve(__dirname, '../src/apps'),
      '@store': resolve(__dirname, '../src/store'),
      '@composables': resolve(__dirname, '../src/composables'),
      '@utils': resolve(__dirname, '../src/utils'),
      '@providers': resolve(__dirname, '../src/features/translation/providers'),
      '@assets': resolve(__dirname, '../src/assets'),
      '@shared': resolve(__dirname, '../src/shared'),
      '@features': resolve(__dirname, '../src/features'),
      '@core': resolve(__dirname, '../src/core')
    }
  }
})

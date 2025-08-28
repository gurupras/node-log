// vite.config.ts
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import dts from 'vite-plugin-dts'

export default defineConfig({
  build: {
    sourcemap: 'inline',
    emptyOutDir: false,
    lib: {
      // Could also be a dictionary or array of multiple entry points
      entry: resolve(__dirname, 'src/log.ts'),
      name: 'log',
      // the proper extensions will be added
      fileName: 'log',
      formats: ['cjs', 'es']
    },
    rollupOptions: {
      external: [
        'pino',
        'deepmerge',
        'date-fns'
      ]
    }
  },
  plugins: [
    dts({
      insertTypesEntry: true
    })
  ],
  test: {
    coverage: {
    },
    setupFiles: ['./test/testSetup.ts']
  }
})

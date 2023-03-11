// vite.config.ts
import { resolve } from 'path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  build: {
    sourcemap: true,
    emptyOutDir: false,
    lib: {
      // Could also be a dictionary or array of multiple entry points
      entry: resolve(__dirname, 'src/rotate.ts'),
      name: 'rotate',
      // the proper extensions will be added
      fileName: 'rotate',
      formats: ['cjs', 'es']
    },
    rollupOptions: {
      external: [
        'pino-abstract-transport',
        'zlib',
        'fs',
        'file-stream-rotator'
      ]
    }
  },
  plugins: [
    dts({
      insertTypesEntry: true
    })
  ]
})

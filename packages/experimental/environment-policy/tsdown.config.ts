import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/tools.js', 'lib/types/remote-service.js', 'lib/types/v2-service.js', 'lib/types/v2-tools.js', 'lib/types/v2-remote-service.js', 'lib/types/v2-http.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

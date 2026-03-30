import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  platform: 'node',
  treeshake: true,
  sourcemap: true,
  external: ['@context-chef/core', 'ai', '@ai-sdk/provider', '@ai-sdk/provider-utils'],
});

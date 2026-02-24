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
  // SDK packages are peerDependencies — exclude from bundle
  external: ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'zod'],
});

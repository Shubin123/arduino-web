// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const repository = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : pkg.repository?.url?.replace(/^git\+|\.git$/g, '');

export default defineConfig({
  root: 'web',
  base: './',
  define: {
    'import.meta.env.VITE_SOURCE_URL': JSON.stringify(process.env.VITE_SOURCE_URL || repository || ''),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 6000 },
  worker: { format: 'es' },
  server: { fs: { allow: ['..'] } },
});

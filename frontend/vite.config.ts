import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

// Assets are built at release time into the Python package, so an end user
// never runs npm. Nothing is fetched from a CDN at runtime: the PDF.js worker,
// KaTeX styles, and fonts are all bundled.
export default defineConfig({
  root: here,
  base: '/',
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: '../src/litmark/static',
    emptyOutDir: true,
    sourcemap: true,
    assetsDir: 'assets',
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
          editor: ['@codemirror/view', '@codemirror/state', '@codemirror/lang-markdown'],
          katex: ['katex'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `litmark serve --dev-origin http://127.0.0.1:5173`
      '/api': { target: 'http://127.0.0.1:8765', changeOrigin: false },
      '/apple-touch-icon.png': { target: 'http://127.0.0.1:8765', changeOrigin: false },
      '/manifest.webmanifest': { target: 'http://127.0.0.1:8765', changeOrigin: false },
    },
  },
})

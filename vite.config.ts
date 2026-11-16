import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Pré-carrega as duas fontes da primeira tela (texto e títulos). Sem isso o
 * navegador só descobre a fonte depois de baixar e ler o CSS, e o texto pisca.
 */
function preloadFonts(): Plugin {
  const wanted = [/barlow-latin-400-normal-[\w-]+\.woff2$/, /barlow-condensed-latin-600-normal-[\w-]+\.woff2$/]
  let base = '/'
  return {
    name: 'preload-fonts',
    apply: 'build',
    configResolved(c) { base = c.base },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => wanted.some((r) => r.test(f)))
        return {
          html,
          tags: files.map((f) => ({
            tag: 'link',
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: base + f, crossorigin: '' },
            injectTo: 'head' as const,
          })),
        }
      },
    },
  }
}

// VITE_BASE: caminho de publicação (ex.: "/checklist/" no GitHub Pages). Padrão "/".
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), preloadFonts()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})

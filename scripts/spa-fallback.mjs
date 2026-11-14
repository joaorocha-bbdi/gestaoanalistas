// GitHub Pages não tem rewrite de SPA: copia index.html para 404.html.
import { copyFileSync } from 'node:fs'
copyFileSync('dist/index.html', 'dist/404.html')
console.log('404.html criado para fallback de rotas.')

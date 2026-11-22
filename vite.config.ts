import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

function emitDemoHtmlPlugin(): Plugin {
  return {
    name: 'emit-demo-html',
    closeBundle() {
      const distDir = path.resolve(process.cwd(), 'dist')
      const rawHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')
      const builtHtml = rawHtml.replace(
        /<script\s+type="module"\s+src="\/src\/main\.ts"><\/script>/,
        '<script src="/private-pdp-assistant.js" defer></script>',
      )
      fs.writeFileSync(path.join(distDir, 'index.html'), builtHtml, 'utf8')

      const faviconSrc = path.resolve(process.cwd(), 'public', 'favicon.svg')
      if (fs.existsSync(faviconSrc)) {
        fs.copyFileSync(faviconSrc, path.join(distDir, 'favicon.svg'))
      }

      const productsSrc = path.resolve(process.cwd(), 'public', 'products')
      if (fs.existsSync(productsSrc)) {
        fs.cpSync(productsSrc, path.join(distDir, 'products'), { recursive: true })
      }
    },
    configureServer(server) {
      server.middlewares.use('/products', (req, res, next) => {
        const cleanRel = (req.url || '').split('?')[0].replace(/^\/+/, '')
        if (!cleanRel || cleanRel.includes('..')) return next()
        const filePath = path.resolve(process.cwd(), 'public', 'products', cleanRel)
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return next()
        const ext = path.extname(filePath).toLowerCase()
        const mime =
          ext === '.webp'
            ? 'image/webp'
            : ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : ext === '.png'
                ? 'image/png'
                : 'application/octet-stream'
        res.setHeader('Content-Type', mime)
        fs.createReadStream(filePath).pipe(res)
      })
    },
  }
}

export default defineConfig({
  publicDir: false,
  plugins: [emitDemoHtmlPlugin()],
  server: {
    cors: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
  build: {
    lib: {
      entry: 'src/main.ts',
      name: 'PrivatePDPAssistantBundle',
      formats: ['iife'],
      fileName: () => 'private-pdp-assistant.js',
    },
    target: 'es2020',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    minify: 'oxc',
  },
})

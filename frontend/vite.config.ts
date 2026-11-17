import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendPort = process.env.WEFT_BACKEND_PORT ?? '8000'
const repository = new URL('..', import.meta.url)
const channel = existsSync(new URL('.weft-dev', repository)) ? 'dev' : 'prod'

function currentBuild() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  define: {
    __WEFT_VERSION__: JSON.stringify(readFileSync(new URL('VERSION', repository), 'utf8').trim()),
    __WEFT_CHANNEL__: JSON.stringify(channel),
    __WEFT_BUILD__: JSON.stringify(currentBuild()),
  },
  plugins: [
    react(),
    {
      name: 'release-channel-title',
      transformIndexHtml: (html) => channel === 'dev' ? html.replace('<title>Weft</title>', '<title>Weft - Dev</title>') : html,
    },
    {
      name: 'distribution-notices',
      apply: 'build',
      generateBundle() {
        const rolldown = JSON.parse(readFileSync(new URL('./node_modules/rolldown/package.json', import.meta.url), 'utf8'))
        if (rolldown.version !== '1.1.4') {
          this.error('Update the retained Rolldown third-party runtime notices for this version before building.')
        }
        for (const [fileName, sourcePath] of [
          ['LICENSE', '../LICENSE'],
          ['NOTICE', '../NOTICE'],
          ['THIRD_PARTY_NOTICES.md', '../THIRD_PARTY_NOTICES.md'],
          ['rolldown.txt', './node_modules/rolldown/LICENSE'],
          ['rolldown-third-party.txt', './notices/rolldown-third-party.txt'],
          ['instrument-sans.txt', './node_modules/@fontsource-variable/instrument-sans/LICENSE'],
        ]) {
          this.emitFile({
            type: 'asset',
            fileName: `licenses/${fileName}`,
            source: readFileSync(new URL(sourcePath, import.meta.url)),
          })
        }
      },
    },
  ],
  build: {
    license: { fileName: 'licenses/frontend-dependencies.md' },
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'react-runtime', test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
      '/login': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
    },
  },
})

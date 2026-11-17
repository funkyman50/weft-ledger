import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/instrument-sans/index.css'
import App from './App.tsx'
import { RuntimeErrorBoundary } from './components/RuntimeErrorBoundary'
import { installBrowserDiagnostics, recordBrowserError } from './lib/diagnostics'

installBrowserDiagnostics(import.meta.url)

createRoot(document.getElementById('root')!, {
  onCaughtError: (error) => recordBrowserError('browser.render_error', error),
  onUncaughtError: (error) => recordBrowserError('browser.render_error', error),
  onRecoverableError: (error) => recordBrowserError('browser.render_recovered', error),
}).render(
  <StrictMode>
    <RuntimeErrorBoundary><App /></RuntimeErrorBoundary>
  </StrictMode>,
)

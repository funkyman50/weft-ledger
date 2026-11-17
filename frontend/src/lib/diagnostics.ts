import { downloadFile } from './download'

type DiagnosticFields = {
  diagnostic_id?: string | null
  ledger_request_id?: string
  method?: string
  status?: number
  duration_ms?: number
  code?: string
  error_type?: string
  plaid_error_code?: string
  plaid_error_type?: string
  plaid_request_id?: string
  account_count?: number
  frames?: Array<{ file: string; line: number; column: number }>
}

type BrowserEvent = DiagnosticFields & { time: string; event: string; level: 'info' | 'warning' | 'error' }
const recent: BrowserEvent[] = []
const important: BrowserEvent[] = []
const startedAt = new Date().toISOString()
let build = import.meta.env.MODE === 'development' ? 'development' : 'production'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function diagnosticId(value: string | null): string | undefined {
  return value && uuidPattern.test(value) ? value.toLowerCase() : undefined
}

export function newDiagnosticId(): string | undefined {
  try { return crypto.randomUUID() } catch { return undefined }
}

export function recordDiagnostic(event: string, level: BrowserEvent['level'], fields: DiagnosticFields = {}) {
  try {
    const entry: BrowserEvent = { time: new Date().toISOString(), event, level }
    for (const key of ['diagnostic_id', 'ledger_request_id'] as const) {
      const value = fields[key]
      if (typeof value === 'string' && diagnosticId(value)) entry[key] = value
    }
    for (const key of ['status', 'duration_ms', 'account_count'] as const) {
      const value = fields[key]
      if (typeof value === 'number' && Number.isFinite(value)) entry[key] = Math.round(value * 100) / 100
    }
    if (fields.method && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(fields.method)) entry.method = fields.method
    if (fields.code && /^[a-z][a-z0-9_]{0,95}$/.test(fields.code)) entry.code = fields.code
    for (const key of ['plaid_error_code', 'plaid_error_type'] as const) {
      const value = fields[key]
      if (value && /^[A-Z][A-Z0-9_]{0,95}$/.test(value)) entry[key] = value
    }
    if (fields.plaid_request_id && /^[a-zA-Z0-9_-]{1,128}$/.test(fields.plaid_request_id)) entry.plaid_request_id = fields.plaid_request_id
    if (fields.error_type && /^(Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError|AbortError|ApiError|ResourceError)$/.test(fields.error_type)) entry.error_type = fields.error_type
    if (fields.frames) entry.frames = fields.frames.slice(-12)
    const buffer = level === 'info' ? recent : important
    buffer.push(entry)
    if (buffer.length > (level === 'info' ? 150 : 50)) buffer.shift()
  } catch {}
}

export function recordPlaidLinkExit(error: { error_code?: string; error_type?: string; request_id?: string | null } | null) {
  recordDiagnostic(error ? 'plaid.link_failed' : 'plaid.link_cancelled', error ? 'error' : 'info', {
    plaid_error_code: error?.error_code, plaid_error_type: error?.error_type, plaid_request_id: error?.request_id ?? undefined,
  })
}

export function recordBrowserError(event: string, error: unknown, fields: DiagnosticFields = {}) {
  try {
    const frames: NonNullable<DiagnosticFields['frames']> = []
    if (error instanceof Error && typeof error.stack === 'string') {
      const prefix = `${error.name}: ${error.message}`
      const stack = error.stack.startsWith(prefix) ? error.stack.slice(prefix.length) : error.stack
      for (const line of stack.split('\n')) {
        if (!/^\s*at /.test(line) && !/^[^@]*@https?:\/\//.test(line)) continue
        const frame = line.match(/(https?:\/\/[^/\s]+)\/(src\/[a-zA-Z0-9_/-]+\.(?:tsx?|jsx?)|assets\/[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+\.js)(?:\?[^\s:]*)?:(\d+):(\d+)/)
        if (frame && frame[1] === window.location.origin) frames.push({ file: frame[2].split('/').pop()!, line: Number(frame[3]), column: Number(frame[4]) })
      }
    }
    recordDiagnostic(event, 'error', { ...fields, error_type: error instanceof Error ? error.name : 'Error', frames })
  } catch { recordDiagnostic(event, 'error', { ...fields, error_type: 'Error' }) }
}

export function installBrowserDiagnostics(entryUrl: string) {
  const bundle = new URL(entryUrl).pathname.split('/').pop() ?? ''
  if (/^index-[a-zA-Z0-9_-]+\.js$/.test(bundle)) build = bundle
  window.addEventListener('error', (event) => {
    if (event instanceof ErrorEvent) recordBrowserError('browser.error', event.error)
    else recordDiagnostic('browser.resource_error', 'error', { error_type: 'ResourceError' })
  }, true)
  window.addEventListener('unhandledrejection', (event) => recordBrowserError('browser.unhandled_rejection', event.reason))
  recordDiagnostic('browser.started', 'info')
}

export function downloadDiagnostics(server: unknown = null) {
  const report = {
    generated_at: new Date().toISOString(), scope: server === null ? 'browser_only' : 'server_and_browser',
    server,
    browser: { started_at: startedAt, build, limits: { ordinary_events: 150, warning_error_events: 50 }, events: [...recent, ...important].sort((a, b) => a.time.localeCompare(b.time)) },
  }
  downloadFile(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `weft-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
}

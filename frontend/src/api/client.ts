import { diagnosticId, newDiagnosticId, recordBrowserError, recordDiagnostic } from '../lib/diagnostics'

interface AppError {
  code: string
  message: string
  detail?: unknown
}

export class ApiError extends Error {
  code: string
  detail?: unknown
  status: number
  diagnosticId?: string

  constructor(status: number, error: AppError, requestDiagnosticId?: string) {
    super(error.message)
    this.name = 'ApiError'
    this.code = error.code
    this.detail = error.detail
    this.status = status
    this.diagnosticId = requestDiagnosticId
  }
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

type Unauthorized401Handler = () => void

type LedgerWriteMetadata = { requestId: string; sequence: number; epoch: string }
type PendingLedgerWrite = LedgerWriteMetadata & { session: string; databaseGeneration: string; local: boolean }
type LedgerWriteSubscriber = () => void

type LedgerHistoryTransport = {
  session: string
  epoch: string | null
  sequence: number
  unresolved: PendingLedgerWrite | null
  reloadReason: 'database_changed' | 'outcome_expired' | null
  databaseGeneration: string | null
  recoveryRequired: boolean
  subscriber: LedgerWriteSubscriber | null
  registration: 'pending' | 'failed' | 'ready'
  pending: number
  storageUnavailable: boolean
}

let onUnauthorized: Unauthorized401Handler | null = null
let ledgerHistory: LedgerHistoryTransport | null = null
let writeTail: Promise<void> = Promise.resolve()

const pendingWriteKey = 'weft.pending-local-save'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readPendingWrite(): PendingLedgerWrite | null {
  const stored = sessionStorage.getItem(pendingWriteKey)
  if (!stored) return null
  const value = JSON.parse(stored) as PendingLedgerWrite
  if (!value || value.local !== true || ![value.session, value.epoch, value.requestId, value.databaseGeneration].every((id) => typeof id === 'string' && uuidPattern.test(id)) || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    sessionStorage.removeItem(pendingWriteKey)
    throw new Error('Saved request identity is invalid.')
  }
  return value
}

function clearPendingWrite(requestId: string, history: LedgerHistoryTransport) {
  try {
    if (readPendingWrite()?.requestId === requestId) sessionStorage.removeItem(pendingWriteKey)
  } catch { history.storageUnavailable = true }
}

export function ledgerHistoryStorageUnavailable(session: string) {
  return ledgerHistory?.session === session && ledgerHistory.storageUnavailable
}

export function setUnauthorizedHandler(handler: Unauthorized401Handler | null) {
  onUnauthorized = handler
}

export function beginLedgerHistorySession() {
  const session = crypto.randomUUID()
  let unresolved: PendingLedgerWrite | null = null
  let storageUnavailable = false
  try { unresolved = readPendingWrite() } catch { storageUnavailable = true }
  ledgerHistory = { session, epoch: null, sequence: 0, unresolved, reloadReason: null, databaseGeneration: null, recoveryRequired: false, subscriber: null, registration: 'pending', pending: 0, storageUnavailable }
  return session
}

export function endLedgerHistorySession(session?: string) {
  if (!session) {
    ledgerHistory = null
    return
  }
  if (ledgerHistory?.session === session) {
    queueMicrotask(() => {
      if (ledgerHistory?.session === session && ledgerHistory.subscriber === null) {
        ledgerHistory = null
      }
    })
  }
}

export function setLedgerHistorySubscriber(session: string, subscriber: LedgerWriteSubscriber | null) {
  if (ledgerHistory?.session === session) ledgerHistory.subscriber = subscriber
}

export function adoptLedgerHistoryState(session: string, epoch: string, databaseGeneration?: string) {
  if (ledgerHistory?.session === session) {
    const previousGeneration = ledgerHistory.databaseGeneration ?? ledgerHistory.unresolved?.databaseGeneration
    if (databaseGeneration && previousGeneration && previousGeneration !== databaseGeneration) {
      if (ledgerHistory.unresolved?.local) clearPendingWrite(ledgerHistory.unresolved.requestId, ledgerHistory)
      ledgerHistory.reloadReason = 'database_changed'
      recordDiagnostic('ledger.generation_changed', 'warning')
      return false
    }
    if (ledgerHistory.epoch && ledgerHistory.epoch !== epoch) {
      ledgerHistory.recoveryRequired = true
      if (ledgerHistory.unresolved && !ledgerHistory.unresolved.local) {
        ledgerHistory.reloadReason = 'outcome_expired'
      }
      return false
    }
    if (databaseGeneration) ledgerHistory.databaseGeneration = databaseGeneration
    ledgerHistory.epoch = epoch
    ledgerHistory.registration = ledgerHistory.recoveryRequired ? 'pending' : 'ready'
    return true
  }
  return false
}

export function ledgerHistoryReloadReason(session: string) {
  return ledgerHistory?.session === session ? ledgerHistory.reloadReason : null
}

export function ledgerHistoryRecoveryRequired(session: string) {
  return ledgerHistory?.session === session ? ledgerHistory.recoveryRequired : false
}

export async function drainLedgerHistoryForRecovery(session: string, inspectUnresolved = false) {
  const history = ledgerHistory
  if (!history || history.session !== session || history.reloadReason) return false
  history.recoveryRequired = true
  await writeTail
  if (ledgerHistory !== history || history.pending || (history.unresolved && !inspectUnresolved)) return false
  return true
}

export function renewLedgerHistoryState(session: string, epoch: string, databaseGeneration: string, inspectUnresolved = false) {
  const history = ledgerHistory
  if (!history || history.session !== session || history.pending || (history.unresolved && !inspectUnresolved) || history.reloadReason) return false
  if (history.databaseGeneration !== databaseGeneration) {
    history.reloadReason = 'database_changed'
    recordDiagnostic('ledger.generation_changed', 'warning')
    return false
  }
  ledgerHistory = { ...history, epoch, sequence: history.epoch === epoch ? history.sequence : 0, registration: 'pending', recoveryRequired: true }
  return true
}

export function finishLedgerHistoryRecovery(session: string, epoch: string, databaseGeneration: string, requestId?: string) {
  if (!adoptLedgerHistoryState(session, epoch, databaseGeneration)) return false
  if (!ledgerHistory || ledgerHistory.session !== session || (ledgerHistory.unresolved && ledgerHistory.unresolved.requestId !== requestId) || ledgerHistory.pending || ledgerHistory.reloadReason) return false
  if (ledgerHistory.unresolved) {
    if (ledgerHistory.unresolved.local) clearPendingWrite(ledgerHistory.unresolved.requestId, ledgerHistory)
    ledgerHistory.unresolved = null
  }
  ledgerHistory.recoveryRequired = false
  ledgerHistory.registration = 'ready'
  return true
}

export function ledgerHistoryReloadRequired(session: string) {
  return ledgerHistory?.session === session && ledgerHistory.reloadReason !== null
}

export function markLedgerHistoryRegistrationFailed(session: string) {
  if (ledgerHistory?.session === session) ledgerHistory.registration = 'failed'
}

export function unresolvedLedgerHistoryRequest(session: string) {
  return ledgerHistory?.session === session ? ledgerHistory.unresolved : null
}

export function ledgerHistoryEpoch(session: string) {
  return ledgerHistory?.session === session ? ledgerHistory.epoch : null
}

export function requireLedgerOutcomeReload(session: string) {
  if (ledgerHistory?.session === session) {
    ledgerHistory.reloadReason = 'outcome_expired'
  }
}

async function parseError(response: Response): Promise<AppError> {
  try {
    const body = await response.json()
    if (body && typeof body === 'object' && 'error' in body) {
      return body.error as AppError
    }
  } catch {}
  return { code: 'unknown_error', message: response.statusText || 'Request failed' }
}

async function fetchResponse(path: string, init: RequestInit | undefined, metadata?: LedgerWriteMetadata): Promise<Response> {
  const headers = new Headers(init?.headers)
  const requestDiagnosticId = newDiagnosticId()
  if (requestDiagnosticId) headers.set('X-Diagnostic-ID', requestDiagnosticId)
  if (init?.body instanceof FormData) headers.delete('Content-Type')
  else if (!headers.has('Content-Type') && init?.body !== undefined) headers.set('Content-Type', 'application/json')
  const historyAtRequest = ledgerHistory
  const isGet = !init?.method || init.method === 'GET'
  if (historyAtRequest && (isGet || metadata)) {
    headers.set('X-Ledger-Session', historyAtRequest.session)
    if (metadata) {
      headers.set('X-Ledger-Request', metadata.requestId)
      headers.set('X-Ledger-Sequence', String(metadata.sequence))
      if (historyAtRequest.epoch) headers.set('X-Ledger-Epoch', historyAtRequest.epoch)
    }
  }
  const started = performance.now()
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init, headers })
  } catch (error) {
    const timedOut = init?.signal?.reason instanceof DOMException && init.signal.reason.name === 'TimeoutError'
    const aborted = init?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')
    recordDiagnostic(timedOut ? 'request.timed_out' : aborted ? 'request.aborted' : 'request.network_failed', aborted && !timedOut ? 'info' : 'error', { diagnostic_id: requestDiagnosticId, ledger_request_id: metadata?.requestId, method: init?.method ?? 'GET', duration_ms: performance.now() - started })
    throw error
  }
  const responseDiagnosticId = diagnosticId(response.headers.get('X-Diagnostic-ID')) ?? requestDiagnosticId
  const duration = performance.now() - started
  const recordResponse = (code?: string) => recordDiagnostic('request.completed', response.status >= 500 ? 'error' : response.status >= 400 || duration >= 1000 ? 'warning' : 'info', { diagnostic_id: responseDiagnosticId, ledger_request_id: metadata?.requestId, method: init?.method ?? 'GET', status: response.status, duration_ms: duration, code })

  if (response.status === 401) {
    recordResponse()
    if (ledgerHistory === historyAtRequest) onUnauthorized?.()
    throw new ApiError(401, await parseError(response), responseDiagnosticId)
  }

  if (historyAtRequest && ledgerHistory !== historyAtRequest) {
    recordResponse('stale_ledger_session')
    throw new ApiError(409, {
      code: metadata ? 'ledger_response_superseded' : 'stale_ledger_session',
      message: metadata ? 'The save response belongs to an earlier session. Check its result before trying again.' : 'This response belongs to an earlier session. Refresh and try again.',
    }, responseDiagnosticId)
  }

  if (!response.ok) {
    const error = await parseError(response)
    recordResponse(error.code)
    throw new ApiError(response.status, error, responseDiagnosticId)
  }

  recordResponse()
  return response
}

async function responseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch (error) {
    recordBrowserError('request.decode_failed', error, { diagnostic_id: diagnosticId(response.headers.get('X-Diagnostic-ID')), status: response.status })
    throw error
  }
}

async function readRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchResponse(path, init)

  if (response.status === 204) {
    return undefined as T
  }

  return responseJson<T>(response)
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The request was aborted.', 'AbortError')
}

async function writeRequest<T>(path: string, body: unknown, init: RequestInit, local = true): Promise<T> {
  const previous = writeTail
  let release!: () => void
  writeTail = new Promise<void>((resolve) => { release = resolve })
  const submittingHistory = ledgerHistory
  if (submittingHistory) submittingHistory.pending += 1
  await previous
  let historyAtStart: LedgerHistoryTransport | null = null
  let metadata: PendingLedgerWrite | undefined
  let uncertain = false
  let sent = false
  try {
    throwIfAborted(init.signal ?? undefined)
    if (submittingHistory && ledgerHistory !== submittingHistory) {
      throw new ApiError(409, {
        code: 'stale_ledger_session',
        message: 'This save belongs to an earlier session. Refresh and try again.',
      })
    }
    historyAtStart = submittingHistory
    if (historyAtStart?.reloadReason) {
      throw new ApiError(409, {
        code: 'ledger_reload_required',
        message: 'This page is out of date. Reload the register before saving.',
      })
    }
    if (historyAtStart?.unresolved) {
      throw new ApiError(409, {
        code: 'ledger_outcome_inspection_required',
        message: 'Inspect the previous save before sending another command.',
      })
    }
    if (historyAtStart?.recoveryRequired) {
      throw new ApiError(409, {
        code: 'history_recovery_required',
        message: 'The register is refreshing. Your unsaved work is still here. Try again after refresh finishes.',
      })
    }
    if (historyAtStart && !historyAtStart.epoch) {
      throw new ApiError(409, {
        code: 'history_registration_required',
        message: historyAtStart.registration === 'failed'
          ? 'Ledger history could not be loaded. Refresh and try again.'
          : 'Ledger history is still loading. Try again in a moment.',
      })
    }
    metadata = historyAtStart ? { requestId: crypto.randomUUID(), sequence: historyAtStart.sequence + 1, epoch: historyAtStart.epoch!, session: historyAtStart.session, databaseGeneration: historyAtStart.databaseGeneration!, local } : undefined
    if (metadata && historyAtStart) historyAtStart.sequence = metadata.sequence
    if (metadata?.local && historyAtStart) {
      try { sessionStorage.setItem(pendingWriteKey, JSON.stringify(metadata)) } catch { historyAtStart.storageUnavailable = true }
    }
    sent = true
    const response = await fetchResponse(path, {
      ...init,
      body: body === undefined ? undefined : JSON.stringify(body),
    }, metadata)
    if (response.status === 204) return undefined as T
    return await responseJson<T>(response)
  } catch (error) {
    if (sent && historyAtStart && error instanceof ApiError && (error.code === 'history_expired' || error.code === 'history_epoch_stale')) historyAtStart.recoveryRequired = true
    uncertain = sent && (!(error instanceof ApiError) || error.status >= 500 || error.code === 'history_request_stale' || error.code === 'ledger_response_superseded')
    if (uncertain && historyAtStart && metadata && ledgerHistory === historyAtStart && historyAtStart.unresolved === null) {
      historyAtStart.unresolved = metadata
      recordDiagnostic('ledger.outcome_unknown', 'error', { ledger_request_id: metadata.requestId, diagnostic_id: error instanceof ApiError ? error.diagnosticId : undefined })
    }
    if (!sent && error instanceof ApiError) recordDiagnostic('ledger.write_blocked', 'warning', { code: error.code })
    throw error
  } finally {
    if (sent && !uncertain && metadata?.local && historyAtStart) clearPendingWrite(metadata.requestId, historyAtStart)
    release()
    if (submittingHistory && submittingHistory.pending > 0) submittingHistory.pending -= 1
    if (submittingHistory && ledgerHistory === submittingHistory && submittingHistory.pending === 0) {
      submittingHistory.subscriber?.()
    }
  }
}

function filenameFromDisposition(value: string | null): string | null {
  const match = value?.match(/filename="?([^";]+)"?/)
  return match?.[1] ?? null
}

export const apiClient = {
  get: <T>(path: string, signal?: AbortSignal) => readRequest<T>(path, signal ? { signal } : undefined),
  postQuery: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    readRequest<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal }),
  providerPost: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    readRequest<T>(path, { method: 'POST', body: JSON.stringify(body), signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    writeRequest<T>(path, body, { method: 'POST', signal }),
  providerCommand: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    writeRequest<T>(path, body, { method: 'POST', signal }, false),
  providerDelete: <T>(path: string, body?: unknown) => writeRequest<T>(path, body, { method: 'DELETE' }, false),
  postDownload: async (path: string, body: unknown, signal?: AbortSignal) => {
    const response = await fetchResponse(path, { method: 'POST', body: JSON.stringify(body), signal })
    return { blob: await response.blob(), filename: filenameFromDisposition(response.headers.get('Content-Disposition')) }
  },
  postMultipart: <T>(path: string, body: FormData, signal?: AbortSignal) =>
    readRequest<T>(path, { method: 'POST', body, signal }),
  put: <T>(path: string, body?: unknown) => writeRequest<T>(path, body, { method: 'PUT' }),
  patch: <T>(path: string, body?: unknown) => writeRequest<T>(path, body, { method: 'PATCH' }),
  delete: <T>(path: string, body?: unknown) => writeRequest<T>(path, body, { method: 'DELETE' }),
}

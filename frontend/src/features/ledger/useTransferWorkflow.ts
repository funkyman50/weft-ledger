import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import { invalidateAccountAndTransactionQueries } from '../../api/hooks'
import type { ComparisonRowEdits, BulkTransferQueueStart, LedgerHistoryOutcome, LedgerRow, LedgerTarget, TransferCommandResult, TransferContext, TransferReviewContextRequest } from '../../api/types'

export type TransferDialogState = {
  sourceId: number
  draftSource: { accountId: number; draftId: number } | null
  context: TransferContext | null
  loading: boolean
  writing: boolean
  outcomeUnknown: boolean
  error: string | null
} | null

type TransferQueue = BulkTransferQueueStart & {
  index: number
  saved: number
  skipped: number
  uncertain: number
  initialToken: boolean
  inspectionRequired: boolean
}

export type TransferQueueSummary = {
  saved: number
  skipped: number
  remaining: number
  uncertain: number
}

function appendCandidates(context: TransferContext, previous: TransferContext | null | undefined): TransferContext {
  const candidates = previous
    ? [...previous.candidates, ...context.candidates.filter((row) => !previous.candidates.some((existing) => existing.id === row.id))]
    : context.candidates
  return { ...context, candidates }
}

export function useTransferWorkflow({
  onError,
  onChanged,
  onQueueFinished,
  onDraftCommitted,
  onSavedCommitted,
}: {
  onError: (message: string) => void
  onChanged: () => void
  onQueueFinished?: (summary: TransferQueueSummary) => void
  onDraftCommitted?: (draftId: number, saved?: LedgerRow) => void
  onSavedCommitted?: (sourceId: number) => void
}) {
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<TransferDialogState>(null)
  const [queue, setQueue] = useState<TransferQueue | null>(null)
  const dialogRef = useRef<TransferDialogState>(null)
  const queueRef = useRef<TransferQueue | null>(null)
  dialogRef.current = dialog
  queueRef.current = queue
  const requestGeneration = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const submittingRef = useRef(false)
  const mountedRef = useRef(true)

  const replaceQueue = useCallback((next: TransferQueue | null) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
    }
  }, [])

  const invalidate = useCallback(() => {
    void invalidateAccountAndTransactionQueries(queryClient)
  }, [queryClient])

  const load = useCallback(async (sourceId: number, scope: 'nearby' | 'all', candidateId?: number | null, cursor?: string | null) => {
    const generation = ++requestGeneration.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setDialog((current) => current?.sourceId === sourceId
      ? { ...current, loading: true, writing: false, error: null }
      : { sourceId, draftSource: null, context: null, loading: true, writing: false, outcomeUnknown: false, error: null })
    try {
      const params = new URLSearchParams({ scope })
      if (candidateId !== undefined && candidateId !== null) params.set('candidate_id', String(candidateId))
      if (cursor) params.set('cursor', cursor)
      const context = await apiClient.get<TransferContext>(`/api/transactions/${sourceId}/transfer-context?${params}`, controller.signal)
      if (!mountedRef.current || requestGeneration.current !== generation || queueRef.current) return null
      setDialog((current) => {
        if (requestGeneration.current !== generation || current?.sourceId !== sourceId) return current
        return { sourceId, draftSource: null, context: appendCandidates(context, cursor ? current?.context : null), loading: false, writing: false, outcomeUnknown: false, error: null }
      })
      return context
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current || requestGeneration.current !== generation) return null
      const detail = apiErrorMessage(error, 'The transfer workflow could not be loaded.')
      setDialog((current) => current?.sourceId === sourceId ? { ...current, loading: false, error: detail } : current)
      onError(detail)
      return null
    }
  }, [onError])

  const loadQueue = useCallback(async (
    currentQueue: TransferQueue,
    scope: 'nearby' | 'all',
    candidateId?: number | null,
    cursor?: string | null,
    fresh = false,
  ) => {
    const entry = currentQueue.entries[currentQueue.index]
    if (!entry) return null
    if (entry.proposal === null) {
      const generation = ++requestGeneration.current
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      const previousContext = dialogRef.current?.sourceId === entry.id ? dialogRef.current.context : null
      setDialog({ sourceId: entry.id, draftSource: null, context: previousContext, loading: true, writing: false, outcomeUnknown: false, error: null })
      try {
        const params = new URLSearchParams({ scope })
        if (candidateId !== undefined && candidateId !== null) params.set('candidate_id', String(candidateId))
        if (cursor) params.set('cursor', cursor)
        const context = await apiClient.get<TransferContext>(`/api/transactions/${entry.id}/transfer-context?${params}`, controller.signal)
        if (!mountedRef.current || requestGeneration.current !== generation || queueRef.current !== currentQueue) return null
        if (!fresh && currentQueue.initialToken && context.source?.edit_token !== entry.edit_token) {
          replaceQueue({ ...currentQueue, initialToken: false })
          setDialog({ sourceId: entry.id, draftSource: null, context: null, loading: false, writing: false, outcomeUnknown: false, error: 'The source transaction changed. Refresh, Skip, or Exit the queue.' })
          return null
        }
        replaceQueue({ ...currentQueue, initialToken: false, inspectionRequired: false })
        setDialog({ sourceId: entry.id, draftSource: null, context: appendCandidates(context, cursor ? previousContext : null), loading: false, writing: false, outcomeUnknown: false, error: null })
        return context
      } catch (error) {
        if (controller.signal.aborted || !mountedRef.current || requestGeneration.current !== generation || queueRef.current !== currentQueue) return null
        setDialog((active) => active?.sourceId === entry.id ? { ...active, context: null, loading: false, writing: false, error: apiErrorMessage(error, 'The transfer workflow could not be loaded.') } : active)
        return null
      }
    }
    const generation = ++requestGeneration.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const previousContext = dialogRef.current?.sourceId === entry.id
      ? dialogRef.current.context
      : null
    setDialog({ sourceId: entry.id, draftSource: null, context: previousContext, loading: true, writing: false, outcomeUnknown: currentQueue.inspectionRequired, error: null })
    const body: TransferReviewContextRequest = {
      proposal: entry.proposal,
      scope,
      ...(candidateId !== undefined && candidateId !== null ? { candidate_id: candidateId } : {}),
      ...(cursor ? { cursor } : {}),
      ...(!fresh && currentQueue.initialToken ? { expected_edit_token: entry.edit_token } : {}),
    }
    try {
      const context = await apiClient.postQuery<TransferContext>(`/api/transactions/${entry.id}/transfer-review-context`, body, controller.signal)
      if (!mountedRef.current || requestGeneration.current !== generation || queueRef.current?.entries !== currentQueue.entries || queueRef.current.index !== currentQueue.index) return null
      replaceQueue({ ...queueRef.current, initialToken: false, inspectionRequired: false })
      setDialog((active) => {
        if (requestGeneration.current !== generation || active?.sourceId !== entry.id) return active
        return { sourceId: entry.id, draftSource: null, context: appendCandidates(context, cursor ? previousContext : null), loading: false, writing: false, outcomeUnknown: false, error: null }
      })
      return context
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current || requestGeneration.current !== generation) return null
      if (queueRef.current?.entries !== currentQueue.entries || queueRef.current.index !== currentQueue.index) return null
      setDialog((active) => active?.sourceId === entry.id
        ? { ...active, context: null, loading: false, writing: false, error: apiErrorMessage(error, 'The transfer review could not be loaded.') }
        : active)
      return null
    }
  }, [replaceQueue])

  const finishQueue = useCallback((currentQueue: TransferQueue, notify: boolean) => {
    requestGeneration.current += 1
    controllerRef.current?.abort()
    replaceQueue(null)
    setDialog(null)
    if (notify) onQueueFinished?.({
      saved: currentQueue.saved,
      skipped: currentQueue.skipped,
      remaining: currentQueue.entries.length - currentQueue.index,
      uncertain: currentQueue.uncertain,
    })
  }, [onQueueFinished, replaceQueue])

  const advanceQueue = useCallback((currentQueue: TransferQueue, kind: 'saved' | 'skipped') => {
    const next = {
      ...currentQueue,
      index: currentQueue.index + 1,
      saved: currentQueue.saved + (kind === 'saved' ? 1 : 0),
      skipped: currentQueue.skipped + (kind === 'skipped' ? 1 : 0),
      initialToken: true,
      inspectionRequired: false,
    }
    if (next.index >= next.entries.length) {
      finishQueue(next, true)
      return
    }
    replaceQueue(next)
    void loadQueue(next, 'nearby')
  }, [finishQueue, loadQueue, replaceQueue])

  const submit = useCallback(async (kind: 'link' | 'counterpart' | 'save_unlinked', candidateId?: number, row_edits: ComparisonRowEdits = {}) => {
    const current = dialogRef.current
    if (!current?.context || current.loading || submittingRef.current || current.outcomeUnknown || queueRef.current) return null
    if (kind === 'save_unlinked' && !current.context.proposal) return null
    const submissionGeneration = requestGeneration.current
    const sourceId = current.sourceId
    submittingRef.current = true
    setDialog((active) => active?.sourceId === sourceId ? { ...active, writing: true, error: null } : active)
    try {
      if (current.context.proposal) {
        const intent = kind === 'counterpart' ? 'create_counterpart' : kind
        const result = await apiClient.post<TransferCommandResult>(current.draftSource ? '/api/transactions/transfer-draft' : `/api/transactions/${sourceId}/transfer-review`, {
          proposal: current.context.proposal,
          row_edits,
          context_token: current.context.context_token,
          intent,
          ...(candidateId !== undefined ? { candidate_id: candidateId } : current.context.candidate ? { candidate_id: current.context.candidate.id } : {}),
          ...(current.draftSource ? { account_id: current.draftSource.accountId } : {}),
        })
        const isCurrent = mountedRef.current && requestGeneration.current === submissionGeneration && dialogRef.current?.sourceId === sourceId
        void invalidateAccountAndTransactionQueries(queryClient, { refetchLedger: !current.draftSource || !isCurrent, refetchAccounts: true })
        if (isCurrent) {
          setDialog(null)
          if (current.draftSource) onDraftCommitted?.(current.draftSource.draftId, result.source)
          else onSavedCommitted?.(sourceId)
          onChanged()
        }
        return result
      }
      const path = kind === 'link' ? 'transfer-link' : 'transfer-counterpart'
      const body = kind === 'link'
        ? { candidate_id: candidateId, context_token: current.context.context_token, row_edits }
        : { context_token: current.context.context_token, row_edits, ...(current.context.candidate ? { candidate_id: current.context.candidate.id } : {}) }
      const result = await apiClient.post<TransferCommandResult>(`/api/transactions/${sourceId}/${path}`, body)
      invalidate()
      if (!mountedRef.current || requestGeneration.current !== submissionGeneration || dialogRef.current?.sourceId !== sourceId) return result
      setDialog((active) => active?.sourceId === sourceId ? null : active)
      onChanged()
      return result
    } catch (error) {
      if (!mountedRef.current || requestGeneration.current !== submissionGeneration || dialogRef.current?.sourceId !== sourceId) return null
      if (error instanceof ApiError && error.code === 'transfer_context_stale') {
        const detail = 'The transfer changed. Refresh the comparison before confirming again.'
        setDialog((active) => active?.sourceId === sourceId ? { ...active, writing: false, outcomeUnknown: false, error: detail } : active)
        onError(detail)
        return null
      }
      const knownFailure = error instanceof ApiError && error.status >= 400 && error.status < 500
      const detail = knownFailure ? error.message : 'The transfer write outcome is unknown. Refresh the transfer details before trying again.'
      setDialog((active) => active?.sourceId === sourceId ? { ...active, writing: false, outcomeUnknown: !knownFailure, error: detail } : active)
      onError(detail)
      return null
    } finally {
      submittingRef.current = false
    }
  }, [invalidate, onChanged, onDraftCommitted, onError, onSavedCommitted, queryClient])

  const submitQueue = useCallback(async (intent: 'link' | 'create_counterpart' | 'save_unlinked', candidateId?: number, row_edits: ComparisonRowEdits = {}) => {
    const current = dialogRef.current
    const currentQueue = queueRef.current
    const proposal = current?.context?.proposal
    if (!current?.context || !currentQueue || current.loading || current.writing || current.outcomeUnknown || currentQueue.inspectionRequired || submittingRef.current) return null
    if (intent === 'link' && candidateId === undefined) return null
    const submissionGeneration = requestGeneration.current
    const sourceId = current.sourceId
    submittingRef.current = true
    setDialog((active) => active?.sourceId === sourceId ? { ...active, writing: true, error: null } : active)
    const body = {
      ...(proposal ? { proposal } : {}),
      row_edits,
      context_token: current.context.context_token,
      ...(proposal ? { intent } : {}),
      ...(candidateId !== undefined ? { candidate_id: candidateId } : current.context.candidate ? { candidate_id: current.context.candidate.id } : {}),
    }
    try {
      const path = proposal ? 'transfer-review' : intent === 'link' ? 'transfer-link' : 'transfer-counterpart'
      const result = await apiClient.post<TransferCommandResult>(`/api/transactions/${sourceId}/${path}`, body)
      invalidate()
      if (!mountedRef.current || requestGeneration.current !== submissionGeneration || queueRef.current !== currentQueue || dialogRef.current?.sourceId !== sourceId) return result
      onChanged()
      advanceQueue(currentQueue, 'saved')
      return result
    } catch (error) {
      if (!mountedRef.current || requestGeneration.current !== submissionGeneration || queueRef.current !== currentQueue || dialogRef.current?.sourceId !== sourceId) return null
      const knownFailure = error instanceof ApiError && error.status >= 400 && error.status < 500
      if (knownFailure) {
        replaceQueue({ ...currentQueue, initialToken: false })
        setDialog((active) => active?.sourceId === sourceId ? { ...active, loading: false, writing: false, outcomeUnknown: false, error: error.code === 'transfer_context_stale' || error.code === 'transaction_edit_stale' ? 'The transfer changed. Refresh the comparison before confirming again.' : error.message } : active)
      } else {
        invalidate()
        replaceQueue({ ...currentQueue, uncertain: currentQueue.uncertain + 1, inspectionRequired: true })
        setDialog((active) => active?.sourceId === sourceId ? { ...active, writing: false, outcomeUnknown: true, error: 'The transfer write outcome is unknown. Refresh and inspect it before continuing.' } : active)
      }
      return null
    } finally {
      submittingRef.current = false
    }
  }, [advanceQueue, invalidate, onChanged, replaceQueue])

  const startQueue = useCallback((start: BulkTransferQueueStart) => {
    if (submittingRef.current || queueRef.current || start.entries.length === 0) return
    const currentQueue: TransferQueue = { ...start, index: 0, saved: 0, skipped: 0, uncertain: 0, initialToken: true, inspectionRequired: false }
    replaceQueue(currentQueue)
    void loadQueue(currentQueue, 'nearby')
  }, [loadQueue, replaceQueue])

  const skipQueue = useCallback(() => {
    const currentQueue = queueRef.current
    if (!currentQueue || submittingRef.current || currentQueue.inspectionRequired) return
    requestGeneration.current += 1
    controllerRef.current?.abort()
    advanceQueue(currentQueue, 'skipped')
  }, [advanceQueue])

  const exitQueue = useCallback(() => {
    const currentQueue = queueRef.current
    if (!currentQueue || submittingRef.current) return
    finishQueue(currentQueue, true)
  }, [finishQueue])

  const abandon = useCallback(() => {
    requestGeneration.current += 1
    controllerRef.current?.abort()
    replaceQueue(null)
    setDialog(null)
  }, [replaceQueue])

  const open = useCallback((source: LedgerRow | number, proposal?: TransferReviewContextRequest['proposal']) => {
    const sourceId = typeof source === 'number' ? source : source.id
    if (proposal) {
      const expected_edit_token = typeof source === 'number' ? undefined : source.edit_token
      const generation = ++requestGeneration.current
      setDialog({ sourceId, draftSource: null, context: null, loading: true, writing: false, outcomeUnknown: false, error: null })
      return apiClient.postQuery<TransferContext>(`/api/transactions/${sourceId}/transfer-review-context`, { proposal, expected_edit_token, scope: 'nearby' }).then((context) => {
        if (mountedRef.current && requestGeneration.current === generation) setDialog({ sourceId, draftSource: null, context, loading: false, writing: false, outcomeUnknown: false, error: null })
        return context
      }).catch((error) => {
        if (mountedRef.current && requestGeneration.current === generation) setDialog((active) => active?.sourceId === sourceId ? { ...active, loading: false, error: apiErrorMessage(error, 'The transfer proposal could not be loaded.') } : active)
        return null
      })
    }
    return load(sourceId, 'nearby')
  }, [load])

  const openDraft = useCallback((accountId: number, draftId: number, proposal: TransferReviewContextRequest['proposal']) => {
    const generation = ++requestGeneration.current
    const draftSource = { accountId, draftId }
    setDialog({ sourceId: draftId, draftSource, context: null, loading: true, writing: false, outcomeUnknown: false, error: null })
    return apiClient.postQuery<TransferContext>('/api/transactions/transfer-draft-context', { account_id: accountId, proposal, scope: 'nearby' }).then((context) => {
      if (mountedRef.current && requestGeneration.current === generation) setDialog({ sourceId: draftId, draftSource, context, loading: false, writing: false, outcomeUnknown: false, error: null })
      return context
    }).catch((error) => {
      if (mountedRef.current && requestGeneration.current === generation) setDialog((active) => active?.sourceId === draftId ? { ...active, loading: false, error: apiErrorMessage(error, 'The transfer proposal could not be loaded.') } : active)
      return null
    })
  }, [])

  const chooseDestination = useCallback(async (destinationId: number) => {
    const current = dialogRef.current
    if (!current?.context || current.loading || current.writing) return null
    const source = current.context.source
    if (!source) return null
    const proposal = { payee_id: source.payee_id, transfer_account_id: destinationId, draft: { date: source.date, amount_cents: source.amount_cents, memo: source.memo, flag: source.flag } }
    const currentQueue = queueRef.current
    if (currentQueue) {
      const next = { ...currentQueue, entries: currentQueue.entries.map((entry, index) => index === currentQueue.index ? { ...entry, proposal } : entry), initialToken: true }
      replaceQueue(next)
      return loadQueue(next, current.context.scope)
    }
    const generation = ++requestGeneration.current
    setDialog((active) => active?.sourceId === current.sourceId ? { ...active, loading: true, error: null } : active)
    try {
      const context = await apiClient.postQuery<TransferContext>(`/api/transactions/${current.sourceId}/transfer-review-context`, {
        proposal,
        expected_edit_token: source.edit_token,
        scope: current.context.scope,
      })
      if (!mountedRef.current || requestGeneration.current !== generation) return null
      setDialog((active) => active?.sourceId === current.sourceId ? { ...active, context, loading: false, writing: false, outcomeUnknown: false, error: null } : active)
      return context
    } catch (error) {
      if (!mountedRef.current || requestGeneration.current !== generation) return null
      setDialog((active) => active?.sourceId === current.sourceId ? { ...active, loading: false, error: apiErrorMessage(error, 'The transfer proposal could not be loaded.') } : active)
      return null
    }
  }, [loadQueue, replaceQueue])


  const close = useCallback(() => {
    if (submittingRef.current) return
    const currentQueue = queueRef.current
    if (currentQueue) {
      finishQueue(currentQueue, true)
      return
    }
    requestGeneration.current += 1
    controllerRef.current?.abort()
    setDialog(null)
  }, [finishQueue])

  const refreshQueue = useCallback(() => {
    const currentQueue = queueRef.current
    const current = dialogRef.current
    if (!currentQueue || submittingRef.current) return
    const scope = current?.context?.scope ?? 'nearby'
    if (!currentQueue.inspectionRequired) {
      void loadQueue(currentQueue, scope, current?.outcomeUnknown ? undefined : current?.context?.candidate?.id, undefined, true)
      return
    }
    const entry = currentQueue.entries[currentQueue.index]
    if (!entry) return
    const generation = ++requestGeneration.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setDialog((active) => active?.sourceId === entry.id ? { ...active, loading: true, error: null } : active)
    void apiClient.get<LedgerRow>(`/api/transactions/${entry.id}`, controller.signal).then((source) => {
      if (!mountedRef.current || requestGeneration.current !== generation || queueRef.current !== currentQueue) return
      const inspectedQueue = { ...currentQueue, inspectionRequired: false }
      replaceQueue(inspectedQueue)
      if (source.transfer?.state === 'linked' || source.transfer?.state === 'attention') {
        setDialog({ sourceId: entry.id, draftSource: null, context: null, loading: false, writing: false, outcomeUnknown: false, error: 'The source is now linked or unavailable. Skip it or exit the queue.' })
        return
      }
      void loadQueue(inspectedQueue, scope, undefined, undefined, true)
    }).catch((error) => {
      if (controller.signal.aborted || !mountedRef.current || requestGeneration.current !== generation || queueRef.current !== currentQueue) return
      if (error instanceof ApiError && error.status === 404) {
        replaceQueue({ ...currentQueue, inspectionRequired: false })
        setDialog({ sourceId: entry.id, draftSource: null, context: null, loading: false, writing: false, outcomeUnknown: false, error: 'The source is no longer available. Skip it or exit the queue.' })
        return
      }
      setDialog((active) => active?.sourceId === entry.id
        ? { ...active, loading: false, outcomeUnknown: true, error: 'The source could not be inspected. Refresh must succeed before skipping or saving.' }
        : active)
    })
  }, [loadQueue, replaceQueue])

  const reloadSingle = useCallback((scope: 'nearby' | 'all', candidateId?: number | null, cursor?: string | null) => {
    const current = dialogRef.current
    if (!current) return null
    if (!current.context?.proposal || current.context.search_all_accounts) return load(current.sourceId, scope, candidateId, cursor)
    const generation = ++requestGeneration.current
    const previous = current.context
    setDialog((active) => active?.sourceId === current.sourceId ? { ...active, loading: true, writing: false, error: null } : active)
    const body = {
      proposal: previous.proposal,
      scope,
      ...(candidateId !== undefined && candidateId !== null ? { candidate_id: candidateId } : {}),
      ...(cursor ? { cursor } : {}),
      ...(!current.draftSource && previous.source ? { expected_edit_token: previous.source.edit_token } : {}),
      ...(current.draftSource ? { account_id: current.draftSource.accountId } : {}),
    }
    const path = current.draftSource ? '/api/transactions/transfer-draft-context' : `/api/transactions/${current.sourceId}/transfer-review-context`
    return apiClient.postQuery<TransferContext>(path, body).then((context) => {
      if (!mountedRef.current || requestGeneration.current !== generation) return null
      setDialog((active) => active?.sourceId === current.sourceId ? { ...active, context: appendCandidates(context, cursor ? previous : null), loading: false, writing: false, outcomeUnknown: false, error: null } : active)
      return context
    }).catch((error) => {
      if (mountedRef.current && requestGeneration.current === generation) setDialog((active) => active?.sourceId === current.sourceId ? { ...active, loading: false, error: apiErrorMessage(error, 'The transfer proposal could not be loaded.') } : active)
      return null
    })
  }, [load])

  const inspectSingle = useCallback((recoveryOutcome?: LedgerHistoryOutcome['status'] | null, outcomeAcknowledged = false) => {
    const current = dialogRef.current
    if (!current?.context) return null
    const currentContext = current.context
    if (current.draftSource) {
      if (!current.outcomeUnknown) return reloadSingle(currentContext.scope, currentContext.candidate?.id)
      if (recoveryOutcome === 'committed') {
        invalidate()
        setDialog(null)
        onDraftCommitted?.(current.draftSource.draftId)
        onChanged()
        return null
      }
      if (recoveryOutcome === 'not_committed' || outcomeAcknowledged) {
        setDialog((active) => active?.sourceId === current.sourceId ? { ...active, outcomeUnknown: false } : active)
        return reloadSingle(currentContext.scope, currentContext.candidate?.id)
      }
      setDialog((active) => active?.sourceId === current.sourceId ? { ...active, loading: false, writing: false, outcomeUnknown: true, error: 'The save outcome expired. Reload the register and inspect the transaction before trying again.' } : active)
      return null
    }
    const generation = ++requestGeneration.current
    setDialog((active) => active?.sourceId === current.sourceId ? { ...active, loading: true, writing: false, error: null } : active)
    return apiClient.get<LedgerRow>(`/api/transactions/${current.sourceId}`).then(async (source) => {
      if (!mountedRef.current || requestGeneration.current !== generation || dialogRef.current?.sourceId !== current.sourceId) return null
      if (source.transfer?.state === 'linked' || source.transfer?.state === 'attention') {
        setDialog((active) => active?.sourceId === current.sourceId ? { ...active, context: null, loading: false, writing: false, outcomeUnknown: false, error: 'The source is now linked or unavailable. Close this dialog and choose Inspect connections from the transaction menu.' } : active)
        return null
      }
      if (!currentContext.proposal || currentContext.search_all_accounts) return load(current.sourceId, currentContext.scope)
      const context = await apiClient.postQuery<TransferContext>(`/api/transactions/${current.sourceId}/transfer-review-context`, {
        proposal: currentContext.proposal,
        scope: currentContext.scope,
      })
      if (mountedRef.current && requestGeneration.current === generation && dialogRef.current?.sourceId === current.sourceId) setDialog((active) => active?.sourceId === current.sourceId ? { ...active, context, loading: false, writing: false, outcomeUnknown: false, error: null } : active)
      return context
    }).catch((error) => {
      if (mountedRef.current && requestGeneration.current === generation) setDialog((active) => active?.sourceId === current.sourceId ? { ...active, loading: false, writing: false, outcomeUnknown: true, error: apiErrorMessage(error, 'The source could not be inspected. Refresh must succeed before another action.') } : active)
      return null
    })
  }, [invalidate, load, onChanged, onDraftCommitted, reloadSingle])

  return {
    abandon,
    chooseCandidate: (candidateId: number) => {
      const currentQueue = queueRef.current
      if (currentQueue) return loadQueue(currentQueue, dialogRef.current?.context?.scope ?? 'nearby', candidateId)
      const current = dialogRef.current
      return current?.context && reloadSingle(current.context.scope, candidateId)
    },
    chooseDestination,
    close,
    dialog,
    exitQueue,
    findAll: () => {
      const currentQueue = queueRef.current
      if (currentQueue) return loadQueue(currentQueue, 'all', dialogRef.current?.context?.candidate?.id)
      const current = dialogRef.current
      return current && reloadSingle('all', current.context?.candidate?.id)
    },
    findNearby: () => {
      const currentQueue = queueRef.current
      if (currentQueue) return loadQueue(currentQueue, 'nearby', dialogRef.current?.context?.candidate?.id)
      const current = dialogRef.current
      return current && reloadSingle('nearby', current.context?.candidate?.id)
    },
    link: (candidateId: number, edits: ComparisonRowEdits) => submit('link', candidateId, edits),
    linkAndNext: (candidateId: number, edits: ComparisonRowEdits) => submitQueue('link', candidateId, edits),
    createCounterpartAndNext: (edits: ComparisonRowEdits) => submitQueue('create_counterpart', undefined, edits),
    loadMore: () => {
      const currentQueue = queueRef.current
      const current = dialogRef.current
      if (currentQueue && current?.context?.next_cursor) return loadQueue(currentQueue, current.context.scope, current.context.candidate?.id, current.context.next_cursor)
      return current?.context?.next_cursor && reloadSingle(current.context.scope, current.context.candidate?.id, current.context.next_cursor)
    },
    open,
    openDraft,
    queue: queue ? { current: queue.index + 1, total: queue.entries.length, saved: queue.saved, skipped: queue.skipped, uncertain: queue.uncertain, inspectionRequired: queue.inspectionRequired } : null,
    queueActive: queue !== null,
    refresh: (recoveryOutcome?: LedgerHistoryOutcome['status'] | null, outcomeAcknowledged = false) => {
      if (queueRef.current) return refreshQueue()
      const current = dialogRef.current
      if (!current) return null
      if (current.outcomeUnknown || Boolean(current.context?.proposal && current.error)) return inspectSingle(recoveryOutcome, outcomeAcknowledged)
      return reloadSingle(current.context?.scope ?? 'nearby', current.context?.candidate?.id)
    },
    saveUnlinkedAndNext: () => submitQueue('save_unlinked'),
    skipQueue,
    startQueue,
    startFindQueue: (entries: LedgerTarget[]) => {
      if (submittingRef.current || queueRef.current || entries.length === 0) return
      const currentQueue: TransferQueue = { entries: entries.map((entry) => ({ ...entry, proposal: null })), index: 0, saved: 0, skipped: 0, uncertain: 0, initialToken: true, inspectionRequired: false }
      replaceQueue(currentQueue)
      void loadQueue(currentQueue, 'nearby')
    },
    createCounterpart: (edits: ComparisonRowEdits) => submit('counterpart', undefined, edits),
    saveUnlinked: () => submit('save_unlinked'),
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, apiClient } from '../../api/client'
import type { BulkTransferQueueStart, LedgerBulkApplyCommand, LedgerBulkChanges, LedgerHistoryPreview, LedgerRow, LedgerTarget, TransferReviewProposal } from '../../api/types'
import { canEditField } from './rowPermissions'

type BulkField = keyof LedgerBulkChanges

const fieldPolicy: Record<BulkField, (row: LedgerRow) => boolean> = {
  payee_id: (row) => canEditField(row, 'payee_id'),
  transfer_account_id: (row) => canEditField(row, 'transfer_account_id'),
  category_id: (row) => row.allocations.length === 0 && canEditField(row, 'category_id'),
  memo: (row) => canEditField(row, 'memo'),
  flag: (row) => canEditField(row, 'flag'),
  approved: (row) => row.allowed_actions.includes('review'),
  clearance: (row) => row.allowed_actions.includes('clearance'),
  manual_clearance: (row) => row.allowed_actions.includes('manual_clearance'),
}

export function useBulkApply({
  selectedRows,
  selectedCount,
  selectionReady: selectionFactsReady,
  expandedSelection,
  viewKey,
  writePending,
  apply,
  refresh,
  onCommitted,
  onRefreshFailure,
  inspectHistory,
}: {
  selectedRows: LedgerRow[]
  selectedCount: number
  selectionReady: boolean
  expandedSelection: boolean
  viewKey: string
  apply: (payload: LedgerBulkApplyCommand) => Promise<unknown>
  refresh: (reviewed: boolean) => Promise<boolean>
  writePending: boolean
  onCommitted: () => void
  onRefreshFailure: () => void
  inspectHistory: () => Promise<unknown>
}) {
  const [changes, setChanges] = useState<LedgerBulkChanges>({})
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'confirming' | 'submitting'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [outcomeUnknown, setOutcomeUnknown] = useState(false)
  const [confirmation, setConfirmation] = useState<{ payload: LedgerBulkApplyCommand; overwriteCount: number; historyWarning: string | null } | null>(null)
  const mountedRef = useRef(true)
  const previewAbortRef = useRef<AbortController | null>(null)
  const previewRequestRef = useRef(0)
  const currentViewKeyRef = useRef(viewKey)
  currentViewKeyRef.current = viewKey
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; previewAbortRef.current?.abort() }
  }, [])

  const stagedFields = Object.keys(changes) as BulkField[]
  const frozen = phase !== 'idle' || writePending
  const hasStagedChanges = stagedFields.length > 0
  const selectionReady = selectionFactsReady && selectedRows.length === selectedCount
  const transferDestinationId = changes.transfer_account_id ?? null
  const transferMode = transferDestinationId !== null
  const unresolvedPayee = selectedRows.some((row) => row.payee_kind === 'unknown') && changes.payee_id === undefined && stagedFields.some((field) => !['approved', 'clearance', 'manual_clearance'].includes(field))
  const transferEligible = selectionReady
    && selectedRows.length > 0
    && selectedRows.every((row) => row.amount_cents !== 0
      && row.allocations.length === 0
      && row.source !== 'starting_balance'
      && canEditField(row, 'transfer_account_id')
      && row.transfer?.state !== 'linked'
      && row.transfer?.state !== 'attention')
    && (transferDestinationId === null || transferDestinationId === undefined || !selectedRows.some((row) => row.account_id === transferDestinationId))
  const ordinaryBlockedFields = stagedFields.filter((field) => selectedRows.some((row) => !fieldPolicy[field](row)))
  const blockedFields = transferMode && !transferEligible
    ? [...ordinaryBlockedFields.filter((field) => field !== 'transfer_account_id'), 'transfer_account_id' as const]
    : ordinaryBlockedFields
  const fieldEligible = useCallback((field: BulkField) => selectedRows.length > 0 && selectedRows.every((row) => fieldPolicy[field](row)), [selectedRows])

  const stage = useCallback(<K extends BulkField>(field: K, value: LedgerBulkChanges[K]) => {
    if (frozen || outcomeUnknown || ((field === 'clearance' || field === 'manual_clearance') && transferMode)) return
    setChanges((current) => {
      if (field === 'transfer_account_id' && typeof value === 'number') {
        const { approved: _approved, clearance: _clearance, manual_clearance: _manualClearance, ...next } = current
        return { ...next, transfer_account_id: value }
      }
      return { ...current, [field]: value }
    })
    setError(null)
  }, [frozen, outcomeUnknown, transferMode])
  const reset = useCallback((field: BulkField) => {
    if (frozen) return
    setChanges((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
    setError(null)
  }, [frozen])
  const discard = useCallback(() => {
    previewRequestRef.current += 1
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    setChanges({})
    setConfirmation(null)
    setError(null)
    setOutcomeUnknown(false)
    setPhase('idle')
  }, [])

  const cancel = useCallback(() => {
    if (phase === 'submitting') return
    discard()
  }, [discard, phase])

  const submit = useCallback(async (payload: LedgerBulkApplyCommand, submissionViewKey: string) => {
    setPhase('submitting')
    try {
      await apply(payload)
      if (!mountedRef.current || currentViewKeyRef.current !== submissionViewKey) return true
      setChanges({})
      setConfirmation(null)
      setError(null)
      setOutcomeUnknown(false)
      setPhase('idle')
      onCommitted()
      void refresh(payload.changes.approved === true).catch(() => {
        if (mountedRef.current && currentViewKeyRef.current === submissionViewKey) onRefreshFailure()
      })
      return true
    } catch (caught) {
      if (!mountedRef.current || currentViewKeyRef.current !== submissionViewKey) return false
      setConfirmation(null)
      setPhase('idle')
      if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500 && caught.code !== 'unknown_error') {
        if (caught.code === 'bulk_selection_changed') {
          setError('Selected transactions changed. Refreshing them before another save.')
          void refresh(false).catch(() => {
            if (mountedRef.current && currentViewKeyRef.current === submissionViewKey) setError('Selected transactions changed and could not be refreshed.')
          })
        } else {
          setError(caught.message)
        }
      } else {
        setOutcomeUnknown(true)
        setError('Save outcome unknown; refresh the register before trying again.')
      }
      return false
    }
  }, [apply, onCommitted, onRefreshFailure, refresh])

  const save = useCallback(async () => {
    if (unresolvedPayee) { setError('Choose a real Payee for the selected Unknown Payee transactions before saving.'); return false }
    if (transferMode || frozen || outcomeUnknown || !hasStagedChanges || blockedFields.length || selectedRows.length === 0 || !selectionReady) {
      if (selectedRows.length !== selectedCount) setError('Selection changed. Wait for the register to refresh before saving.')
      return false
    }
    const submissionViewKey = currentViewKeyRef.current
    const payload: LedgerBulkApplyCommand = {
      targets: selectedRows.map((row) => ({ id: row.id, edit_token: row.edit_token })),
      changes: { ...changes },
    }
    const overwriteCount = 'memo' in changes
      ? selectedRows.filter((row) => row.memo !== '' && row.memo !== changes.memo).length
      : 0
    const previewRequest = previewRequestRef.current + 1
    previewRequestRef.current = previewRequest
    const controller = expandedSelection ? new AbortController() : null
    previewAbortRef.current?.abort()
    previewAbortRef.current = controller
    setPhase(expandedSelection ? 'preparing' : 'idle')
    try {
      const preview = expandedSelection
        ? await apiClient.postQuery<LedgerHistoryPreview>('/api/transactions/history-preview', { targets: payload.targets }, controller?.signal)
        : { warning: null }
      if (!mountedRef.current || currentViewKeyRef.current !== submissionViewKey || previewRequestRef.current !== previewRequest) return false
      if (overwriteCount > 0 || preview.warning) {
        setConfirmation({ payload, overwriteCount, historyWarning: preview.warning })
        setPhase('confirming')
        return false
      }
      return submit(payload, submissionViewKey)
    } catch (error) {
      if (mountedRef.current && currentViewKeyRef.current === submissionViewKey && previewRequestRef.current === previewRequest) {
        setPhase('idle')
        setError(error instanceof ApiError ? error.message : 'The save could not be prepared.')
      }
      return false
    } finally {
      if (previewRequestRef.current === previewRequest) previewAbortRef.current = null
    }
  }, [blockedFields.length, changes, expandedSelection, frozen, hasStagedChanges, outcomeUnknown, selectedCount, selectedRows, selectionReady, submit, transferMode, unresolvedPayee])

  const startTransferQueue = useCallback((entries: LedgerTarget[]): BulkTransferQueueStart | null => {
    if (unresolvedPayee) { setError('Choose a real Payee for the selected Unknown Payee transactions before starting transfer review.'); return null }
    if (!transferMode || !transferEligible || blockedFields.length || frozen || outcomeUnknown || entries.length !== selectedRows.length) {
      if (!transferEligible) setError(transferDestinationId !== null && transferDestinationId !== undefined && selectedRows.some((row) => row.account_id === transferDestinationId)
        ? 'The transfer destination is one of the selected source accounts. Remove that row or reset Transfer before starting the transfer review.'
        : 'Remove an ineligible row or reset Transfer before starting the transfer review.')
      return null
    }
    const destinationId = changes.transfer_account_id
    if (destinationId === undefined || destinationId === null) return null
    const byId = new Map(selectedRows.map((row) => [row.id, row]))
    setChanges({})
    setConfirmation(null)
    setError(null)
    setOutcomeUnknown(false)
    setPhase('idle')
    return { entries: entries.flatMap((entry) => {
      const row = byId.get(entry.id)
      if (!row) return []
      const proposal: TransferReviewProposal = {
        payee_id: changes.payee_id ?? row.payee_id,
        transfer_account_id: destinationId,
        draft: {
          date: row.date,
          ...(changes.category_id !== undefined ? { categorization: { kind: 'single' as const, category_id: changes.category_id } } : {}),
          amount_cents: row.amount_cents,
          memo: 'memo' in changes ? changes.memo ?? '' : row.memo,
          flag: 'flag' in changes ? changes.flag ?? null : row.flag,
        },
      }
      return [{ ...entry, proposal }]
    }) }
  }, [blockedFields.length, changes, frozen, outcomeUnknown, selectedRows, transferDestinationId, transferEligible, transferMode, unresolvedPayee])

  const confirm = useCallback(async () => {
    if (!confirmation || phase !== 'confirming') return false
    return submit({ ...confirmation.payload, memo_overwrite_confirmed: true }, currentViewKeyRef.current)
  }, [confirmation, phase, submit])
  const cancelConfirmation = useCallback(() => {
    if (phase !== 'confirming' && phase !== 'preparing') return
    setConfirmation(null)
    setPhase('idle')
  }, [phase])
  const refreshUnknown = useCallback(async () => {
    const refreshViewKey = currentViewKeyRef.current
    try {
      await inspectHistory()
      const refreshed = await refresh(false)
      if (mountedRef.current && currentViewKeyRef.current === refreshViewKey && refreshed) {
        setOutcomeUnknown(false)
        setError(null)
      }
    } catch {
      if (mountedRef.current && currentViewKeyRef.current === refreshViewKey) setError('The register could not be refreshed. Save remains disabled until it succeeds.')
    }
  }, [inspectHistory, refresh])

  return {
    allManuallyCleared: selectedRows.length > 0 && selectedRows.every((row) => row.manually_cleared),
    blockedFields,
    cancel,
    cancelConfirmation,
    changes,
    confirm,
    confirmation,
    error,
    discard,
    fieldEligible,
    frozen,
    hasStagedChanges,
    outcomeUnknown,
    phase,
    refreshUnknown,
    reset,
    selectionReady,
    save,
    stage,
    startTransferQueue,
    transferEligible,
    transferMode,
  }
}

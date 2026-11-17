import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  adoptLedgerHistoryState,
  apiClient,
  beginLedgerHistorySession,
  drainLedgerHistoryForRecovery,
  endLedgerHistorySession,
  finishLedgerHistoryRecovery,
  ledgerHistoryEpoch,
  ledgerHistoryRecoveryRequired,
  ledgerHistoryReloadReason,
  ledgerHistoryReloadRequired,
  ledgerHistoryStorageUnavailable,
  markLedgerHistoryRegistrationFailed,
  requireLedgerOutcomeReload,
  renewLedgerHistoryState,
  setLedgerHistorySubscriber,
  unresolvedLedgerHistoryRequest,
} from '../../api/client'
import { ApiError } from '../../api/client'
import { cancelLedgerRecoveryReads, invalidateAccountAndTransactionQueries, refreshLedgerRecoveryData } from '../../api/hooks'
import type { LedgerHistoryInspection, LedgerHistoryOutcome, LedgerHistoryReplayResult, LedgerHistorySessionState, LedgerHistoryState } from '../../api/types'
import { recordDiagnostic } from '../../lib/diagnostics'
import { isComposingKey } from '../../lib/keyboard'

export type LedgerHistoryGuard = { blocked: boolean; recoveryOwned: boolean; ordinaryEditorOnly?: boolean }

class LedgerEpochChangedError extends Error {}
const uncertainSaveMessage = 'The last save may have completed. Refresh the register before saving again.'
const renewalErrorMessage = 'This session cannot be renewed. Reload and inspect the register before saving.'

export function nativeLedgerShortcutOwner(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [aria-haspopup][aria-expanded="true"], .bp-picker-popover, .bp-column-filter-popover'))
}

export function useLedgerHistory({
  accountName,
  accounts,
  blocked,
  recoveryOwned,
  onNotice,
}: {
  accountName: string | null
  accounts: Array<{ id: number; name: string }>
  blocked: boolean
  recoveryOwned: boolean
  onNotice: (message: string) => void
}) {
  const queryClient = useQueryClient()
  const sessionRef = useRef<string | null>(null)
  if (sessionRef.current === null) sessionRef.current = beginLedgerHistorySession()
  const session = sessionRef.current
  const [busy, setBusy] = useState(false)
  const [recovery, setRecovery] = useState<{ requestId: string; message: string } | null>(() => {
    const unresolved = unresolvedLedgerHistoryRequest(session)
    return unresolved ? { requestId: unresolved.requestId, message: uncertainSaveMessage } : null
  })
  const [recoveryOutcome, setRecoveryOutcome] = useState<LedgerHistoryOutcome | null>(null)
  const [reloadRequired, setReloadRequired] = useState(() => ledgerHistoryReloadRequired(session))
  const [recovering, setRecovering] = useState(false)
  const [acknowledgmentRequired, setAcknowledgmentRequired] = useState(false)
  const inspection = useRef<Promise<LedgerHistoryInspection> | null>(null)
  const acknowledgmentWait = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null)
  const observedNotice = useRef<string | null>(null)
  const queryKey = useRef(['ledger-history', session]).current
  const refreshSavedData = useCallback(() => refreshLedgerRecoveryData(queryClient), [queryClient])
  const readState = useCallback(async () => {
    const epoch = ledgerHistoryEpoch(session)
    return apiClient.get<LedgerHistorySessionState>(`/api/ledger-history${epoch ? `?${new URLSearchParams({ epoch })}` : ''}`)
  }, [session])
  const query = useQuery<LedgerHistorySessionState>({
    queryKey,
    queryFn: async () => {
      let renewing = false
      try {
        const state = await readState()
        const adopted = adoptLedgerHistoryState(session, state.epoch, state.database_generation)
        if (ledgerHistoryReloadRequired(session)) {
          setReloadRequired(true)
          throw new LedgerEpochChangedError(renewalErrorMessage)
        }
        if (unresolvedLedgerHistoryRequest(session) || (adopted && !ledgerHistoryRecoveryRequired(session))) return state
        renewing = true
        setRecovering(true)
        recordDiagnostic('ledger.recovery_started', 'info')
        if (!(await drainLedgerHistoryForRecovery(session))) throw new Error('Wait for the previous save result before refreshing this session.')
        await cancelLedgerRecoveryReads(queryClient)
        const renewed = await readState()
        if (!renewLedgerHistoryState(session, renewed.epoch, renewed.database_generation)) {
          setReloadRequired(ledgerHistoryReloadRequired(session))
          throw new LedgerEpochChangedError(renewalErrorMessage)
        }
        await refreshSavedData()
        const fresh = await readState()
        if (!finishLedgerHistoryRecovery(session, fresh.epoch, fresh.database_generation)) {
          setReloadRequired(ledgerHistoryReloadRequired(session))
          throw new LedgerEpochChangedError('The register changed during refresh. Refresh again before saving.')
        }
        recordDiagnostic('ledger.recovery_completed', 'info')
        onNotice('Earlier Undo history is no longer available. Your unsaved work is still here.')
        return fresh
      } catch (error) {
        if (renewing) recordDiagnostic('ledger.recovery_failed', 'warning')
        if (!(error instanceof LedgerEpochChangedError)) markLedgerHistoryRegistrationFailed(session)
        throw error
      } finally {
        if (renewing) setRecovering(false)
      }
    },
    staleTime: Infinity,
  })
  const refetch = query.refetch

  useEffect(() => {
    if (!query.data?.notice || query.data.notice === observedNotice.current) return
    observedNotice.current = query.data.notice
    onNotice(query.data.notice)
  }, [onNotice, query.data?.notice])

  useEffect(() => {
    setLedgerHistorySubscriber(session, () => {
      const unresolved = unresolvedLedgerHistoryRequest(session)
      if (unresolved) setRecovery({ requestId: unresolved.requestId, message: uncertainSaveMessage })
      else setRecovery(null)
      void refetch({ cancelRefetch: false })
    })
    return () => {
      acknowledgmentWait.current?.reject(new Error('Recovery was interrupted. Inspect the save after reopening.'))
      acknowledgmentWait.current = null
      setLedgerHistorySubscriber(session, null)
      endLedgerHistorySession(session)
    }
  }, [refetch, session])

  const refresh = useCallback((): Promise<LedgerHistoryInspection> => {
    if (inspection.current) return inspection.current
    const run = async (): Promise<LedgerHistoryInspection> => {
      const unresolved = unresolvedLedgerHistoryRequest(session)
      if (!unresolved) {
        const result = (await refetch({ throwOnError: true, cancelRefetch: false })).data
        if (!result) throw new Error('Ledger history did not return a state.')
        if (ledgerHistoryReloadRequired(session)) throw new LedgerEpochChangedError(renewalErrorMessage)
        await refreshSavedData()
        return { ...result, outcomeResolved: true, outcomeAcknowledged: false }
      }
      const inspectFresh = async () => {
        setRecovering(true)
        if (!(await drainLedgerHistoryForRecovery(session, true))) throw new Error(renewalErrorMessage)
        await cancelLedgerRecoveryReads(queryClient)
        const result = await apiClient.get<LedgerHistorySessionState>(`/api/ledger-history?${new URLSearchParams({ epoch: unresolved.epoch, request_id: unresolved.requestId, request_sequence: String(unresolved.sequence), request_session: unresolved.session, request_generation: unresolved.databaseGeneration })}`)
        const adopted = adoptLedgerHistoryState(session, result.epoch, result.database_generation)
        if (ledgerHistoryReloadRequired(session) || (!adopted && !renewLedgerHistoryState(session, result.epoch, result.database_generation, true))) {
          setReloadRequired(ledgerHistoryReloadRequired(session))
          throw new LedgerEpochChangedError(renewalErrorMessage)
        }
        if (result.outcome?.request_id !== unresolved.requestId) throw new Error('The save result could not be inspected.')
        await refreshSavedData()
        const fresh = await readState()
        if (fresh.epoch !== result.epoch || !adoptLedgerHistoryState(session, fresh.epoch, fresh.database_generation)) {
          setReloadRequired(ledgerHistoryReloadRequired(session))
          throw new LedgerEpochChangedError('The register changed during refresh. Refresh again before saving.')
        }
        const inspected = { ...fresh, outcome: result.outcome }
        queryClient.setQueryData<LedgerHistorySessionState>(queryKey, inspected)
        return inspected
      }
      try {
        let result = await inspectFresh()
        let outcomeAcknowledged = false
        if (result.outcome.status === 'expired') {
          if (!unresolved.local) {
            requireLedgerOutcomeReload(session)
            setReloadRequired(true)
            throw new Error('The bank operation result expired. Reload and check its saved connection status.')
          }
          setRecovering(false)
          setAcknowledgmentRequired(true)
          await new Promise<void>((resolve, reject) => { acknowledgmentWait.current = { resolve, reject } })
          acknowledgmentWait.current = null
          setAcknowledgmentRequired(false)
          result = await inspectFresh()
          outcomeAcknowledged = result.outcome.status === 'expired'
        }
        if (!finishLedgerHistoryRecovery(session, result.epoch, result.database_generation, unresolved.requestId)) throw new LedgerEpochChangedError(renewalErrorMessage)
        if (!recoveryOwned) setRecoveryOutcome(result.outcome)
        setRecovery(null)
        onNotice(!unresolved.local ? 'The bank request was inspected. Check its saved connection status.' : outcomeAcknowledged ? 'The save result is still unknown. You chose to continue after checking the refreshed register. Nothing was resent.' : result.outcome.status === 'committed' ? 'The previous save completed. The register is up to date.' : 'The previous save did not complete. Your unsaved work is still here.')
        return { ...result, outcomeResolved: true, outcomeAcknowledged }
      } finally {
        acknowledgmentWait.current = null
        setAcknowledgmentRequired(false)
        setRecovering(false)
      }
    }
    inspection.current = run().finally(() => { inspection.current = null })
    return inspection.current
  }, [onNotice, queryClient, queryKey, readState, recoveryOwned, refetch, refreshSavedData, session])

  const apply = useCallback(async (direction: 'undo' | 'redo') => {
    const state = query.data
    const action = state?.[direction]
    if (!action || blocked || busy || recovery || unresolvedLedgerHistoryRequest(session)) return
    setBusy(true)
    try {
      const result = await apiClient.post<LedgerHistoryReplayResult>(`/api/ledger-history/${direction}`, {
        action_id: action.id,
        expected_revision: state!.revision,
      })
      if (!adoptLedgerHistoryState(session, result.epoch)) {
        setReloadRequired(true)
        throw new LedgerEpochChangedError('This page belongs to an older ledger history.')
      }
      queryClient.setQueryData<LedgerHistorySessionState>(queryKey, (current) => current ? { ...current, ...result } : undefined)
      await invalidateAccountAndTransactionQueries(queryClient)
      onNotice(result.message ?? `${direction === 'undo' ? 'Undid' : 'Redid'} ${action.label}.`)
    } catch (error) {
      onNotice(error instanceof ApiError ? error.message : `Could not ${direction} ${action.label}.`)
    } finally {
      setBusy(false)
    }
  }, [blocked, busy, onNotice, query.data, queryClient, queryKey, recovery, session])

  const usable = Boolean(query.data && !recovery && !unresolvedLedgerHistoryRequest(session))
  const ready = Boolean(usable && query.isSuccess && !query.isFetching && !reloadRequired && !ledgerHistoryReloadRequired(session))
  const undoReady = Boolean(query.data?.undo && ready && !blocked && !busy)
  const redoReady = Boolean(query.data?.redo && ready && !blocked && !busy)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isComposingKey(event) || (!event.metaKey && !event.ctrlKey) || nativeLedgerShortcutOwner(event.target)) return
      const key = event.key.toLowerCase()
      const redo = (key === 'y' && event.ctrlKey && !event.metaKey && /Win|Linux/.test(navigator.platform)) || (key === 'z' && event.shiftKey)
      const undo = key === 'z' && !event.shiftKey
      if (redo && redoReady) { event.preventDefault(); void apply('redo') }
      if (undo && undoReady) { event.preventDefault(); void apply('undo') }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [apply, redoReady, undoReady])

  const actionAccountLabel = useCallback((action: LedgerHistoryState['undo']) => {
    if (!action) return accountName ?? 'this account'
    const names = action.account_ids.map((id) => accounts.find((account) => account.id === id)?.name).filter((name): name is string => Boolean(name))
    return names.length ? names.join(', ') : action.account_ids.length > 1 ? 'affected accounts' : accountName ?? 'this account'
  }, [accountName, accounts])
  const undoTitle = query.data?.undo ? `Undo ${query.data.undo.label} in ${actionAccountLabel(query.data.undo)}` : 'Nothing to undo'
  const redoTitle = query.data?.redo ? `Redo ${query.data.redo.label} in ${actionAccountLabel(query.data.redo)}` : 'Nothing to redo'
  return {
    busy,
    acknowledgmentRequired,
    acknowledge: () => acknowledgmentWait.current?.resolve(),
    storageUnavailable: ledgerHistoryStorageUnavailable(session),
    fetching: query.isFetching,
    inspect: refresh,
    registrationFailed: query.isError && !query.data && !ledgerHistoryEpoch(session),
    refreshFailed: query.isError && Boolean(query.data),
    reloadRequired: reloadRequired || ledgerHistoryReloadRequired(session),
    reloadReason: ledgerHistoryReloadReason(session),
    recovering,
    recoveryRequired: ledgerHistoryRecoveryRequired(session),
    ready,
    recovery: recoveryOwned ? null : recovery,
    recoveryOutcome,
    redo: { action: query.data?.redo ?? null, ready: redoReady, run: () => apply('redo'), title: redoTitle },
    undo: { action: query.data?.undo ?? null, ready: undoReady, run: () => apply('undo'), title: undoTitle },
    usable,
  }
}

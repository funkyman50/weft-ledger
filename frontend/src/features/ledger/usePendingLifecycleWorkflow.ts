import type { AccountScope } from '../../lib/accountScope'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, apiClient } from '../../api/client'
import {
  useDismissTransactionMatch,
  useDisappearPendingLifecycle,
  useResolvePendingLifecycle,
  useRejectBankContinuity,
  useUnmatchTransaction,
  useUnlinkTransfer,
} from '../../api/hooks'
import type {
  ComparisonRowEdits,
  TransactionConnectionsContext,
  LedgerRow,
  PendingLifecycleContext,
  PendingLifecycleSelections,
  RelationshipAction,
} from '../../api/types'
import { isComposingKey } from '../../lib/keyboard'

type LifecycleSession = { initializationAccountId: number | null } & (
  | { phase: 'loading'; inspection: boolean }
  | { phase: 'dialog'; context: PendingLifecycleContext }
  | { phase: 'picker'; pending: LedgerRow }
  | { phase: 'connections'; context: TransactionConnectionsContext }
)

export function usePendingLifecycleWorkflow({
  accountId,
  onError,
  onChanged,
}: {
  accountId: AccountScope | null
  onError: (message: string) => void
  onChanged: () => void
}) {
  const resolvePendingLifecycle = useResolvePendingLifecycle()
  const rejectBankContinuity = useRejectBankContinuity()
  const disappearPendingLifecycle = useDisappearPendingLifecycle()
  const dismissTransactionMatch = useDismissTransactionMatch()
  const unmatchTransaction = useUnmatchTransaction()
  const unlinkTransfer = useUnlinkTransfer()
  const [session, setSession] = useState<LifecycleSession | null>(null)
  const requestGeneration = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const accountRef = useRef(accountId)
  accountRef.current = accountId

  const close = useCallback(() => {
    requestGeneration.current += 1
    controllerRef.current?.abort()
    setSession(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGeneration.current += 1
      controllerRef.current?.abort()
    }
  }, [])
  useEffect(close, [accountId, close])

  const isCurrent = useCallback((generation: number, scope: typeof accountId) => (
    mountedRef.current && requestGeneration.current === generation && accountRef.current === scope
  ), [])

  const fetchContext = useCallback(async (
    intent: 'resolution' | 'inspection',
    pending: LedgerRow,
    cleared: LedgerRow | undefined,
    initializationAccountId: number | null,
    keepDialog = false,
  ) => {
    const scope = accountRef.current
    const generation = ++requestGeneration.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    if (!keepDialog) setSession({ phase: 'loading', initializationAccountId, inspection: intent === 'inspection' })
    const params = new URLSearchParams({ pending_transaction_id: String(pending.id) })
    if (cleared) params.set('cleared_transaction_id', String(cleared.id))
    try {
      if (intent === 'inspection') {
        const context = await apiClient.get<TransactionConnectionsContext>(
          `/api/transactions/connections/context?transaction_id=${pending.id}`, controller.signal,
        )
        if (isCurrent(generation, scope)) setSession({ phase: 'connections', context, initializationAccountId })
        return
      }
      const context = await apiClient.get<PendingLifecycleContext>(
        `/api/transactions/pending-lifecycle/context?${params.toString()}`, controller.signal,
      )
      if (isCurrent(generation, scope)) setSession({ phase: 'dialog', context, initializationAccountId })
    } catch (error) {
      if (!isCurrent(generation, scope)) return
      close()
      onError(error instanceof ApiError ? error.message : intent === 'inspection' ? 'Transaction connections could not be loaded.' : 'The pending lifecycle could not be loaded.')
    }
  }, [close, isCurrent, onError])

  const context = session?.phase === 'dialog' ? session.context : null
  const connectionsContext = session?.phase === 'connections' ? session.context : null
  const correctRelationship = useCallback(async (action: RelationshipAction) => {
    if (!connectionsContext) return
    const generation = requestGeneration.current
    const scope = accountRef.current
    if (action.kind === 'bank') {
      await rejectBankContinuity.mutateAsync({ transaction_id: connectionsContext.transaction_id, record_id: action.id, context_token: action.context_token })
    } else if (action.kind === 'match') {
      await unmatchTransaction.mutateAsync({ id: action.id, context_token: action.context_token })
    } else {
      await unlinkTransfer.mutateAsync({ id: action.id, context_token: action.context_token })
    }
    if (!isCurrent(generation, scope)) return
    close()
    onChanged()
  }, [close, connectionsContext, isCurrent, onChanged, rejectBankContinuity, unlinkTransfer, unmatchTransaction])
  const pickerPending = session?.phase === 'picker' ? session.pending : null
  const openResolution = useCallback((pending: LedgerRow, initializationAccountId: number | null = null) => {
    void fetchContext('resolution', pending, undefined, initializationAccountId)
  }, [fetchContext])

  const openInspection = useCallback((source: LedgerRow) => {
    void fetchContext('inspection', source, undefined, null)
  }, [fetchContext])

  const chooseCleared = useCallback((cleared: LedgerRow) => {
    if (session?.phase !== 'picker') return
    void fetchContext('resolution', session.pending, cleared, session.initializationAccountId)
  }, [fetchContext, session])

  const resolve = useCallback(async (selections: PendingLifecycleSelections, row_edits: ComparisonRowEdits) => {
    if (!context?.cleared) return
    const generation = requestGeneration.current
    const scope = accountRef.current
    await resolvePendingLifecycle.mutateAsync({
      pending_transaction_id: context.pending.id,
      cleared_transaction_id: context.cleared.id,
      context_token: context.context_token,
      selections,
      row_edits,
    })
    if (!isCurrent(generation, scope)) return
    close()
    onChanged()
  }, [close, context, isCurrent, onChanged, resolvePendingLifecycle])

  const disappear = useCallback(async () => {
    if (!context) return
    const generation = requestGeneration.current
    const scope = accountRef.current
    await disappearPendingLifecycle.mutateAsync({
      pending_transaction_id: context.pending.id,
      cleared_transaction_id: context.cleared?.id,
      context_token: context.context_token,
    })
    if (!isCurrent(generation, scope)) return
    close()
    onChanged()
  }, [close, context, disappearPendingLifecycle, isCurrent, onChanged])

  const refreshRelationship = useCallback(async (relation: PendingLifecycleContext['history_relations'][number]) => {
    if (session?.phase !== 'dialog') return
    const generation = requestGeneration.current
    const scope = accountRef.current
    if (relation.state === 'matched') {
      await unmatchTransaction.mutateAsync({ id: relation.id, context_token: relation.context_token })
    } else {
      await dismissTransactionMatch.mutateAsync(relation.id)
    }
    if (!isCurrent(generation, scope)) return
    await fetchContext('resolution', session.context.pending, session.context.cleared ?? undefined, session.initializationAccountId, true)
  }, [dismissTransactionMatch, fetchContext, isCurrent, session, unmatchTransaction])

  useEffect(() => {
    if (!pickerPending) return
    const cancel = (event: KeyboardEvent) => {
      if (isComposingKey(event)) return
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', cancel)
    return () => document.removeEventListener('keydown', cancel)
  }, [close, pickerPending])

  return {
    active: session !== null,
    loading: session?.phase === 'loading',
    loadingInspection: session?.phase === 'loading' && session.inspection,
    initializationAccountId: session?.initializationAccountId ?? null,
    chooseCleared,
    chooseFromLedger: () => {
      if (session?.phase !== 'dialog') return
      requestGeneration.current += 1
      controllerRef.current?.abort()
      setSession({ phase: 'picker', pending: session.context.pending, initializationAccountId: session.initializationAccountId })
    },
    close,
    context,
    connectionsContext,
    correctRelationship,
    disappear,
    openResolution,
    openInspection,
    pickerPending,
    refreshRelationship,
    resolve,
  }
}

import { useCallback, useRef, useState } from 'react'

import { ApiError, apiClient } from '../../api/client'
import {
  useCreateTransactionMatch,
  useDismissTransactionMatch,
  useUnmatchTransaction,
  useRejectBankContinuity,
  useUnlinkTransfer,
} from '../../api/hooks'
import type { LedgerRow, MatchContext, MatchFinderContext, RelationshipAction } from '../../api/types'
import type { MatchDialogMode, MatchSelections } from './MatchDialog'

export type MatchDialogState = {
  mode: MatchDialogMode
  context: MatchContext | null
  finder?: MatchFinderContext
  sourceId?: number
  finderLoading?: boolean
} | null

export function useMatchWorkflow(onError: (message: string) => void) {
  const matchTransaction = useCreateTransactionMatch()
  const dismissTransactionMatch = useDismissTransactionMatch()
  const unmatchTransaction = useUnmatchTransaction()
  const rejectBankContinuity = useRejectBankContinuity()
  const unlinkTransfer = useUnlinkTransfer()
  const [dialog, setDialog] = useState<MatchDialogState>(null)
  const [resetKey, setResetKey] = useState(0)
  const finderRequest = useRef(0)

  const notifyChanged = useCallback(
    () => setResetKey((current) => current + 1),
    [],
  )
  const finish = useCallback(() => {
    setDialog(null)
    notifyChanged()
  }, [notifyChanged])

  const open = useCallback(async (
    mode: MatchDialogMode,
    bank: LedgerRow,
    history: LedgerRow,
  ) => {
    const request = ++finderRequest.current
    setDialog({ mode, context: null })
    try {
      const context = bank.match !== null && mode !== 'manual'
        ? await apiClient.get<MatchContext>(
          `/api/transaction-matches/${bank.match.id}`,
        )
        : await apiClient.get<MatchContext>(
          `/api/transaction-matches/context?${new URLSearchParams({
            feed_transaction_id: String(bank.id),
            history_transaction_id: String(history.id),
          }).toString()}`,
        )
      if (finderRequest.current === request) setDialog({ mode, context })
    } catch (error) {
      if (finderRequest.current !== request) return
      setDialog(null)
      onError(
        error instanceof ApiError
          ? error.message
          : 'The transaction match could not be loaded.',
      )
    }
  }, [onError])

  const openFinder = useCallback(async (source: LedgerRow) => {
    const request = ++finderRequest.current
    setDialog({ mode: 'finder', context: null, sourceId: source.id, finderLoading: true })
    try {
      const finder = await apiClient.get<MatchFinderContext>(`/api/transaction-matches/find-context?${new URLSearchParams({ source_transaction_id: String(source.id), scope: 'nearby' })}`)
      if (finderRequest.current === request) setDialog({ mode: 'finder', context: finder.comparison, finder, sourceId: source.id, finderLoading: false })
    } catch (error) {
      if (finderRequest.current !== request) return
      setDialog(null)
      onError(error instanceof ApiError ? error.message : 'Match candidates could not be loaded.')
    }
  }, [onError])

  const loadFinder = useCallback(async (scope: 'nearby' | 'all', candidateId?: number, cursor?: string) => {
    const active = dialog
    if (!active?.sourceId || active.mode !== 'finder') return
    const request = ++finderRequest.current
    setDialog((current) => current?.mode === 'finder' && current.sourceId === active.sourceId ? { ...current, finderLoading: true } : current)
    try {
      const finder = await apiClient.get<MatchFinderContext>(`/api/transaction-matches/find-context?${new URLSearchParams({ source_transaction_id: String(active.sourceId), scope, ...(candidateId ? { candidate_id: String(candidateId) } : {}), ...(cursor ? { cursor } : {}) })}`)
      if (finderRequest.current !== request) return
      setDialog((current) => current?.mode === 'finder' && current.sourceId === active.sourceId ? {
        ...current,
        context: finder.comparison,
        finderLoading: false,
        finder: current.finder && current.finder.scope === scope && cursor
          ? { ...finder, candidates: [...current.finder.candidates, ...finder.candidates.filter((row) => !current.finder?.candidates.some((old) => old.id === row.id))] }
          : current.finder && current.finder.scope === scope && candidateId !== undefined
            ? { ...finder, candidates: current.finder.candidates, next_cursor: current.finder.next_cursor }
          : finder,
      } : current)
    } catch (error) {
      if (finderRequest.current === request) {
        setDialog((current) => current?.mode === 'finder' && current.sourceId === active.sourceId ? { ...current, finderLoading: false } : current)
        onError(error instanceof ApiError ? error.message : 'Match candidates could not be loaded.')
      }
    }
  }, [dialog, onError])

  const match = useCallback(async (selections: MatchSelections) => {
    if (!dialog?.context) return
    await matchTransaction.mutateAsync({
      feed_transaction_id: dialog.context.feed.id,
      history_transaction_id: dialog.context.history.id,
      context_token: dialog.context.context_token,
      ...selections,
    })
    finish()
  }, [dialog, finish, matchTransaction])

  const dismiss = useCallback(async () => {
    if (!dialog?.context?.id) return
    await dismissTransactionMatch.mutateAsync(dialog.context.id)
    finish()
  }, [dialog, dismissTransactionMatch, finish])

  const correctRelationship = useCallback(async (action: RelationshipAction) => {
    if (!dialog?.context || dialog.mode !== 'linked') return
    const request = finderRequest.current
    if (action.kind === 'bank') {
      await rejectBankContinuity.mutateAsync({ transaction_id: dialog.context.representative.id, record_id: action.id, context_token: action.context_token })
    } else if (action.kind === 'match') {
      await unmatchTransaction.mutateAsync({ id: action.id, context_token: action.context_token })
    } else {
      await unlinkTransfer.mutateAsync({ id: action.id, context_token: action.context_token })
    }
    if (finderRequest.current === request) finish()
  }, [dialog, finish, rejectBankContinuity, unlinkTransfer, unmatchTransaction])

  return {
    close: () => { finderRequest.current += 1; setDialog(null) },
    dialog,
    dismiss,
    match,
    notifyChanged,
    open,
    openFinder,
    loadFinder,
    resetKey,
    correctRelationship,
  }
}

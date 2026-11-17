import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { ApiError, apiClient } from '../../api/client'
import { invalidateAccountAndTransactionQueries } from '../../api/hooks'
import type { LedgerEditCommand, LedgerRow } from '../../api/types'

type Overlay = Partial<Pick<LedgerRow, 'date' | 'payee_id' | 'category_id' | 'memo' | 'amount_cents' | 'flag' | 'approved' | 'status' | 'manually_cleared' | 'payee_name' | 'payee_kind' | 'category_name' | 'subcategory_name' | 'allocations' | 'category_assigned' | 'transfer'>>

type CommandEntry = {
  generation: number
  viewKey: string
  queryKey: readonly unknown[]
  refreshViewKey: string
  overlay: Overlay
  state: 'pending' | 'committed' | 'uncertain'
  reviewed: boolean
}

function knownFailure(error: unknown) {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
}

export function useLedgerCommands({
  viewKey,
  refreshViewKey,
  queryKey,
  refreshOrigin,
  rows,
}: {
  viewKey: string
  refreshViewKey: string
  queryKey: readonly unknown[]
  refreshOrigin: (originQueryKey: readonly unknown[], originViewKey: string, reviewed: boolean) => Promise<void>
  rows: LedgerRow[]
}) {
  const queryClient = useQueryClient()
  const entriesRef = useRef(new Map<number, CommandEntry>())
  const requestCountRef = useRef(0)
  const writeGenerationRef = useRef(0)
  const reconciliationRef = useRef<Promise<void> | null>(null)
  const mountedRef = useRef(true)
  const unmountWaitersRef = useRef(new Set<() => void>())
  const viewKeyRef = useRef(viewKey)
  viewKeyRef.current = viewKey
  const refreshViewKeyRef = useRef(refreshViewKey)
  refreshViewKeyRef.current = refreshViewKey
  const queryKeyRef = useRef(queryKey)
  queryKeyRef.current = queryKey
  const refreshOriginRef = useRef(refreshOrigin)
  refreshOriginRef.current = refreshOrigin
  const [entries, setEntries] = useState(() => new Map<number, CommandEntry>())
  const [recovery, setRecovery] = useState<string | null>(null)
  const notify = useCallback(() => setEntries(new Map(entriesRef.current)), [])
  useEffect(() => {
    mountedRef.current = true
    const waiters = unmountWaitersRef.current
    return () => { mountedRef.current = false; for (const resolve of waiters) resolve(); waiters.clear() }
  }, [])

  const reconcile = useCallback((): Promise<void> => {
    if (reconciliationRef.current) return reconciliationRef.current
    if (requestCountRef.current > 0 || entriesRef.current.size === 0) return Promise.resolve()
    const generation = writeGenerationRef.current
    const entries = [...entriesRef.current.entries()].filter(([, entry]) => entry.state === 'committed')
    if (entries.length === 0) return Promise.resolve()
    const promise = (async () => {
      try {
        await invalidateAccountAndTransactionQueries(queryClient, { refetchLedger: false, refetchAccounts: false })
        await queryClient.refetchQueries({ queryKey: ['accounts'], type: 'active' }, { throwOnError: true })
        const byView = new Map<string, Array<[number, CommandEntry]>>()
        for (const entry of entries) {
          const group = byView.get(entry[1].viewKey)
          if (group) group.push(entry)
          else byView.set(entry[1].viewKey, [entry])
        }
        for (const group of byView.values()) {
          const latest = group.reduce((current, entry) => entry[1].generation > current[1].generation ? entry : current)
          const latestReviewed = group.reduce<[number, CommandEntry] | null>((current, entry) => {
            if (!entry[1].reviewed || (current && current[1].generation > entry[1].generation)) return current
            return entry
          }, null)
          const refreshEntry = latestReviewed ?? latest
          await refreshOriginRef.current(
            refreshEntry[1].queryKey,
            refreshEntry[1].refreshViewKey,
            latestReviewed !== null,
          )
        }
        if (requestCountRef.current > 0 || writeGenerationRef.current !== generation) return
        for (const [id, entry] of entries) {
          if (entriesRef.current.get(id)?.generation === entry.generation) entriesRef.current.delete(id)
        }
        setRecovery(null)
        notify()
      } catch {
        if (generation === writeGenerationRef.current && requestCountRef.current === 0) {
          setRecovery('Saved changes are still shown, but the register could not be refreshed.')
        }
      } finally {
        reconciliationRef.current = null
        notify()
        if (requestCountRef.current === 0 && writeGenerationRef.current !== generation) {
          void reconcile()
        }
      }
    })()
    reconciliationRef.current = promise
    return promise
  }, [notify, queryClient])

  const awaitReconciliation = useCallback(async () => {
    if (!mountedRef.current || recovery || requestCountRef.current > 0 || [...entriesRef.current.values()].some((entry) => entry.state === 'uncertain')) return false
    if (entriesRef.current.size === 0 && !reconciliationRef.current) return true
    let onUnmount = () => {}
    const unmounted = new Promise<void>((resolve) => { onUnmount = resolve; unmountWaitersRef.current.add(resolve) })
    try { await Promise.race([reconcile(), unmounted]) }
    finally { unmountWaitersRef.current.delete(onUnmount) }
    return mountedRef.current && requestCountRef.current === 0 && entriesRef.current.size === 0 && reconciliationRef.current === null
  }, [reconcile, recovery])

  const submit = useCallback(async <T,>(id: number, overlay: Overlay, reviewed: boolean | ((result: T) => boolean), request: () => Promise<T>, committedOverlay: (result: T) => Overlay = () => overlay): Promise<T> => {
    if (recovery) throw new ApiError(409, { code: 'ledger_refresh_required', message: recovery })
    if (entriesRef.current.has(id)) {
      throw new ApiError(409, { code: 'ledger_row_saving', message: 'This transaction is still saving.' })
    }
    const generation = ++writeGenerationRef.current
    entriesRef.current.set(id, {
      generation,
      viewKey: viewKeyRef.current,
      queryKey: queryKeyRef.current,
      refreshViewKey: refreshViewKeyRef.current,
      overlay,
      state: 'pending',
      reviewed: typeof reviewed === 'boolean' ? reviewed : false,
    })
    requestCountRef.current += 1
    notify()
    try {
      const result = await request()
      const entry = entriesRef.current.get(id)
      if (entry?.generation === generation) {
        entry.overlay = committedOverlay(result)
        entry.reviewed = typeof reviewed === 'function' ? reviewed(result) : reviewed
        entry.state = 'committed'
        notify()
      }
      return result
    } catch (error) {
      const entry = entriesRef.current.get(id)
      if (entry?.generation === generation) {
        if (knownFailure(error)) {
          entriesRef.current.delete(id)
          void invalidateAccountAndTransactionQueries(queryClient)
        } else entry.state = 'uncertain'
        notify()
      }
      throw error
    } finally {
      requestCountRef.current -= 1
      notify()
      if (requestCountRef.current === 0) void reconcile()
    }
  }, [notify, queryClient, reconcile, recovery])

  const update = useCallback((row: LedgerRow, payload: LedgerEditCommand) => {
    const overlay: Overlay = {}
    if (payload.date !== undefined) overlay.date = payload.date
    if (payload.payee_id != null) overlay.payee_id = payload.payee_id
    if (payload.categorization?.kind === 'single') overlay.category_id = payload.categorization.category_id
    if (payload.memo !== undefined) overlay.memo = payload.memo
    if (payload.amount_cents !== undefined) overlay.amount_cents = payload.amount_cents
    if (payload.flag !== undefined) overlay.flag = payload.flag
    return submit(row.id, overlay, (saved) => Boolean(payload.review_after_edit && !row.approved && saved.approved), () => apiClient.patch<LedgerRow>(`/api/transactions/${row.id}`, payload), (saved) => ({
      ...overlay,
      ...(payload.review_after_edit ? { approved: saved.approved } : {}),
      ...(payload.payee_id !== undefined ? { payee_name: saved.payee_name } : {}),
      ...(payload.categorization || payload.payee_id !== undefined ? {
        allocations: saved.allocations,
        category_assigned: saved.category_assigned,
        category_id: saved.category_id,
        category_name: saved.category_name,
        payee_id: saved.payee_id,
        payee_kind: saved.payee_kind,
        payee_name: saved.payee_name,
        subcategory_name: saved.subcategory_name,
        transfer: saved.transfer,
      } : {}),
    }))
  }, [submit])

  const review = useCallback((row: LedgerRow, approved: boolean) =>
    submit(row.id, { approved }, approved, () => apiClient.post<{ status: string }>('/api/transactions/review', { ids: [row.id], approved })), [submit])

  const clearance = useCallback((row: LedgerRow) => {
    const cleared = row.status === 'cleared' || row.status === 'reconciled'
    return submit(row.id, { status: cleared ? 'uncleared' : 'cleared', manually_cleared: false }, false,
      () => apiClient.post<LedgerRow>(`/api/transactions/${row.id}/clearance`, { intent: cleared ? 'uncleared' : 'cleared' }),
      (saved) => ({ status: saved.status, manually_cleared: saved.manually_cleared }))
  }, [submit])

  const recover = useCallback(() => {
    for (const entry of entriesRef.current.values()) {
      if (entry.state === 'uncertain') entry.state = 'committed'
    }
    notify()
    return reconcile()
  }, [notify, reconcile])

  useEffect(() => {
    if (requestCountRef.current === 0 && [...entriesRef.current.values()].some((entry) => entry.viewKey === viewKey)) {
      void reconcile()
    }
  }, [entries, reconcile, viewKey])

  const projectedRows = useMemo(() => rows.map((row) => {
    const entry = entries.get(row.id)
    return entry ? { ...row, ...entry.overlay } : row
  }), [entries, rows])

  const pendingRowIds = useMemo(() => new Set(entries.keys()), [entries])
  const anyPending = useMemo(() => entries.size > 0 || requestCountRef.current > 0 || reconciliationRef.current !== null, [entries])
  return useMemo(() => ({
    anyPending,
    awaitReconciliation,
    clearance,
    pendingRowIds,
    rows: projectedRows,
    recover,
    recovery,
    review,
    update,
  }), [anyPending, awaitReconciliation, clearance, pendingRowIds, projectedRows, recover, recovery, review, update])
}

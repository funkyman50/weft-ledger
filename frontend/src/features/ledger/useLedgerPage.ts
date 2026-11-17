import { appendAccountScope, type AccountScope } from '../../lib/accountScope'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError, apiClient } from '../../api/client'
import type { LedgerPage, LedgerRow } from '../../api/types'
import { ledgerDisplayGroup } from './transactionDisplay'
import { appendLedgerFilters, freshLedgerFilters, replacePayeeSelection, type LedgerFilterKey, type LedgerFilterValue } from './ledgerFilters'

type LedgerPageRead = LedgerPage & { read_version: number }

const LEDGER_FOOTER_FALLBACK_HEIGHT = 112
const TRANSACTION_BATCH_SIZE = 200

export function useLedgerPage({
  historyRegistered,
  accountId,
  membershipKey,
  choosingLifecycleRow,
  layoutKey,
  onError,
}: {
  historyRegistered: boolean
  accountId: AccountScope | null
  membershipKey: string
  layoutKey: string
  choosingLifecycleRow: boolean
  onError: (message: string) => void
}) {
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState(freshLedgerFilters)
  const [ledgerHeight, setLedgerHeight] = useState(260)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const ledgerSectionRef = useRef<HTMLElement>(null)
  const measureLedgerRef = useRef<(() => void) | null>(null)

  const activeFilters = useMemo(
    () => choosingLifecycleRow ? freshLedgerFilters() : filters,
    [choosingLifecycleRow, filters],
  )
  const appliedFilterKey = useMemo(() => JSON.stringify(activeFilters), [activeFilters])
  const viewKey = `${accountId}:${appliedFilterKey}`
  const previousViewKeyRef = useRef(viewKey)
  const filterViewGenerationRef = useRef(0)
  if (previousViewKeyRef.current !== viewKey) {
    previousViewKeyRef.current = viewKey
    filterViewGenerationRef.current += 1
  }
  const filterViewGeneration = filterViewGenerationRef.current
  const generationViewKey = `${viewKey}:${filterViewGeneration}`
  const currentViewKeyRef = useRef(generationViewKey)
  currentViewKeyRef.current = generationViewKey
  const memberReadKey = `${generationViewKey}:${membershipKey}`
  const memberReadKeyRef = useRef(memberReadKey)
  memberReadKeyRef.current = memberReadKey
  const loadingOlderGenerationRef = useRef<number | null>(null)
  const readVersionsRef = useRef(new Map<string, number>())

  useEffect(() => setFilters(freshLedgerFilters()), [accountId])

  useEffect(() => {
    loadingOlderGenerationRef.current = null
    setLoadingOlder(false)
  }, [filterViewGeneration, membershipKey])

  useLayoutEffect(() => {
    if (accountId === null) return
    const section = ledgerSectionRef.current
    if (!section) return
    let observer: ResizeObserver | null = null
    const measure = () => {
      const footer = section.querySelector<HTMLElement>('.bp-ledger-footer')
      const content = section.closest<HTMLElement>('.bp-content')
      const bottomPadding = content
        ? Number.parseFloat(window.getComputedStyle(content).paddingBottom) || 0
        : 0
      const footerHeight = footer?.getBoundingClientRect().height
        ?? LEDGER_FOOTER_FALLBACK_HEIGHT
      const scheduledPane = section.querySelector<HTMLElement>('.bp-scheduled-area')
      const scheduleHeight = scheduledPane?.getBoundingClientRect().height ?? 0
      if (scheduledPane && observer) observer.observe(scheduledPane)
      const selectionSlot = section.querySelector<HTMLElement>('.bp-selection-slot')
      const selectionHeight = selectionSlot?.getBoundingClientRect().height ?? 0
      const selectionMargin = selectionSlot
        ? Number.parseFloat(window.getComputedStyle(selectionSlot).marginBottom) || 0
        : 0
      setLedgerHeight(Math.max(
        216,
        window.innerHeight
          - section.getBoundingClientRect().top
          - selectionHeight
          - selectionMargin
          - footerHeight
          - bottomPadding
          - scheduleHeight,
      ))
      if (footer && observer) observer.observe(footer)
      if (selectionSlot && observer) observer.observe(selectionSlot)
    }
    measure()
    measureLedgerRef.current = measure
    window.addEventListener('resize', measure)
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(section)
      const heading = section.closest('main')?.querySelector('.bp-workspace-heading')
      if (heading) observer.observe(heading)
      const footer = section.querySelector<HTMLElement>('.bp-ledger-footer')
      if (footer) observer.observe(footer)
      const selectionSlot = section.querySelector<HTMLElement>('.bp-selection-slot')
      if (selectionSlot) observer.observe(selectionSlot)
    }
    return () => {
      measureLedgerRef.current = null
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [accountId])

  const queryKey = useMemo(
    () => ['transactions', accountId, activeFilters, membershipKey] as const,
    [accountId, activeFilters, membershipKey],
  )
  const currentQueryKeyRef = useRef(queryKey)
  currentQueryKeyRef.current = queryKey
  const query = useQuery({
    queryKey,
    enabled: historyRegistered && accountId !== null,
    queryFn: async ({ signal }) => {
      const readVersion = (readVersionsRef.current.get(generationViewKey) ?? 0) + 1
      readVersionsRef.current.set(generationViewKey, readVersion)
      const params = new URLSearchParams({ page_size: String(TRANSACTION_BATCH_SIZE) })
      appendAccountScope(params, accountId)
      appendLedgerFilters(params, activeFilters)
      const cached = queryClient.getQueryData<LedgerPageRead>(queryKey)
      const cachedOldest = cached?.rows
        .filter((row) => ledgerDisplayGroup(row) === 0)
        .reduce<LedgerRow | null>((oldest, row) => oldest === null || row.date < oldest.date ? row : oldest, null) ?? null
      if (cachedOldest) {
        params.set('through_date', cachedOldest.date)
      }
      const page = await apiClient.get<LedgerPage>(`/api/transactions?${params.toString()}`, signal)
      return { ...page, read_version: readVersion }
    },
  })

  // Measure pane and loading transitions before paint to avoid flashing the page scrollbar.
  useLayoutEffect(() => { measureLedgerRef.current?.() }, [layoutKey, query.isPending])

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const current = query.data
    const requestGeneration = filterViewGeneration
    const requestReadVersion = readVersionsRef.current.get(generationViewKey) ?? 0
    if (
      accountId === null
      || !current?.has_more
      || loadingOlderGenerationRef.current === requestGeneration
    ) return false
    loadingOlderGenerationRef.current = requestGeneration
    setLoadingOlder(true)
    try {
      const params = new URLSearchParams({
        page_size: String(TRANSACTION_BATCH_SIZE),
        include_pinned: 'false',
      })
      appendAccountScope(params, accountId)
      appendLedgerFilters(params, activeFilters)
      if (
        current.next_before_date
        && current.next_before_id !== null
      ) {
        params.set('before_date', current.next_before_date)
        params.set('before_id', String(current.next_before_id))
        params.set('before_order', String(current.next_before_order))
      }
      const older = await apiClient.get<LedgerPage>(
        `/api/transactions?${params.toString()}`,
      )
      if (memberReadKeyRef.current !== memberReadKey || filterViewGenerationRef.current !== requestGeneration || readVersionsRef.current.get(generationViewKey) !== requestReadVersion) return false
      let addedCount = 0
      queryClient.setQueryData<LedgerPageRead>(queryKey, (latest) => {
        if (!latest) return { ...older, read_version: requestReadVersion }
        const existingIds = new Set(latest.rows.map((transaction) => transaction.id))
        const additions = older.rows.filter(
          (transaction) => !existingIds.has(transaction.id),
        )
        addedCount = additions.length
        return {
          ...latest,
          rows: [...additions, ...latest.rows],
          has_more: older.has_more,
          next_before_date: older.next_before_date,
          next_before_id: older.next_before_id,
          next_before_order: older.next_before_order,
        }
      })
      return addedCount > 0 || !older.has_more
    } catch (error) {
      onError(
        error instanceof ApiError
          ? error.message
          : 'Older transactions could not be loaded.',
      )
      return false
    } finally {
      if (
        filterViewGenerationRef.current === requestGeneration
        && memberReadKeyRef.current === memberReadKey
        && loadingOlderGenerationRef.current === requestGeneration
      ) {
        loadingOlderGenerationRef.current = null
        setLoadingOlder(false)
      }
    }
  }, [
    accountId,
    activeFilters,
    filterViewGeneration,
    generationViewKey,
    memberReadKey,
    onError,
    query.data,
    queryClient,
    queryKey,
  ])

  const changeFilter = useCallback(
    (key: LedgerFilterKey, value: LedgerFilterValue) => {
      setFilters((current) => ({ ...current, [key]: value }))
    },
    [],
  )
  const clearFilters = useCallback(() => setFilters(freshLedgerFilters()), [])
  const transactions = useMemo(() => query.data?.rows ?? [], [query.data?.rows])
  const readSelection = useCallback((signal?: AbortSignal) => {
    const params = new URLSearchParams()
    appendAccountScope(params, accountId)
    appendLedgerFilters(params, activeFilters)
    return apiClient.get<LedgerRow[]>(`/api/transactions/selection?${params.toString()}`, signal).then((rows) => {
      if (memberReadKeyRef.current !== memberReadKey) throw new Error('Group membership changed. Select the refreshed transactions again.')
      return rows
    })
  }, [accountId, activeFilters, memberReadKey])

  const refreshOrigin = useCallback(async (originQueryKey: readonly unknown[], originViewKey: string, reviewed: boolean): Promise<void> => {
    if (queryClient.getQueryState(originQueryKey)) {
      await queryClient.refetchQueries({ queryKey: originQueryKey, exact: true, type: 'all' }, { throwOnError: true })
    } else if (originViewKey !== currentViewKeyRef.current) return
    let inspectedKey = originQueryKey
    while (originViewKey === currentViewKeyRef.current && JSON.stringify(inspectedKey) !== JSON.stringify(currentQueryKeyRef.current)) {
      inspectedKey = currentQueryKeyRef.current
      await queryClient.refetchQueries({ queryKey: inspectedKey, exact: true, type: 'all' }, { throwOnError: true })
    }
    const data = queryClient.getQueryData<LedgerPage>(inspectedKey)
    if (!data) throw new Error('Register refresh failed')
    if (originViewKey === currentViewKeyRef.current && reviewed && filters.status.needsReview && data.filtered_count === 0) {
      setFilters((current) => current.status.needsReview ? { ...current, status: { ...current.status, needsReview: false } } : current)
    }
  }, [filters.status, queryClient])
  const refreshAfterApply = useCallback(async (originViewKey: string, reviewed: boolean) => {
    if (originViewKey !== currentViewKeyRef.current) return false
    await refreshOrigin(queryKey, originViewKey, reviewed)
    return originViewKey === currentViewKeyRef.current
  }, [queryKey, refreshOrigin])

  return {
    activeFilters,
    filterViewGeneration,
    changeFilter,
    replacePayeeFilter: (sourceId: number, destinationId: number) => setFilters((current) => {
      const payee = replacePayeeSelection(current.payee, sourceId, destinationId)
      return payee === current.payee ? current : { ...current, payee }
    }),
    clearFilters,
    filters,
    ledgerHeight,
    ledgerSectionRef,
    loadingOlder,
    loadOlder,
    query,
    queryReadVersion: query.data?.read_version ?? 0,
    readSelection,
    queryKey,
    refreshOrigin,
    refreshAfterApply,
    transactions,
    queryViewKey: viewKey,
    viewKey: generationViewKey,
  }
}

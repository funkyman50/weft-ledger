import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { ApiError } from '../../api/client'
import type { LedgerRow } from '../../api/types'
import { selectRowIds } from './ledgerSelection'

type SelectionPhase = 'idle' | 'expanding' | 'reconciling' | 'failed'

export function useLedgerSelection({
  viewKey,
  loadedRows,
  filteredCount,
  readVersion,
  readSelection,
  onError,
}: {
  viewKey: string
  loadedRows: LedgerRow[]
  filteredCount: number
  readVersion: number
  readSelection: (signal?: AbortSignal) => Promise<LedgerRow[]>
  onError: (message: string) => void
}) {
  const [ids, setIds] = useState<Set<number>>(() => new Set())
  const [anchorId, setAnchorId] = useState<number | null>(null)
  const [expandedRows, setExpandedRows] = useState<Map<number, LedgerRow> | null>(null)
  const [shortcutOrigin, setShortcutOrigin] = useState(false)
  const [phase, setPhase] = useState<SelectionPhase>('idle')
  const [frozen, setFrozen] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const [reconciledVersion, setReconciledVersion] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const idsRef = useRef(ids)
  const anchorRef = useRef(anchorId)
  const viewRef = useRef(viewKey)
  const readVersionRef = useRef(readVersion)
  const loadedVersionRef = useRef(readVersion)
  const reconcileAttemptRef = useRef(readVersion)
  viewRef.current = viewKey
  readVersionRef.current = readVersion
  const writeIds = useCallback((next: Set<number>) => {
    idsRef.current = next
    setIds(next)
  }, [])
  const writeAnchor = useCallback((next: number | null) => {
    anchorRef.current = next
    setAnchorId(next)
  }, [])
  const loadedById = useMemo(() => new Map(loadedRows.map((row) => [row.id, row])), [loadedRows])
  const expanded = expandedRows !== null
  const selectionReady = !expanded || reconciledVersion === readVersion
  const selectedRows = useMemo(() => {
    const facts = expandedRows ?? loadedById
    return [...ids].flatMap((id) => {
      const row = facts.get(id) ?? loadedById.get(id)
      return row ? [row] : []
    })
  }, [expandedRows, ids, loadedById])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; abortRef.current?.abort() }
  }, [])
  const clear = useCallback(() => {
    abortRef.current?.abort()
    writeIds(new Set())
    writeAnchor(null)
    setExpandedRows(null)
    setShortcutOrigin(false)
    setPhase('idle')
    setFrozen(false)
    setReconciledVersion(readVersionRef.current)
  }, [writeAnchor, writeIds])

  useLayoutEffect(() => {
    clear()
    reconcileAttemptRef.current = readVersionRef.current
  }, [clear, viewKey])

  useEffect(() => {
    if (expanded || frozen || phase !== 'idle' || loadedVersionRef.current === readVersion) return
    loadedVersionRef.current = readVersion
    const current = idsRef.current
    const next = new Set([...current].filter((id) => loadedById.has(id)))
    if (next.size === current.size) return
    writeIds(next)
    if (next.size === 0) setShortcutOrigin(false)
    onError('Selection changed because some transactions are no longer available.')
  }, [expanded, frozen, loadedById, onError, phase, readVersion, writeIds])

  const applyManual = useCallback((next: Set<number>) => {
    if (phase !== 'idle') return
    writeIds(next)
    setShortcutOrigin(false)
    if (next.size === 0) writeAnchor(null)
    if (next.size === 0 || (expandedRows !== null && [...next].every((id) => loadedById.has(id)))) {
      setExpandedRows(null)
      setReconciledVersion(readVersionRef.current)
    }
  }, [expandedRows, loadedById, phase, writeAnchor, writeIds])

  const activate = useCallback((id: number) => {
    writeAnchor(id)
  }, [writeAnchor])

  const selectOne = useCallback((id: number) => {
    if (phase !== 'idle') return
    writeAnchor(id)
    applyManual(new Set([id]))
  }, [applyManual, phase, writeAnchor])

  const toggle = useCallback((id: number, orderedIds: number[]) => {
    if (phase !== 'idle') return
    const seeded = new Set(idsRef.current)
    const currentAnchor = anchorRef.current
    if (seeded.size === 0 && currentAnchor !== null && orderedIds.includes(currentAnchor)) seeded.add(currentAnchor)
    const next = selectRowIds(seeded, orderedIds, id, currentAnchor, 'toggle')
    writeAnchor(next.size === 0 ? null : id)
    applyManual(next)
  }, [applyManual, phase, writeAnchor])

  const extend = useCallback((id: number, orderedIds: number[]) => {
    if (phase !== 'idle') return
    const currentAnchor = anchorRef.current
    const next = selectRowIds(idsRef.current, orderedIds, id, currentAnchor, 'range')
    writeAnchor(currentAnchor ?? id)
    applyManual(next)
  }, [applyManual, phase, writeAnchor])

  const selectShortcut = useCallback(() => {
    if (phase !== 'idle') return
    const loadedIds = loadedRows.map((row) => row.id)
    if (loadedIds.length === 0) return
    writeIds(new Set([...idsRef.current, ...loadedIds]))
    setShortcutOrigin(true)
  }, [loadedRows, phase, writeIds])

  const expand = useCallback(async () => {
    if (!shortcutOrigin || phase !== 'idle' || ids.size >= filteredCount) return false
    const requestView = viewRef.current
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setPhase('expanding')
    try {
      const rows = await readSelection(controller.signal)
      if (controller.signal.aborted || !mountedRef.current || viewRef.current !== requestView) return false
      const facts = new Map(rows.map((row) => [row.id, row]))
      setExpandedRows(facts)
      writeIds(new Set(facts.keys()))
      setReconciledVersion(readVersion)
      setPhase('idle')
      return true
    } catch (error) {
      if (controller.signal.aborted) return false
      if (mountedRef.current && viewRef.current === requestView) {
        setPhase('idle')
        onError(error instanceof ApiError ? error.message : 'Every matching transaction could not be selected.')
      }
      return false
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [filteredCount, ids.size, onError, phase, readSelection, readVersion, shortcutOrigin, writeIds])

  const cancelRead = useCallback(() => {
    if (phase !== 'expanding') return false
    abortRef.current?.abort()
    setPhase('idle')
    return true
  }, [phase])

  const retry = useCallback(() => {
    if (phase !== 'failed') return
    if (expanded) {
      reconcileAttemptRef.current = -1
      setRetryNonce((current) => current + 1)
    }
    setPhase('idle')
  }, [expanded, phase])

  useEffect(() => {
    if (!expanded || frozen || phase !== 'idle' || reconciledVersion === readVersion || reconcileAttemptRef.current === readVersion) return
    reconcileAttemptRef.current = readVersion
    const requestView = viewRef.current
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setPhase('reconciling')
    void readSelection(controller.signal).then((rows) => {
      if (controller.signal.aborted || !mountedRef.current || viewRef.current !== requestView) return
      const facts = new Map(rows.map((row) => [row.id, row]))
      const current = idsRef.current
      const next = new Set([...current].filter((id) => facts.has(id)))
      setExpandedRows(facts)
      if (next.size !== current.size) {
        writeIds(next)
        if (next.size === 0) setShortcutOrigin(false)
        onError('Selection changed because some transactions are no longer available.')
      }
      setReconciledVersion(readVersion)
      setPhase('idle')
    }).catch((error) => {
      if (controller.signal.aborted || !mountedRef.current || viewRef.current !== requestView) return
      setPhase('failed')
      onError(error instanceof ApiError ? error.message : 'The selected transactions could not be refreshed. Refresh or cancel the selection before saving.')
    }).finally(() => {
      if (abortRef.current === controller) abortRef.current = null
    })
  }, [expanded, frozen, onError, phase, readSelection, readVersion, reconciledVersion, retryNonce, writeIds])

  const canExpand = shortcutOrigin && (phase === 'idle' || phase === 'expanding') && ids.size < filteredCount
  return {
    canExpand,
    cancelRead,
    clear,
    activate,
    expand,
    expanded,
    extend,
    ids,
    phase,
    retry,
    selectOne,
    selectShortcut,
    selectedRows,
    selectionReady: selectionReady && phase === 'idle' && !frozen,
    setFrozen,
    toggle,
  }
}

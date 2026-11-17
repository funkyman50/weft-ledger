import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

interface ScrollPosition {
  viewKey: string
  atBottom: boolean
  top: number
  composerHeight: number
  height: number
  contentHeight: number
  anchors: Array<{ id: string; offset: number; index: number; visible: boolean }>
}

function viewportTop(shell: HTMLDivElement) {
  return shell.getBoundingClientRect().top + shell.clientTop + (shell.querySelector('thead')?.getBoundingClientRect().height ?? 0)
}

function composerHeight(shell: HTMLDivElement) {
  return shell.parentElement?.querySelector('.bp-new-transaction-composer')?.getBoundingClientRect().height ?? 0
}

function revealWithinViewport(shell: HTMLDivElement, row: HTMLElement, center = false) {
  const top = viewportTop(shell)
  const bottom = shell.getBoundingClientRect().top + shell.clientTop + shell.clientHeight
  const bounds = row.getBoundingClientRect()
  if (center) shell.scrollTop += bounds.top - top - (bottom - top - bounds.height) / 2
  else if (bounds.top < top) shell.scrollTop += bounds.top - top
  else if (bounds.bottom > bottom) shell.scrollTop += bounds.bottom - bottom
}

export function useLedgerScroll({ shellRef, viewKey, ready, navigationRevisionRef }: {
  shellRef: RefObject<HTMLDivElement | null>
  viewKey: string
  ready: boolean
  navigationRevisionRef: RefObject<number>
}) {
  const positionRef = useRef<ScrollPosition | null>(null)
  const savedRowRef = useRef<number | null>(null)
  const userScrollPendingRef = useRef(false)

  const capture = useCallback(() => {
    const shell = shellRef.current
    if (!shell || !ready) return
    const atBottom = shell.scrollHeight - shell.clientHeight - shell.scrollTop <= 2
    const top = viewportTop(shell)
    const rows = atBottom ? [] : [...shell.querySelectorAll<HTMLElement>('[data-ledger-row-id]')]
    const tableBounds = shell.querySelector('table')!.getBoundingClientRect()
    const rowTops = rows.map((row) => tableBounds.top + row.offsetTop)
    const blockBottom = (index: number) => rowTops[index + 1] ?? tableBounds.bottom
    const firstVisible = Math.max(0, rows.findIndex((_, index) => blockBottom(index) > top))
    const bottom = shell.getBoundingClientRect().top + shell.clientTop + shell.clientHeight
    const anchors = rows.map((row, index) => ({
      id: row.dataset.ledgerRowId!,
      offset: rowTops[index] - top,
      index,
      visible: blockBottom(index) > top && rowTops[index] < bottom,
    })).sort((a, b) => Math.abs(a.index - firstVisible) - Math.abs(b.index - firstVisible) || b.index - a.index)
    positionRef.current = { viewKey, atBottom, top: shell.scrollTop, composerHeight: composerHeight(shell), height: shell.clientHeight, contentHeight: shell.scrollHeight, anchors }
  }, [ready, shellRef, viewKey])

  const recordUserScroll = useCallback(() => {
    navigationRevisionRef.current += 1
    savedRowRef.current = null
    userScrollPendingRef.current = true
    capture()
  }, [capture, navigationRevisionRef])

  const restore = useCallback(() => {
    const shell = shellRef.current
    if (!shell || !ready) return
    const previous = positionRef.current
    if (previous?.viewKey === viewKey && shell.clientHeight === previous.height && shell.scrollHeight === previous.contentHeight && Math.abs(shell.scrollTop - previous.top) > 1) {
      recordUserScroll()
      return
    }
    if (previous?.viewKey !== viewKey) {
      savedRowRef.current = null
      userScrollPendingRef.current = false
    }
    if (!previous || previous.viewKey !== viewKey || previous.atBottom) {
      shell.scrollTop = shell.scrollHeight
    } else {
      const rows = new Map([...shell.querySelectorAll<HTMLElement>('[data-ledger-row-id]')].map((row, index) => [row.dataset.ledgerRowId, { row, index }]))
      const survivors = previous.anchors.filter((candidate) => rows.has(candidate.id))
      const anchor = survivors[0]
      const heightChange = composerHeight(shell) - previous.composerHeight
      if (anchor) {
        const top = viewportTop(shell)
        const tableTop = shell.querySelector('table')!.getBoundingClientRect().top
        const movement = (candidate: typeof anchor) => tableTop + rows.get(candidate.id)!.row.offsetTop - top - candidate.offset
        let shift = movement(anchor)
        const ordered = [...survivors].sort((a, b) => a.index - b.index)
        const reordered = ordered.some((candidate, index) => index > 0 && rows.get(candidate.id)!.index < rows.get(ordered[index - 1].id)!.index)
        if (reordered) {
          const shifts = survivors.filter((candidate) => candidate.visible).map(movement)
          const agreement = (candidate: number) => shifts.filter((value) => Math.abs(value - candidate) <= 1).length
          let bestAgreement = agreement(shift)
          for (const candidate of shifts) {
            const count = agreement(candidate)
            if (count > bestAgreement) { shift = candidate; bestAgreement = count }
          }
        }
        shell.scrollTop += shift + heightChange
      } else {
        shell.scrollTop = previous.top + heightChange
      }
      if (heightChange !== 0 && savedRowRef.current !== null && previous.anchors.some((candidate) => candidate.id === String(savedRowRef.current) && candidate.visible)) {
        const savedRow = rows.get(String(savedRowRef.current))?.row
        if (savedRow) revealWithinViewport(shell, savedRow)
      }
    }
    capture()
  }, [capture, ready, recordUserScroll, shellRef, viewKey])

  useLayoutEffect(() => { restore() })

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell || !ready || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(restore)
    observer.observe(shell)
    const table = shell.querySelector('table')
    if (table) observer.observe(table)
    return () => observer.disconnect()
  }, [ready, restore, shellRef])

  const onScroll = useCallback(() => {
    const shell = shellRef.current
    const previous = positionRef.current
    if (!shell || !ready || !previous) return false
    if (shell.clientHeight !== previous.height || shell.scrollHeight !== previous.contentHeight) {
      restore()
    } else if (Math.abs(shell.scrollTop - previous.top) > 1) recordUserScroll()
    const userScrolled = userScrollPendingRef.current
    userScrollPendingRef.current = false
    return userScrolled
  }, [ready, recordUserScroll, restore, shellRef])

  const resetToBottom = useCallback(() => {
    navigationRevisionRef.current += 1
    savedRowRef.current = null
    userScrollPendingRef.current = false
    positionRef.current = null
  }, [navigationRevisionRef])

  const revealRow = useCallback((id: number, placement: 'nearest' | 'center' | 'keyboard' | 'saved' = 'nearest') => {
    const shell = shellRef.current
    const row = shell?.querySelector<HTMLElement>(`[data-ledger-row-id="${id}"]`)
    if (!shell || !row || !ready) return false
    if (placement === 'keyboard') {
      navigationRevisionRef.current += 1
      savedRowRef.current = null
    }
    if (placement === 'center') savedRowRef.current = null
    if (placement === 'saved') savedRowRef.current = id
    revealWithinViewport(shell, row, placement === 'center')
    capture()
    return true
  }, [capture, navigationRevisionRef, ready, shellRef])

  return { onScroll, resetToBottom, revealRow }
}

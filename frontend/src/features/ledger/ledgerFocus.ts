import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'

export function useEditorClickAway(sessionId: string | null, onSave?: () => void) {
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  useEffect(() => {
    if (sessionId === null) return
    const scope = `[data-ledger-edit-session="${sessionId}"]`
    const overlays = '.bp-modal-overlay, .bp-picker-popover, .bp-flag-palette, .bp-transfer-popover, .bp-column-filter-popover, [role="menu"]'
    let gesture: { x: number; y: number; dragged: boolean; dismissOnly: boolean } | null = null
    const down = (event: PointerEvent) => {
      gesture = null
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !(event.target instanceof Element)) return
      const target = event.target
      const row = document.querySelector<HTMLElement>(`tr${scope}`)
      if (!row || row.closest('[inert]')) return
      const ownsFocus = row.contains(document.activeElement)
      const control = target.closest('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], label, summary, [contenteditable]')
      if (target.closest(scope)) {
        if (ownsFocus && !control) event.preventDefault()
        return
      }
      if (document.querySelector(overlays)) {
        if (!target.closest(overlays)) gesture = { x: event.clientX, y: event.clientY, dragged: false, dismissOnly: true }
        return
      }
      if (target.closest('[role="separator"], .bp-column-resizer')) return
      if (target instanceof HTMLElement) {
        const bounds = target.getBoundingClientRect()
        if (target.scrollHeight > target.clientHeight && event.clientX >= bounds.left + target.clientLeft + target.clientWidth || target.scrollWidth > target.clientWidth && event.clientY >= bounds.top + target.clientTop + target.clientHeight) return
      }
      if (!target.closest('.bp-ledger-history-actions')) gesture = { x: event.clientX, y: event.clientY, dragged: false, dismissOnly: false }
      if (ownsFocus && !control) event.preventDefault()
    }
    const move = (event: PointerEvent) => {
      if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) gesture.dragged = true
    }
    const clear = () => { gesture = null }
    const click = (event: MouseEvent) => {
      const current = gesture
      gesture = null
      if (!current || event.button !== 0 || event.detail === 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (current.dragged || current.dismissOnly) { event.preventDefault(); event.stopPropagation(); return }
      saveRef.current?.()
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointercancel', clear, true)
    document.addEventListener('click', click, true)
    document.addEventListener('scroll', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointercancel', clear, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('scroll', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [sessionId])
}

export function useCleanEditorDismiss(sessionId: string | null, onDismiss: () => boolean, resumeSelector?: string) {
  useEffect(() => {
    if (sessionId === null) return
    const scope = `[data-ledger-edit-session="${sessionId}"]`
    const ignoredTargets = [scope, resumeSelector, '[role="separator"]', '.bp-column-resizer'].filter(Boolean).join(', ')
    const openOverlays = `.bp-modal-overlay, .bp-picker-popover${scope}, .bp-flag-palette${scope}`
    const dismiss = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return
      const target = event.target
      if (target.closest(ignoredTargets)) return
      if (document.querySelector(openOverlays)) return
      // Release workspace guards before the destination's pointer and click handlers run.
      flushSync(() => { onDismiss() })
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [onDismiss, resumeSelector, sessionId])
}

export function focusEntryField(sessionId: string, field?: string, previous?: HTMLElement | null) {
  const row = document.querySelector<HTMLElement>(`tr[data-ledger-edit-session="${sessionId}"]`)
  const cell = field ? row?.querySelector<HTMLElement>(`td[data-column="${field}"]`) ?? (field === 'amount_cents' ? row?.querySelector<HTMLElement>('td[data-column="outflow"]') : null) : null
  const target = cell?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')
    ?? (previous?.isConnected && row?.contains(previous) && previous.closest('td.has-cell-editor') ? previous : null)
    ?? (sessionId !== 'schedule' ? row?.querySelector<HTMLElement>('[data-ledger-date-trigger]:not(:disabled)') : null)
    ?? row?.querySelector<HTMLElement>('td.has-cell-editor button:not(:disabled), td.has-cell-editor input:not(:disabled)')
  if (!document.querySelector('.bp-modal-overlay')) target?.focus({ preventScroll: true })
}

export interface LedgerCellTarget { column: string; line?: string }

export function clickedLedgerCell(target: EventTarget): LedgerCellTarget | undefined {
  const cell = target instanceof Element ? target.closest<HTMLElement>('td[data-column]') : null
  return cell?.dataset.column ? { column: cell.dataset.column, line: cell.parentElement?.dataset.splitLine } : undefined
}

// Only popup triggers open; plain cell buttons such as "No end" perform an edit and stay untouched.
export function enterLedgerCell(row: Element | null | undefined, column: string) {
  const control = row?.querySelector(`td[data-column="${column}"]`)?.querySelector<HTMLElement>('input:not(:disabled), button[aria-haspopup]:not(:disabled)')
  if (!control || document.querySelector('.bp-modal-overlay')) return false
  control.focus({ preventScroll: true })
  if (control instanceof HTMLInputElement) control.setSelectionRange(control.value.length, control.value.length)
  else if (control.getAttribute('aria-expanded') === 'false') control.click()
  return true
}

export function focusNextLedgerCell(trigger: HTMLButtonElement) {
  const cell = trigger.closest('td')
  const row = cell?.parentElement
  if (!cell || !row) return
  requestAnimationFrame(() => {
    if (!trigger.isConnected || document.activeElement !== trigger || document.querySelector('.bp-modal-overlay')) return
    const cells = Array.from(row.children)
    for (const nextCell of cells.slice(cells.indexOf(cell) + 1)) {
      const next = Array.from(nextCell.querySelectorAll<HTMLElement>('button.bp-cell-picker:not(:disabled), button[data-ledger-cell-advance]:not(:disabled), input.bp-cell-input:not(:disabled)'))
        .find((control) => control.tabIndex >= 0 && !control.closest('[inert]'))
      if (next) {
        next.focus({ preventScroll: true })
        return
      }
    }
  })
}

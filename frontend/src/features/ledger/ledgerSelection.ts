type Modifiers = { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }
export type SelectionGesture = 'one' | 'toggle' | 'range'

export function selectionGesture(event: Modifiers): SelectionGesture {
  return event.metaKey || event.ctrlKey ? 'toggle' : event.shiftKey ? 'range' : 'one'
}

export function selectRowIds<T>(selected: ReadonlySet<T>, ordered: readonly T[], id: T, anchor: T | null, gesture: SelectionGesture): Set<T> {
  if (gesture === 'one') return new Set([id])
  if (gesture === 'toggle') {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }
  const index = ordered.indexOf(id)
  const anchorIndex = anchor === null ? -1 : ordered.indexOf(anchor)
  const start = anchorIndex < 0 ? index : anchorIndex
  return new Set(ordered.slice(Math.min(start, index), Math.max(start, index) + 1))
}

export function rowKeyAction(event: Modifiers & { key: string; altKey: boolean }): 'menu' | 'previous' | 'next' | 'edit' | null {
  if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) return 'menu'
  if (event.key === 'ArrowUp') return 'previous'
  if (event.key === 'ArrowDown') return 'next'
  if ((event.key === 'Enter' || event.key === 'F2') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) return 'edit'
  return null
}

export function isRowControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, input, select, textarea'))
}

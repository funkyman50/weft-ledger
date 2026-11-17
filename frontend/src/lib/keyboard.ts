import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

export function isComposingKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229
}

export function navigateActionMenu(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (isComposingKey(event.nativeEvent) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}

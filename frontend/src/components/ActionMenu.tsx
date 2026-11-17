import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type Ref, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { isComposingKey, navigateActionMenu } from '../lib/keyboard'
import { usePickerPosition } from './pickerPosition'

type MenuDismissal = 'escape' | 'tab' | 'outside'

export function ActionMenu({ anchorRef, menuRef, width = 196, placement = 'vertical', align = 'start', relatedRefs = [], autoFocus = true, onDismiss, onKeyDown, children, className, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'onDismiss'> & {
  anchorRef: RefObject<HTMLElement | null>
  menuRef: RefObject<HTMLDivElement | null>
  width?: number
  placement?: 'vertical' | 'above' | 'side'
  align?: 'start' | 'end'
  relatedRefs?: RefObject<HTMLElement | null>[]
  autoFocus?: boolean
  onDismiss: (reason: MenuDismissal) => void
}) {
  const position = usePickerPosition(true, anchorRef, menuRef, width, placement, align)
  useEffect(() => {
    if (!autoFocus) return
    queueMicrotask(() => {
      const menu = menuRef.current
      const first = menu?.querySelector<HTMLButtonElement>('button:not(:disabled):not([aria-disabled="true"])') ?? menu?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      first?.focus()
    })
  }, [autoFocus, menuRef])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if ([menuRef, anchorRef, ...relatedRefs].some((ref) => ref.current?.contains(target))) return
      onDismiss('outside')
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [anchorRef, menuRef, onDismiss, relatedRefs])

  return createPortal(<div {...props} ref={menuRef} className={`bp-row-menu bp-context-menu${className ? ` ${className}` : ''}`} style={position} role="menu" tabIndex={-1} onKeyDown={(event) => {
    if (isComposingKey(event.nativeEvent)) return
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onDismiss('escape')
      return
    }
    if (event.key === 'Tab') { onDismiss('tab'); return }
    navigateActionMenu(event)
  }}>{children}</div>, document.body)
}

export function ActionMenuItem({ disabled = false, danger = false, title, onClick, className, ref, role = 'menuitem', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  danger?: boolean
  ref?: Ref<HTMLButtonElement>
}) {
  return <button {...props} ref={ref} className={[className, danger && 'is-danger'].filter(Boolean).join(' ') || undefined} type="button" role={role} aria-disabled={disabled || undefined} aria-description={disabled ? title : undefined} title={title} onClick={(event) => {
    if (disabled) { event.preventDefault(); return }
    onClick?.(event)
  }} />
}

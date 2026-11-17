import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft } from 'lucide-react'
import { usePickerPosition } from '../../components/pickerPosition'

export function TransferPopover({ triggerLabel, triggerTitle, trigger, direction, accountName, tone, busy = false, focusKey, onOpen, onRequestOpen, children }: {
  triggerLabel: string
  triggerTitle?: string
  trigger?: ReactNode
  direction: string
  accountName: string
  tone?: string
  busy?: boolean
  focusKey?: unknown
  onOpen?: () => void
  onRequestOpen: (open: () => void) => void
  children: (close: (restoreFocus?: boolean) => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const position = usePickerPosition(open, triggerRef, popupRef, 260)
  const close = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event) => { if (!triggerRef.current?.contains(event.target as Node) && !popupRef.current?.contains(event.target as Node) && !busy) setOpen(false) }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('focusin', dismiss, true)
    requestAnimationFrame(() => { if (popupRef.current && !popupRef.current.contains(document.activeElement)) (popupRef.current.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? popupRef.current).focus({ preventScroll: true }) })
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('focusin', dismiss, true) }
  }, [busy, open])
  useEffect(() => {
    if (open && document.activeElement === popupRef.current) popupRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [focusKey, open])
  return <><button ref={triggerRef} className={trigger ? 'bp-transfer-cell' : 'bp-transfer-indicator'} type="button" aria-label={triggerLabel} title={triggerTitle ?? `Transfer: ${accountName}`} aria-expanded={open} onClick={(event) => { event.stopPropagation(); if (open) setOpen(false); else onRequestOpen(() => { onOpenRef.current?.(); setOpen(true) }) }}>{trigger ?? <ArrowRightLeft aria-hidden="true" />}</button>
    {open && createPortal(<div ref={popupRef} className={`bp-transfer-popover${tone ? ` is-${tone}` : ''}`} style={position} role="dialog" aria-label="Transfer details" tabIndex={-1} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && !busy) close() }}>
      <div className="bp-transfer-popover-head">
        <span className="bp-transfer-popover-icon" aria-hidden="true"><ArrowRightLeft /></span>
        <span className="bp-transfer-popover-title"><small>{direction}</small><strong>{accountName}</strong></span>
      </div>
      {children(close)}
    </div>, document.body)}
  </>
}

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TransactionFlag } from '../../api/types'
import { usePickerPosition } from '../../components/pickerPosition'
import { TRANSACTION_FLAGS, transactionFlagLabel } from './transactionFlags'
import { isComposingKey } from '../../lib/keyboard'

export function TransactionFlagMarker({ value, label = true }: { value: TransactionFlag; label?: boolean }) {
  return <span className={`bp-flag-marker${value ? ` is-${value}` : ' is-clear'}`} aria-label={transactionFlagLabel(value)} title={transactionFlagLabel(value)}>{label && <span className="bp-visually-hidden">{transactionFlagLabel(value)}</span>}</span>
}

export function TransactionFlagPicker({
  value,
  disabled = false,
  saving = false,
  onSavingAttempt,
  onRequestOpen,
  sessionId,
  staging,
  onChange,
}: {
  value: TransactionFlag
  disabled?: boolean
  saving?: boolean
  onSavingAttempt?: () => void
  onRequestOpen?: (open: () => void) => void
  sessionId?: string
  staging?: { unchanged: boolean; unchangedLabel: string; triggerLabel?: string; onReset: () => void }
  onChange: (value: TransactionFlag) => void
}) {
  const pickerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const position = usePickerPosition(open, triggerRef, popupRef, 184)
  const selected = value

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (isComposingKey(event)) return
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])

  const choose = (next: TransactionFlag) => {
    if (saving) {
      onSavingAttempt?.()
      return
    }
    onChange(next)
    setOpen(false)
    triggerRef.current?.focus()
  }

  return <>
    <button
      ref={triggerRef}
      className={`bp-flag-trigger${selected ? ` is-${selected}` : ' is-clear'}`}
      type="button"
      aria-label={staging?.unchanged ? staging.triggerLabel ?? staging.unchangedLabel : `Transaction flag: ${transactionFlagLabel(value)}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? pickerId : undefined}
      aria-disabled={saving || undefined}
      disabled={disabled}
      onClick={(event) => { event.stopPropagation(); if (saving) { onSavingAttempt?.(); return }; if (open) setOpen(false); else if (onRequestOpen) onRequestOpen(() => setOpen(true)); else setOpen(true) }}
    ><TransactionFlagMarker value={value} label={false} /></button>
    {open && createPortal(
      <div ref={popupRef} id={pickerId} className="bp-flag-palette" style={position} role="listbox" aria-label="Transaction flag" data-ledger-edit-session={sessionId}>
        {staging && <button type="button" role="option" aria-selected={staging.unchanged} onClick={() => { staging.onReset(); setOpen(false); triggerRef.current?.focus() }}><span className="bp-flag-clear-glyph" aria-hidden="true">−</span><span>{staging.unchangedLabel}</span></button>}
        {TRANSACTION_FLAGS.map((flag) => <button key={flag} type="button" role="option" aria-selected={!staging?.unchanged && selected === flag} onClick={() => choose(flag)}><TransactionFlagMarker value={flag} label={false} /><span>{transactionFlagLabel(flag)}</span></button>)}
        <button className="bp-flag-clear" type="button" role="option" aria-selected={!staging?.unchanged && selected === null} onClick={() => choose(null)}><span className="bp-flag-clear-glyph" aria-hidden="true">×</span><span>Clear</span></button>
      </div>,
      document.body,
    )}
  </>
}

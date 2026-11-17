import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isComposingKey } from '../lib/keyboard'
import { usePickerPosition } from './pickerPosition'

export function HelpTooltip({ explanation, children, className, as = 'span' }: {
  explanation: string
  children: ReactNode
  className: string
  as?: 'span' | 'button'
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  const popupRef = useRef<HTMLSpanElement>(null)
  const position = usePickerPosition(open, anchorRef, popupRef, 230)
  const Trigger = as
  return <>
    <Trigger ref={(element) => { anchorRef.current = element }} className={className} type={as === 'button' ? 'button' : undefined} tabIndex={as === 'span' ? 0 : undefined} aria-label={explanation}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (document.activeElement !== anchorRef.current) setOpen(false) }}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={as === 'button' ? () => setOpen(true) : undefined}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent)) return
        if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false) }
      }}
    ><span aria-hidden="true">{children}</span></Trigger>
    {open && createPortal(<span ref={popupRef} className="bp-status-tooltip" style={position} aria-hidden="true">{explanation}</span>, document.body)}
  </>
}

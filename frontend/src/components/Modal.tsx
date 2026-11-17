import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { isComposingKey } from '../lib/keyboard'

interface ModalProps {
  children: ReactNode
  labelledBy: string
  className?: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'workbench'
  placement?: 'center' | 'corner'
  role?: 'dialog' | 'alertdialog'
  onRequestClose: (reason: 'escape' | 'overlay') => void
  initialFocusRef?: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
  extraFocusSelector?: string
  loading?: boolean
  inactive?: boolean
}

const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])'

function availableForFocus(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0 && !element.matches(':disabled') && !element.closest('[inert], details:not([open]) > :not(summary)')
}

// A replacement shell inherits the opener before the closing microtask restores focus.
let closingFocus: { target: HTMLElement | null; dialog: HTMLElement | null } | null = null

// Loading dialogs stay invisible this long so fast loads open once with their content.
const REVEAL_GRACE_MS = 300

// A dialog mounted in the same commit that removes another continues its presentation instead of replaying the entrance.
let replaced: { owner: object; shown: boolean; openedAt: number } | null = null

const ModalRecoveryNoticeContext = createContext<ReactNode>(null)
const ModalFocusContext = createContext<RefObject<HTMLElement | null> | null>(null)
const ModalCornerContext = createContext<(() => DOMRect | null) | null>(null)

// Corner placement uses this area instead of the window, so a panel sits in the corner of the surface it belongs to.
export function ModalCornerProvider({ children, area }: { children: ReactNode; area: () => DOMRect | null }) {
  return <ModalCornerContext.Provider value={area}>{children}</ModalCornerContext.Provider>
}

const CORNER_INSET = 8

// The panel grows upward past the area when its content needs the room.
function cornerStyle(area: DOMRect | null): CSSProperties | undefined {
  if (!area) return undefined
  return {
    paddingRight: Math.max(12, document.documentElement.clientWidth - area.right + CORNER_INSET),
    paddingBottom: Math.max(12, document.documentElement.clientHeight - area.bottom + CORNER_INSET),
  }
}

export function ModalRecoveryNoticeProvider({ children, notice }: { children: ReactNode; notice: ReactNode }) {
  return <ModalRecoveryNoticeContext.Provider value={notice}>{children}</ModalRecoveryNoticeContext.Provider>
}

export function Modal({ children, labelledBy, className, size = 'md', placement = 'center', role = 'dialog', onRequestClose, initialFocusRef, returnFocusRef, extraFocusSelector, loading = false, inactive = false }: ModalProps) {
  const recoveryNotice = useContext(ModalRecoveryNoticeContext)
  const cornerArea = useContext(ModalCornerContext)
  const [corner, setCorner] = useState<CSSProperties>()
  useLayoutEffect(() => {
    if (placement !== 'corner' || !cornerArea) return
    const update = () => setCorner(cornerStyle(cornerArea()))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [placement, cornerArea])
  const parentFocus = useContext(ModalFocusContext)
  const lastFocusRef = useRef<HTMLElement | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const returnTargetRef = useRef(returnFocusRef)
  returnTargetRef.current = returnFocusRef
  const owner = useRef({}).current
  const openedAt = useRef(0)
  const [shown, setShown] = useState(!loading)
  const [continued, setContinued] = useState(false)
  if (!shown && !loading) setShown(true)
  const shownRef = useRef(shown)
  shownRef.current = shown
  const inactiveRef = useRef(inactive)
  inactiveRef.current = inactive

  useLayoutEffect(() => {
    const previous = replaced
    replaced = null
    if (previous?.owner !== owner) {
      openedAt.current = previous && !previous.shown ? previous.openedAt : performance.now()
      if (previous?.shown) {
        setShown(true)
        setContinued(true)
      }
    }
    return () => {
      const entry = { owner, shown: shownRef.current, openedAt: openedAt.current }
      replaced = entry
      queueMicrotask(() => { if (replaced === entry) replaced = null })
    }
  }, [owner])

  useEffect(() => {
    if (shown) return
    const timer = window.setTimeout(() => setShown(true), Math.max(0, REVEAL_GRACE_MS - (performance.now() - openedAt.current)))
    return () => window.clearTimeout(timer)
  }, [shown])

  useEffect(() => {
    const active = document.activeElement
    const previous = closingFocus
    const target = previous && (active === document.body || previous.dialog?.contains(active))
      ? previous.target
      : active === document.body && parentFocus?.current ? parentFocus.current
        : active instanceof HTMLElement ? active : null
    closingFocus = null
    const dialog = sectionRef.current
    const returnTarget = () => returnTargetRef.current?.current ?? target
    return () => {
      const previous = closingFocus
      const target = returnTarget()
      const closing = { target: target && previous?.dialog?.contains(target) ? previous.target : target, dialog }
      closingFocus = closing
      queueMicrotask(() => {
        if (closingFocus !== closing) return
        closingFocus = null
        const current = document.activeElement
        if (current !== document.body && !dialog?.contains(current)) return
        if (closing.target && availableForFocus(closing.target) && !closing.target.closest('[aria-disabled="true"]')) closing.target.focus({ preventScroll: true })
      })
    }
  }, [parentFocus])

  useEffect(() => {
    if (!shown) return
    const timer = window.setTimeout(() => {
      if (inactiveRef.current) return
      const first = sectionRef.current?.querySelector<HTMLElement>(focusableSelector)
      const target = initialFocusRef?.current ?? first ?? sectionRef.current
      target?.focus()
    }, 0)
    return () => {
      window.clearTimeout(timer)
    }
  }, [initialFocusRef, sectionRef, shown])

  useEffect(() => {
    let nativeTabFrame: number | undefined
    const cancelNativeTab = () => {
      if (nativeTabFrame !== undefined) cancelAnimationFrame(nativeTabFrame)
      nativeTabFrame = undefined
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      cancelNativeTab()
      if (event.defaultPrevented || inactiveRef.current) return
      if (event.key === 'Escape' && isComposingKey(event)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onRequestClose('escape')
        return
      }
      if (event.key !== 'Tab' || !sectionRef.current) return
      if (!shownRef.current) { event.preventDefault(); return }
      const candidates = [
        ...sectionRef.current.querySelectorAll<HTMLElement>(focusableSelector),
        ...(extraFocusSelector ? document.querySelectorAll<HTMLElement>(extraFocusSelector) : []),
      ].filter((element) => availableForFocus(element) && element.tabIndex >= 0)
      const controls = candidates.filter((element) => {
        if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name) return true
        const group = candidates.filter((candidate): candidate is HTMLInputElement => candidate instanceof HTMLInputElement && candidate.type === 'radio' && candidate.name === element.name && candidate.form === element.form)
        return element === (group.find((candidate) => candidate.checked) ?? group[0])
      })
      const active = document.activeElement
      const current = controls.indexOf(active as HTMLElement)
      const next = current < 0
        ? event.shiftKey ? controls.length - 1 : 0
        : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
      if (active instanceof HTMLInputElement && active.type === 'date') {
        // Native date fields own Tab between segments; contain only a departure.
        nativeTabFrame = requestAnimationFrame(() => {
          nativeTabFrame = undefined
          const dialog = sectionRef.current
          const focused = document.activeElement
          if (!inactiveRef.current && dialog?.isConnected && !dialog.contains(focused) && !controls.includes(focused as HTMLElement)) controls[next]?.focus()
        })
        return
      }
      event.preventDefault()
      if (!controls.length) {
        sectionRef.current.focus()
      } else {
        controls[next].focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerdown', cancelNativeTab, true)
    return () => {
      cancelNativeTab()
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerdown', cancelNativeTab, true)
    }
  }, [extraFocusSelector, onRequestClose, sectionRef])

  return createPortal(
    <div className={`bp-overlay bp-modal-overlay${placement === 'corner' ? ' bp-modal-overlay--corner' : ''}${shown ? '' : ' is-pending'}${continued ? ' is-continued' : ''}${inactive ? ' is-inactive' : ''}`} style={corner} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        event.preventDefault()
        if (shown && !inactive) onRequestClose('overlay')
      }
    }}>
      <section ref={sectionRef} className={`bp-dialog bp-dialog--${size}${className ? ` ${className}` : ''}`} role={role} inert={inactive} aria-hidden={!shown || inactive || undefined} aria-modal={inactive ? undefined : true} aria-labelledby={labelledBy} tabIndex={-1} onFocusCapture={(event) => {
        if (event.currentTarget.contains(event.target)) lastFocusRef.current = event.target as HTMLElement
      }}>
        <ModalFocusContext.Provider value={lastFocusRef}>{children}</ModalFocusContext.Provider>
        {recoveryNotice && <div className="bp-dialog-footer">{recoveryNotice}</div>}
      </section>
    </div>,
    document.body,
  )
}

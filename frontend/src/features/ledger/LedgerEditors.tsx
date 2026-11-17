import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithRef,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, Search, X } from 'lucide-react'
import { localDate } from '../../lib/date'
import { amountInputText } from '../../lib/money'
import type { Account, CategoryTree } from '../../api/types'
import { usePickerPosition } from '../../components/pickerPosition'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { DialogHeader } from '../../components/DialogHeader'
import { isComposingKey } from '../../lib/keyboard'
import type { EntryIssue } from './useLedgerEditor'
import { matchesSearch, searchQuery } from '../../lib/search'

export function LedgerEditorActions({ noun, isNew, disabled, unchanged, onSave, onCancel }: {
  noun: 'transaction' | 'schedule'
  isNew: boolean
  disabled: boolean
  unchanged: boolean
  onSave: (keyboard: boolean) => void
  onCancel: (keyboard: boolean) => void
}) {
  return <span className="bp-row-actions">
    <button className="bp-row-command bp-editor-command" type="button" aria-label={`${isNew ? 'Create' : 'Save'} ${noun}`} title="Save (Enter)" disabled={disabled || unchanged} onClick={(event) => { event.stopPropagation(); onSave(event.detail === 0) }}><Check aria-hidden="true" /></button>
    <button className="bp-row-command bp-editor-command is-cancel" type="button" aria-label={isNew ? `Cancel new ${noun}` : `Cancel ${noun} edit`} title="Cancel (Esc)" disabled={disabled} onClick={(event) => { event.stopPropagation(); onCancel(event.detail === 0) }}><X aria-hidden="true" /></button>
  </span>
}

export function NewEntryExitDialog({ noun, issues, onContinue, onDiscard }: { noun: 'transaction' | 'schedule'; issues: EntryIssue[]; onContinue: () => void; onDiscard: () => void }) {
  const continueRef = useRef<HTMLButtonElement>(null)
  return <Modal size="sm" role="alertdialog" labelledBy="new-entry-exit-title" initialFocusRef={continueRef} onRequestClose={onContinue}>
    <DialogHeader titleId="new-entry-exit-title" title={issues.length ? `This ${noun} isn't ready to save` : `Discard this ${noun}?`} subtitle={`This new ${noun} has not been saved.`} onClose={onContinue} />
    <div className="bp-dialog-body">{issues.length
      ? <><p className="bp-dialog-copy">Fix these before saving, or discard the {noun}:</p><ul className="bp-dialog-copy bp-dialog-list">{issues.map((issue) => <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>)}</ul></>
      : <p className="bp-dialog-copy">Discarding removes everything entered in this {noun}.</p>}</div>
    <div className="bp-dialog-footer"><Button ref={continueRef} size="lg" onClick={onContinue}>Continue editing</Button><Button size="lg" variant="danger" onClick={onDiscard}>Discard {noun}</Button></div>
  </Modal>
}

const SHOW_SPENDING_CLASSIFICATION_KEY = 'weft.showCategorySpendingClassification'
const spendingClassificationListeners = new Set<() => void>()
let showSpendingClassification = (() => {
  try {
    return localStorage.getItem(SHOW_SPENDING_CLASSIFICATION_KEY) === 'true'
  } catch {
    return false
  }
})()

function subscribeSpendingClassification(listener: () => void) {
  spendingClassificationListeners.add(listener)
  return () => { spendingClassificationListeners.delete(listener) }
}

function setShowSpendingClassification(enabled: boolean) {
  showSpendingClassification = enabled
  try { localStorage.setItem(SHOW_SPENDING_CLASSIFICATION_KEY, String(enabled)) } catch { }
  spendingClassificationListeners.forEach((listener) => listener())
}

function spendingClassificationTag(isDiscretionary: boolean | null) {
  if (isDiscretionary === null) return undefined
  return isDiscretionary ? { tag: 'D', label: 'Discretionary' } : { tag: 'N', label: 'Non-discretionary' }
}

function stepPickerResult(
  options: readonly { id: number }[],
  activeId: number | null,
  direction: 'ArrowDown' | 'ArrowUp',
): number | null {
  if (options.length === 0) return null
  const currentIndex = activeId === null ? -1 : options.findIndex((option) => option.id === activeId)
  const nextIndex = direction === 'ArrowDown'
    ? Math.min(currentIndex + 1, options.length - 1)
    : currentIndex === -1
      ? options.length - 1
      : Math.max(currentIndex - 1, 0)
  return options[nextIndex]?.id ?? null
}

function handlePickerTab(
  event: KeyboardEvent<HTMLDivElement>,
  popup: HTMLDivElement | null,
  close: () => void,
  trap = false,
  entry: HTMLElement | null = null,
) {
  if (event.key !== 'Tab') return
  const controls = Array.from(popup?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input:not(:disabled), button:not(:disabled)') ?? [])
    .filter((control) => control.tabIndex >= 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (entry && !trap) {
    const ordered = [...controls.filter((control) => control !== entry), entry]
    const index = ordered.indexOf(event.target as HTMLInputElement | HTMLButtonElement)
    if (index === -1) return
    event.preventDefault()
    event.stopPropagation()
    const next = ordered[index + (event.shiftKey ? -1 : 1)]
    if (next) next.focus()
    else close()
    return
  }
  if ((event.shiftKey && event.target === first) || (!event.shiftKey && event.target === last)) {
    event.preventDefault()
    event.stopPropagation()
    if (trap) (event.shiftKey ? last : first)?.focus()
    else close()
  }
}

export interface PickerOption {
  id: number
  label: string
  editable?: boolean
}

export interface StagedPickerConfig {
  unchanged: boolean
  unchangedLabel: string
  triggerLabel?: string
  onReset: () => void
}

interface OptionPickerProps {
  ariaLabel: string
  sessionId: string
  value: number | null
  options: PickerOption[]
  emptyLabel: string
  fallbackLabel?: string | null
  disabled?: boolean
  staging?: StagedPickerConfig
  onEditPayee?: (id: number) => void
  onCreatePayee?: (name: string) => Promise<boolean>
  createPending?: boolean
  createError?: string | null
  createRecovery?: boolean
  onRecoverCreate?: () => Promise<void>
  onCreateQueryChange?: () => void
  onAdvance?: (trigger: HTMLButtonElement) => void
  onChange: (value: number | null) => void
  iconOnly?: boolean
  allowEmpty?: boolean
  autoOpen?: boolean
  tabIndex?: number
}

export function LedgerOptionPicker({
  ariaLabel,
  sessionId,
  value,
  options,
  emptyLabel,
  fallbackLabel,
  disabled = false,
  staging,
  onEditPayee,
  onCreatePayee,
  createPending = false,
  createError,
  createRecovery = false,
  onRecoverCreate,
  onCreateQueryChange,
  onAdvance,
  onChange,
  iconOnly = false,
  allowEmpty = true,
  autoOpen = false,
  tabIndex,
}: OptionPickerProps) {
  const pickerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const recoveryRef = useRef<HTMLButtonElement>(null)
  const initialSearchCaretRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeResultId, setActiveResultId] = useState<number | null>(null)
  const createActivationRef = useRef(false)
  const focusAfterCreateRef = useRef(false)
  const position = usePickerPosition(open, triggerRef, popupRef, 220)
  const didAutoOpen = useRef(false)
  useEffect(() => { if (autoOpen && !didAutoOpen.current) { didAutoOpen.current = true; triggerRef.current?.click() } }, [autoOpen])
  const selected = options.find((option) => option.id === value)
  const fallback = value !== null && !selected ? fallbackLabel : null
  const matches = useMemo(() => {
    const normalized = searchQuery(query)
    const results = normalized
      ? options.filter((option) => matchesSearch(option.label, normalized))
      : options
    return [...results].sort((left, right) => left.label.localeCompare(right.label))
  }, [options, query])
  const activeOptionId = activeResultId !== null && matches.some((option) => option.id === activeResultId)
    ? activeResultId
    : query.trim()
      ? matches[0]?.id ?? null
      : null
  const createName = query.trim()
  const exactPayee = options.find((option) => option.editable !== false && option.label.trim().toLowerCase() === createName.toLowerCase())
  const editablePayee = createName ? exactPayee : selected
  const editPayee = onEditPayee && editablePayee?.editable !== false ? editablePayee : undefined
  const createDuplicate = exactPayee !== undefined
  const createDisabled = !onCreatePayee || !createName || createDuplicate || createPending || createRecovery
  const actionsDisabled = disabled || createPending || createRecovery

  useEffect(() => {
    if (!open) return
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target) || createPending || createRecovery) return
      setOpen(false)
      setQuery('')
      setActiveResultId(null)
    }
    document.addEventListener('pointerdown', handleOutside, true)
    queueMicrotask(() => {
      (createRecovery ? recoveryRef.current : searchRef.current)?.focus()
      if (initialSearchCaretRef.current !== null) {
        searchRef.current?.setSelectionRange(initialSearchCaretRef.current, initialSearchCaretRef.current)
        initialSearchCaretRef.current = null
      }
    })
    return () => document.removeEventListener('pointerdown', handleOutside, true)
  }, [createPending, createRecovery, open])

  useEffect(() => {
    if (!focusAfterCreateRef.current || open || createPending) return
    focusAfterCreateRef.current = false
    triggerRef.current?.focus()
  }, [createPending, open])

  useEffect(() => {
    if (!open || activeOptionId === null) return
    document.getElementById(`${pickerId}-option-${activeOptionId}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeOptionId, open, pickerId])

  const choose = (nextValue: number | null, advance = false) => {
    if (actionsDisabled) return
    onChange(nextValue)
    triggerRef.current?.focus()
    setOpen(false)
    setQuery('')
    setActiveResultId(null)
    if (advance && triggerRef.current) onAdvance?.(triggerRef.current)
  }

  const closeToTrigger = () => {
    setOpen(false)
    setQuery('')
    setActiveResultId(null)
    triggerRef.current?.focus()
  }

  const create = async () => {
    if (createDisabled || createActivationRef.current || !onCreatePayee) return
    createActivationRef.current = true
    try {
      if (await onCreatePayee(createName)) {
        focusAfterCreateRef.current = true
        setOpen(false)
        setQuery('')
      }
    } finally {
      createActivationRef.current = false
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        className={`bp-cell-picker${iconOnly ? ' bp-transfer-picker' : ''}${iconOnly && value !== null && !staging?.unchanged ? ' is-assigned' : ''}`}
        type="button"
        aria-label={iconOnly ? `${ariaLabel}: ${staging?.unchanged ? staging.unchangedLabel : selected?.label ?? fallback ?? emptyLabel}` : ariaLabel}
        title={iconOnly ? staging?.unchanged ? staging.unchangedLabel : selected?.label ?? fallback ?? emptyLabel : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${pickerId}-listbox`}
        data-ledger-picker={pickerId}
        data-transfer-picker={iconOnly || undefined}
        tabIndex={tabIndex}
        disabled={disabled}
        onClick={() => {
          if (createPending || createRecovery) return
          setQuery('')
          setActiveResultId(null)
          setOpen((current) => !current)
        }}
        onKeyDown={(event) => {
          if (open || createPending || createRecovery || event.altKey || event.ctrlKey || event.metaKey || isComposingKey(event.nativeEvent) || event.key === ' ' || event.key.length !== 1) return
          event.preventDefault()
          initialSearchCaretRef.current = event.key.length
          setQuery(event.key)
          setActiveResultId(null)
          onCreateQueryChange?.()
          setOpen(true)
        }}
      >
        {iconOnly ? <ArrowRightLeft aria-hidden="true" /> : <span className={selected || fallback || staging?.unchanged ? undefined : 'is-empty'}>
          {staging?.unchanged ? staging.triggerLabel ?? staging.unchangedLabel : selected?.label ?? fallback ?? emptyLabel}
        </span>}
        {!iconOnly && <ChevronDown aria-hidden="true" />}
      </button>
      {open && createPortal(
        <div
          ref={popupRef}
          className="bp-picker-popover bp-picker-select"
          style={position}
          data-ledger-edit-session={sessionId}
          data-ledger-picker={pickerId}
          onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return
            if (event.key === 'Escape') {
              if (createPending || createRecovery) return
              event.stopPropagation()
              closeToTrigger()
              return
            }
            handlePickerTab(event, popupRef.current, closeToTrigger, createPending || createRecovery, onAdvance ? searchRef.current : null)
          }}
        >
          <label className="bp-picker-search">
            <Search aria-hidden="true" />
            <input
              ref={searchRef}
              aria-label={`Search ${ariaLabel.toLowerCase()}`}
              role="combobox"
              aria-expanded
              aria-controls={`${pickerId}-listbox`}
              aria-activedescendant={activeOptionId === null ? undefined : `${pickerId}-option-${activeOptionId}`}
              value={query}
              disabled={createPending || createRecovery}
              onChange={(event) => {
                const nextQuery = event.target.value
                setQuery(nextQuery)
                setActiveResultId(null)
                onCreateQueryChange?.()
              }}
              onKeyDown={(event) => {
                if (isComposingKey(event.nativeEvent)) return
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  event.stopPropagation()
                  const nextId = stepPickerResult(matches, activeOptionId, event.key)
                  if (nextId !== null) setActiveResultId(nextId)
                } else if (event.key === 'Enter' || (onAdvance && event.key === 'Tab' && !event.shiftKey)) {
                  event.preventDefault()
                  event.stopPropagation()
                  if (onAdvance && event.repeat) return
                  if (activeOptionId !== null) choose(activeOptionId, Boolean(onAdvance))
                  else if (event.key === 'Tab' && !query.trim()) {
                    closeToTrigger()
                    if (triggerRef.current) onAdvance?.(triggerRef.current)
                  }
                }
              }}
            />
          </label>
          <div className="bp-picker-commands">
            {staging && <button type="button" disabled={actionsDisabled} aria-pressed={staging.unchanged} className={staging.unchanged ? 'is-selected' : undefined} onClick={() => { staging.onReset(); closeToTrigger() }}>{staging.unchangedLabel}</button>}
            {allowEmpty && <button
              type="button"
              disabled={actionsDisabled}
              aria-pressed={!staging?.unchanged && value === null}
              className={!staging?.unchanged && value === null ? 'is-selected' : undefined}
              onClick={() => choose(null)}
            >
              <strong>{emptyLabel}</strong>
            </button>}
            {editPayee ? <button type="button" disabled={actionsDisabled} title={`Edit ${editPayee.label}`} aria-label={`Edit payee ${editPayee.label}`} onClick={() => { closeToTrigger(); onEditPayee?.(editPayee.id) }}>Edit {editPayee.label}</button>
              : onCreatePayee && createName && <button type="button" disabled={createDisabled} title={`Create “${createName}”`} aria-label={`Create payee ${createName}`} onClick={() => { void create() }}>+ Create “{createName}”</button>}
          </div>
          {(createPending || createRecovery || createError) && <div className={`bp-picker-feedback${createError ? ' is-error' : ''}`} role={createError ? 'alert' : 'status'}>{createPending ? (createRecovery ? 'Refreshing…' : 'Creating…') : createRecovery ? <><span>{createError ?? 'Create outcome unknown.'}</span><button ref={recoveryRef} type="button" onClick={() => { void onRecoverCreate?.() }}>Refresh</button></> : createError}</div>}
          <div id={`${pickerId}-listbox`} className="bp-picker-options" role="listbox" aria-label={`${ariaLabel} options`}>
            {matches.map((option) => (
              <button
                key={option.id}
                id={`${pickerId}-option-${option.id}`}
                type="button"
                role="option"
                tabIndex={-1}
                disabled={actionsDisabled}
                aria-selected={option.id === value}
                className={`${option.id === value ? 'is-selected' : ''}${option.id === activeOptionId ? ' is-active' : ''}`.trim() || undefined}
                onClick={() => choose(option.id)}
              >
                {option.label}
              </button>
            ))}
            {matches.length === 0 && <span className="bp-picker-empty">No matches</span>}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

export function LedgerTransferPicker({ accounts, sourceAccountId, ...props }: Omit<OptionPickerProps, 'options' | 'emptyLabel'> & { accounts: Account[]; sourceAccountId?: number | null }) {
  const options = accounts.filter((account) => !account.closed && account.id !== sourceAccountId && (!account.plaid_connection || account.starting_balance_initialized_at !== null))
    .map((account) => ({ id: account.id, label: `Transfer: ${account.name}` }))
  const assigned = accounts.find((account) => account.id === props.value)
  return <LedgerOptionPicker {...props} options={options} fallbackLabel={assigned ? `Transfer: ${assigned.name}` : null} emptyLabel="Clear transfer" iconOnly />
}

interface CategoryPickerProps {
  ariaLabel: string
  sessionId: string
  value: number | null
  categories: CategoryTree[]
  disabled?: boolean
  staging?: StagedPickerConfig
  onChange: (value: number | null) => void
  onSplit?: () => void
  onAdvance?: (trigger: HTMLButtonElement) => void
  emptyLabel?: string
  autoFocus?: boolean
}

export function LedgerCategoryPicker({ ariaLabel, sessionId, value, categories, disabled = false, staging, onChange, onSplit, onAdvance, emptyLabel = 'No category', autoFocus = false }: CategoryPickerProps) {
  const pickerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const initialSearchCaretRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeResultId, setActiveResultId] = useState<number | null>(null)
  const position = usePickerPosition(open, triggerRef, popupRef, 250)
  const showClassification = useSyncExternalStore(subscribeSpendingClassification, () => showSpendingClassification)
  const selectedMaster = categories.find((category) => category.children.some((child) => child.id === value))
  const selectedChild = selectedMaster?.children.find((child) => child.id === value)
  const selectedLabel = selectedChild ? `${selectedMaster?.name}: ${selectedChild.name}` : undefined
  const normalized = searchQuery(query)
  const eligibleCategories = categories
    .filter((category) => !category.archived)
    .map((category) => {
      const children = category.children.filter((child) => !child.archived)
      return { category, children }
    })
  const visibleCategories = eligibleCategories.map(({ category, children }) => {
    if (!normalized) return { category, children }
    return {
      category,
      children: matchesSearch(category.name, normalized)
        ? children
        : children.filter((child) => matchesSearch(child.name, normalized)),
    }
  })
    .filter(({ children }) => children.length > 0)
  const visibleOptions = visibleCategories.flatMap(({ children }) => children)
  const activeOptionId = activeResultId !== null && visibleOptions.some((option) => option.id === activeResultId)
    ? activeResultId
    : query.trim()
      ? visibleOptions[0]?.id ?? null
      : null

  useEffect(() => {
    if (!open) return
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handleOutside, true)
    queueMicrotask(() => {
      searchRef.current?.focus()
      if (initialSearchCaretRef.current !== null) {
        searchRef.current?.setSelectionRange(initialSearchCaretRef.current, initialSearchCaretRef.current)
        initialSearchCaretRef.current = null
      }
    })
    return () => document.removeEventListener('pointerdown', handleOutside, true)
  }, [open])
  useEffect(() => { if (autoFocus) queueMicrotask(() => triggerRef.current?.focus()) }, [autoFocus])
  useEffect(() => {
    if (!open || activeOptionId === null) return
    document.getElementById(`${pickerId}-option-${activeOptionId}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeOptionId, open, pickerId])

  const choose = (nextValue: number | null, advance = false) => {
    onChange(nextValue)
    triggerRef.current?.focus()
    setOpen(false)
    setQuery('')
    setActiveResultId(null)
    if (advance && triggerRef.current) onAdvance?.(triggerRef.current)
  }

  const closeToTrigger = () => {
    setOpen(false)
    setQuery('')
    setActiveResultId(null)
    triggerRef.current?.focus()
  }

  return (
    <>
      <button ref={triggerRef} className="bp-cell-picker" type="button" aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} aria-controls={pickerId} data-ledger-picker={pickerId} disabled={disabled} onClick={() => { if (!open) { setQuery(''); setActiveResultId(null) }; setOpen((current) => !current) }} onKeyDown={(event) => {
        if (open || event.altKey || event.ctrlKey || event.metaKey || isComposingKey(event.nativeEvent) || event.key === ' ' || event.key.length !== 1) return
        event.preventDefault()
        initialSearchCaretRef.current = event.key.length
        setQuery(event.key)
        setActiveResultId(null)
        setOpen(true)
      }}>
        <span className={selectedLabel || staging?.unchanged ? undefined : 'is-empty'}>{staging?.unchanged ? staging.triggerLabel ?? staging.unchangedLabel : selectedLabel ?? emptyLabel}</span><ChevronDown aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={popupRef} id={pickerId} className="bp-picker-popover bp-picker-select" role="dialog" aria-label={ariaLabel} style={position} data-ledger-edit-session={sessionId} data-ledger-picker={pickerId} onKeyDown={(event) => {
          if (isComposingKey(event.nativeEvent)) return
          if (event.key === 'Escape') {
            event.stopPropagation()
            closeToTrigger()
            return
          }
          handlePickerTab(event, popupRef.current, closeToTrigger, false, onAdvance ? searchRef.current : null)
        }}>
          <div className="bp-picker-search-row">
            <label className="bp-picker-search"><Search aria-hidden="true" /><input ref={searchRef} aria-label="Search transaction category" role="combobox" aria-expanded aria-controls={`${pickerId}-listbox`} aria-activedescendant={activeOptionId === null ? undefined : `${pickerId}-option-${activeOptionId}`} value={query} onChange={(event) => {
              const nextQuery = event.target.value
              setQuery(nextQuery)
              setActiveResultId(null)
            }} onKeyDown={(event) => {
              if (isComposingKey(event.nativeEvent)) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                event.stopPropagation()
                const nextId = stepPickerResult(visibleOptions, activeOptionId, event.key)
                if (nextId !== null) setActiveResultId(nextId)
              } else if (event.key === 'Enter' || (onAdvance && event.key === 'Tab' && !event.shiftKey)) {
                event.preventDefault()
                event.stopPropagation()
                if (onAdvance && event.repeat) return
                if (activeOptionId !== null) choose(activeOptionId, Boolean(onAdvance))
                else if (event.key === 'Tab' && !query.trim()) {
                  closeToTrigger()
                  if (triggerRef.current) onAdvance?.(triggerRef.current)
                }
              }
            }} /></label>
            <Button className="bp-picker-classification-toggle" size="sm" variant="quiet" iconOnly aria-pressed={showClassification} aria-label={`${showClassification ? 'Hide' : 'Show'} spending classification`} title={`${showClassification ? 'Hide' : 'Show'} spending classification`} onMouseDown={(event) => event.preventDefault()} onClick={() => setShowSpendingClassification(!showClassification)}>
              {showClassification ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </Button>
          </div>
          <div className="bp-picker-commands">
            {staging && <button type="button" aria-pressed={staging.unchanged} className={staging.unchanged ? 'is-selected' : undefined} onClick={() => { staging.onReset(); setOpen(false); triggerRef.current?.focus() }}>{staging.unchangedLabel}</button>}
            <button type="button" aria-pressed={!staging?.unchanged && value === null} className={!staging?.unchanged && value === null ? 'is-selected' : undefined} onClick={() => choose(null)}>No category</button>
            {onSplit && <button className="is-split" type="button" onClick={() => { setOpen(false); setQuery(''); onSplit() }}>Split…</button>}
          </div>
          <div id={`${pickerId}-listbox`} className="bp-picker-options" role="listbox" aria-label="Transaction category options">
            {visibleCategories.map(({ category, children }) => (
              <div className="bp-category-group" key={category.id} role="group" aria-labelledby={`${pickerId}-category-${category.id}`}>
                <strong id={`${pickerId}-category-${category.id}`} className="bp-category-heading">{category.name}</strong>
                {children.map((child) => {
                  const classification = showClassification ? spendingClassificationTag(child.is_discretionary) : undefined
                  return <button key={child.id} id={`${pickerId}-option-${child.id}`} type="button" role="option" tabIndex={-1} aria-label={`${category.name}: ${child.name}${classification ? `, ${classification.label}` : ''}`} aria-selected={!staging?.unchanged && child.id === value} className={`${!staging?.unchanged && child.id === value ? 'is-selected ' : ''}bp-category-child${child.id === activeOptionId ? ' is-active' : ''}`} onClick={() => choose(child.id)}>
                    {child.name}{classification && <span className="bp-category-classification-tag" title={classification.label} aria-hidden="true">{classification.tag}</span>}
                  </button>
                })}
              </div>
            ))}
            {visibleCategories.length === 0 && <span className="bp-picker-empty">No matches</span>}
          </div>
        </div>, document.body,
      )}
    </>
  )
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}


function compactDate(value: string): string {
  return parseDate(value).toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  })
}

interface DatePickerProps {
  ariaLabel?: string
  sessionId: string
  value: string
  onChange: (value: string) => void
  onAdvance?: (trigger: HTMLButtonElement) => void
  showDropdownIcon?: boolean
}

export function LedgerDatePicker({ ariaLabel = 'Transaction date', sessionId, value, onChange, onAdvance, showDropdownIcon = false }: DatePickerProps) {
  const pickerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const focusDateAfterRenderRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [focusedDate, setFocusedDate] = useState(value)
  const position = usePickerPosition(open, triggerRef, popupRef, 248)
  const focusedDateValue = parseDate(focusedDate)
  const month = new Date(focusedDateValue.getFullYear(), focusedDateValue.getMonth(), 1)
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const leadingBlanks = month.getDay()
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - leadingBlanks + 1
    return day >= 1 && day <= daysInMonth ? day : null
  })

  useEffect(() => {
    if (!open) return
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handleOutside, true)
    return () => document.removeEventListener('pointerdown', handleOutside, true)
  }, [open])

  useEffect(() => {
    if (!open || !focusDateAfterRenderRef.current) return
    focusDateAfterRenderRef.current = false
    document.getElementById(`${pickerId}-date-${focusedDate}`)?.focus()
  }, [focusedDate, open, pickerId])

  const choose = (date: Date, advance = false) => {
    onChange(localDate(date))
    triggerRef.current?.focus()
    setOpen(false)
    if (advance && triggerRef.current) onAdvance?.(triggerRef.current)
  }

  const openCalendar = () => {
    focusDateAfterRenderRef.current = true
    setFocusedDate(value)
    setOpen(true)
  }

  const closeToTrigger = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const moveFocusedDate = (days: number) => {
    const nextDate = parseDate(focusedDate)
    nextDate.setDate(nextDate.getDate() + days)
    const nextValue = localDate(nextDate)
    focusDateAfterRenderRef.current = true
    setFocusedDate(nextValue)
  }

  const moveFocusedMonth = (months: number) => {
    const currentDate = parseDate(focusedDate)
    const targetMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + months, 1)
    const targetLastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate()
    const nextDate = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), Math.min(currentDate.getDate(), targetLastDay))
    setFocusedDate(localDate(nextDate))
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="bp-cell-picker bp-date-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${pickerId}-calendar`}
        data-ledger-picker={pickerId}
        data-ledger-date-trigger
        onClick={() => { if (open) setOpen(false); else openCalendar() }}
        onKeyDown={(event) => {
          if (isComposingKey(event.nativeEvent)) return
          if (open || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openCalendar()
          }
        }}
        onKeyUp={(event) => {
          if (isComposingKey(event.nativeEvent)) return
          if (event.key === 'Enter' || event.key === ' ') event.preventDefault()
        }}
      >
        <span>{compactDate(value)}</span>
        {showDropdownIcon && <ChevronDown aria-hidden="true" />}
      </button>
      {open && createPortal(
        <div
          ref={popupRef}
          id={`${pickerId}-calendar`}
          className="bp-picker-popover bp-calendar"
          role="dialog"
          aria-label="Choose transaction date"
          style={position}
          data-ledger-edit-session={sessionId}
          data-ledger-picker={pickerId}
          onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return
            if (event.key === 'Escape') {
              event.stopPropagation()
              closeToTrigger()
              return
            }
            handlePickerTab(event, popupRef.current, closeToTrigger, false, onAdvance ? popupRef.current?.querySelector<HTMLElement>('.bp-calendar-grid button[tabindex="0"]') : null)
          }}
        >
          <div className="bp-calendar-header">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => moveFocusedMonth(-1)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <strong>{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => moveFocusedMonth(1)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <div className="bp-calendar-grid bp-calendar-weekdays" aria-hidden="true">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
          </div>
          <div className="bp-calendar-grid" onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault()
              event.stopPropagation()
              moveFocusedDate(event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -7 : 7)
            } else if (event.key === 'Enter' || (onAdvance && event.key === 'Tab' && !event.shiftKey)) {
              event.preventDefault()
              event.stopPropagation()
              if (!event.repeat) choose(parseDate(focusedDate), Boolean(onAdvance))
            }
          }}>
            {cells.map((day, index) => day === null ? <span key={`blank-${index}`} /> : (() => {
              const date = new Date(month.getFullYear(), month.getMonth(), day)
              const selected = localDate(date) === value
              const focused = localDate(date) === focusedDate
              const today = localDate(date) === localDate(new Date())
              return (
                <button
                  key={day}
                  id={`${pickerId}-date-${localDate(date)}`}
                  type="button"
                  tabIndex={focused ? 0 : -1}
                  aria-label={date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  aria-pressed={selected}
                  className={`${selected ? 'is-selected' : ''}${today ? ' is-today' : ''}`.trim() || undefined}
                  onFocus={() => setFocusedDate(localDate(date))}
                  onClick={() => choose(date)}
                >
                  {day}
                </button>
              )
            })())}
          </div>
          <button className="bp-calendar-today" type="button" onClick={() => choose(new Date())}>Today</button>
        </div>,
        document.body,
      )}
    </>
  )
}

interface CellInputProps {
  ariaLabel: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
  inputMode?: 'decimal' | 'text'
  className?: string
}

function LedgerCellInput({
  ariaLabel,
  placeholder,
  value,
  onChange,
  onCommit,
  onCancel,
  inputMode = 'text',
  className = '',
}: CellInputProps) {
  return (
    <input
      className={`bp-cell-input${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel}
      value={value}
      placeholder={placeholder}
      inputMode={inputMode}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent)) return
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

type TransactionInputProps = Omit<CellInputProps, 'ariaLabel' | 'placeholder' | 'inputMode' | 'className'>

export function LedgerMemoInput(props: TransactionInputProps) {
  return <LedgerCellInput {...props} ariaLabel="Transaction memo" placeholder="Add memo" />
}

export function LedgerAmountInput({ onChange, ariaLabel = 'Transaction amount', ...props }: TransactionInputProps & { ariaLabel?: string }) {
  return (
    <LedgerCellInput
      {...props}
      onChange={(value) => {
        const amount = amountInputText(value)
        if (amount !== null) onChange(amount)
      }}
      ariaLabel={ariaLabel}
      placeholder="0.00"
      inputMode="decimal"
      className="bp-amount-input"
    />
  )
}

type LedgerDirectionalAmountInputProps = {
  value: string
  direction: 'outflow' | 'inflow'
  onChange: (value: string) => void
} & Omit<ComponentPropsWithRef<'input'>, 'value' | 'defaultValue' | 'onChange' | 'type' | 'inputMode'>

export function LedgerDirectionalAmountInput({ value, direction, onChange, className, ...props }: LedgerDirectionalAmountInputProps) {
  const normalized = value.replace(/[$,\s]/g, '')
  const negative = /^[-−]/.test(normalized)
  const directionalValue = (direction === 'outflow') === negative
    ? normalized.replace(/^[+−-]/, '')
    : ''
  return (
    <input
      {...props}
      className={`bp-cell-input bp-amount-input${direction === 'outflow' ? ' is-negative' : ''}${className ? ` ${className}` : ''}`}
      value={directionalValue}
      inputMode="decimal"
      placeholder="0.00"
      onChange={(event) => {
        const amount = amountInputText(event.target.value)
        if (amount === null) return
        const magnitude = amount.replace(/[$,]/g, '').replace(/^-/, '')
        onChange(magnitude ? `${direction === 'outflow' ? '-' : ''}${magnitude}` : '')
      }}
    />
  )
}

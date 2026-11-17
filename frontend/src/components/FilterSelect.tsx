import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search } from 'lucide-react'
import { usePickerPosition } from './pickerPosition'
import { isComposingKey } from '../lib/keyboard'
import { matchesSearch, searchQuery } from '../lib/search'

export interface FilterSelectOption {
  value: string
  label: string
  disabled?: boolean
}

export function FilterSelect({
  ariaLabel,
  value,
  options,
  searchable = false,
  allowCreate = false,
  disabled = false,
  autoFocus = true,
  popupWidth = 0,
  onChange,
  onAdvance,
  sessionId,
  ref,
}: {
  ariaLabel: string
  value: string
  options: FilterSelectOption[]
  searchable?: boolean
  allowCreate?: boolean
  disabled?: boolean
  autoFocus?: boolean
  popupWidth?: number
  onChange: (value: string) => void
  onAdvance?: (trigger: HTMLButtonElement) => void
  sessionId?: string
  ref?: Ref<HTMLButtonElement>
}) {
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const openingFocusRef = useRef({ searchable, selectedIndex: 0 })
  const position = usePickerPosition(open, triggerRef, popupRef, popupWidth)
  const selected = options.find((option) => option.value === value) ?? options[0]
  const visibleOptions = useMemo(() => {
    const normalized = searchQuery(query)
    const matches = normalized
      ? options.filter((option) => matchesSearch(option.label, normalized))
      : options
    if (allowCreate && normalized && !options.some((option) => option.value.toLowerCase() === normalized)) {
      return [{ value: query.trim(), label: `Use “${query.trim()}”` }, ...matches]
    }
    return matches
  }, [allowCreate, options, query])
  const firstEnabledIndex = visibleOptions.findIndex((option) => !option.disabled)
  const highlightedIndex = visibleOptions.findIndex((option) => option.value === highlighted && !option.disabled)
  const activeIndex = highlightedIndex >= 0 ? highlightedIndex : firstEnabledIndex

  if (!open) {
    openingFocusRef.current = {
      searchable,
      selectedIndex: Math.max(0, options.findIndex((option) => option.value === value && !option.disabled), options.findIndex((option) => !option.disabled)),
    }
  }

  const close = (returnFocus = true) => {
    setOpen(false)
    setQuery('')
    setHighlighted(null)
    if (returnFocus) queueMicrotask(() => triggerRef.current?.focus())
  }

  const choose = (nextValue: string) => {
    onChange(nextValue)
    close()
  }

  const focusOption = (index: number, step: 1 | -1 = 1) => {
    const count = visibleOptions.length
    for (let offset = 0; offset < count; offset += 1) {
      const candidate = (((index + offset * step) % count) + count) % count
      if (!visibleOptions[candidate].disabled) {
        if (searchable) setHighlighted(visibleOptions[candidate].value)
        optionRefs.current[candidate]?.focus()
        return
      }
    }
  }

  const optionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (isComposingKey(event.nativeEvent)) {
      if (event.key === 'Enter') event.preventDefault()
      return
    }
    if (event.key === 'Enter') {
      if (event.repeat) {
        event.preventDefault()
        return
      }
      if (!searchable && !onAdvance) return
      event.preventDefault()
      if (onAdvance) event.stopPropagation()
      choose(visibleOptions[index].value)
      if (onAdvance && triggerRef.current) onAdvance(triggerRef.current)
    } else if (onAdvance && event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      choose(visibleOptions[index].value)
      if (triggerRef.current) onAdvance(triggerRef.current)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(index - 1, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(visibleOptions.length - 1, -1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (!searchable && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const needle = event.key.toLowerCase()
      const next = visibleOptions.findIndex((option, optionIndex) => (
        optionIndex > index && !option.disabled && option.label.toLowerCase().startsWith(needle)
      ))
      const wrapped = next >= 0
        ? next
        : visibleOptions.findIndex((option) => !option.disabled && option.label.toLowerCase().startsWith(needle))
      if (wrapped >= 0) {
        event.preventDefault()
        focusOption(wrapped)
      }
    }
  }

  useEffect(() => {
    if (!open) return
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
      setQuery('')
      setHighlighted(null)
    }
    document.addEventListener('pointerdown', handleOutside, true)
    queueMicrotask(() => {
      const openingFocus = openingFocusRef.current
      if (openingFocus.searchable) searchRef.current?.focus()
      else optionRefs.current[openingFocus.selectedIndex]?.focus()
    })
    return () => document.removeEventListener('pointerdown', handleOutside, true)
  }, [open])

  return <>
    <button
      ref={(element) => {
        triggerRef.current = element
        if (typeof ref === 'function') ref(element)
        else if (ref) ref.current = element
      }}
      className="bp-filter-select-trigger"
      type="button"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      autoFocus={autoFocus}
      disabled={disabled}
      data-ledger-cell-advance={onAdvance ? true : undefined}
      onClick={() => { setHighlighted(null); setOpen((current) => !current) }}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent)) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setHighlighted(null)
          setOpen(true)
        }
      }}
    >
      <span>{selected?.label ?? 'Choose'}</span>
      <ChevronDown aria-hidden="true" />
    </button>
    {open && createPortal(
      <div
        ref={popupRef}
        className={`bp-picker-popover bp-picker-select bp-filter-select-popover${searchable ? ' is-searchable' : ''}`}
        style={position}
        data-ledger-edit-session={sessionId}
      >
        {searchable && <label className="bp-picker-search">
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label={`Search ${ariaLabel.toLowerCase()}`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlighted(null)
            }}
            onKeyDown={(event) => {
              if (isComposingKey(event.nativeEvent)) {
                if (event.key === 'Enter') event.preventDefault()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusOption(activeIndex + 1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                focusOption(activeIndex - 1, -1)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                if (event.repeat || activeIndex < 0) return
                choose(visibleOptions[activeIndex].value)
              }
            }}
          />
        </label>}
        <div id={listboxId} className="bp-picker-options" role="listbox" aria-label={`${ariaLabel} options`}>
          {visibleOptions.map((option, index) => <button
            key={`${option.value}:${option.label}`}
            ref={(element) => { optionRefs.current[index] = element }}
            type="button"
            role="option"
            aria-selected={option.value === value}
            disabled={option.disabled}
            className={`${option.value === value ? 'is-selected' : ''}${searchable && index === activeIndex ? ' is-active' : ''}`.trim() || undefined}
            onClick={() => choose(option.value)}
            onFocus={() => {
              if (searchable) setHighlighted(option.value)
            }}
            onKeyDown={(event) => optionKeyDown(event, index)}
          >
            {option.label}
          </button>)}
          {visibleOptions.length === 0 && <span className="bp-picker-empty">No matches</span>}
        </div>
      </div>,
      document.body,
    )}
  </>
}

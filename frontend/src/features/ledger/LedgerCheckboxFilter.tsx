import { useEffect, useRef, useState, type KeyboardEvent, type ComponentProps, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '../../components/Button'
import { usePickerPosition } from '../../components/pickerPosition'
import { isComposingKey } from '../../lib/keyboard'
import {
  allStatuses, allValues, canonicalSelection, changeSelection, FILTER_SELECTION_LIMIT,
  LEDGER_STATUSES, selectionSummary, statusSummary, valueSelected,
  type StatusFilter, type ValueSelection,
} from './ledgerFilters'
import { matchesSearch, searchQuery } from '../../lib/search'

export interface FilterChoice {
  value: string
  label: string
  displayLabel?: string
  parent?: { id: string; label: string }
  unavailable?: boolean
}

function MixedCheckbox({ mixed = false, inputRef, ...props }: ComponentProps<'input'> & { mixed?: boolean; inputRef?: RefObject<HTMLInputElement | null> }) {
  return <input {...props} type="checkbox" ref={(element) => { if (inputRef) inputRef.current = element; if (element) element.indeterminate = mixed }} />
}

export function LedgerCheckboxFilter({ kind, value, options, catalog = new Set<string>(), loadState, labels, anchor, onApply, onClose }: {
  kind: 'payee' | 'category' | 'status'
  value: ValueSelection | StatusFilter
  options: FilterChoice[]
  catalog?: ReadonlySet<string>
  loadState: 'loading' | 'error' | 'ready'
  labels: ReadonlyMap<string, string>
  anchor: HTMLElement
  onApply: (value: ValueSelection | StatusFilter) => void
  onClose: () => void
}) {
  const title = kind === 'payee' ? 'Payee' : kind === 'category' ? 'Category' : 'Status'
  const initial = useRef(value)
  const [selection, setSelection] = useState<ValueSelection>(() => 'needsReview' in value ? { mode: 'include', values: [...value.values] } : canonicalSelection(value))
  const [needsReview, setNeedsReview] = useState('needsReview' in value && value.needsReview)
  const [search, setSearch] = useState('')
  const [searchUnchecked, setSearchUnchecked] = useState<{ query: string; keys: Set<string> }>({ query: '', keys: new Set() })
  const changeSearch = (text: string) => {
    setSearch(text)
    setSearchUnchecked({ query: '', keys: new Set() })
  }
  const [addToFilter, setAddToFilter] = useState(false)
  const [activeChoice, setActiveChoice] = useState<string | null>(null)
  const popupRef = useRef<HTMLFormElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const bulkRef = useRef<HTMLInputElement>(null)
  const anchorRef = useRef(anchor)
  const position = usePickerPosition(true, anchorRef, popupRef, kind === 'status' ? 260 : 300)
  const baseOptions: FilterChoice[] = kind === 'status' ? [...LEDGER_STATUSES] : options
  const known = new Set(baseOptions.map((option) => option.value))
  const retainedKeys = new Set([...('mode' in initial.current ? initial.current.values : []), ...selection.values])
  const choices: FilterChoice[] = [...baseOptions, ...[...retainedKeys].filter((key) => !known.has(key)).map((key) => ({
    value: key, label: `${labels.get(key) ?? `${title} #${key}`} (${catalog.has(key) ? 'not used here' : 'unavailable'})`, unavailable: true,
  }))]
  const query = searchQuery(search)
  const visible = choices.filter((option) => matchesSearch(option.label, query))
  const groups = new Map<string, { parent?: FilterChoice['parent']; choices: FilterChoice[] }>()
  for (const choice of visible) {
    const groupKey = choice.parent?.id ?? `value:${choice.value}`
    const group = groups.get(groupKey) ?? { parent: choice.parent, choices: [] }
    group.choices.push(choice)
    groups.set(groupKey, group)
  }
  const groupList = [...groups.values()]
  const focusKeys = groupList.flatMap((group) => [...(group.parent ? [`parent:${group.parent.id}`] : []), ...group.choices.map((choice) => `value:${choice.value}`)])
  const focusKey = activeChoice && focusKeys.includes(activeChoice) ? activeChoice : focusKeys[0]
  const unchecked = searchUnchecked.query === query ? searchUnchecked.keys : new Set<string>()
  const checked = (key: string) => query ? !unchecked.has(key) : valueSelected(selection, key)
  const checkedMatches = visible.filter((choice) => checked(choice.value)).map((choice) => choice.value)
  const uncheckedMatches = visible.filter((choice) => !checked(choice.value)).map((choice) => choice.value)
  const result = !query ? canonicalSelection(selection)
    : addToFilter ? changeSelection(changeSelection(selection, checkedMatches, true), uncheckedMatches, false)
    : canonicalSelection({ mode: 'include', values: checkedMatches })
  const checkedCount = checkedMatches.length
  const currentStatus: StatusFilter = { values: LEDGER_STATUSES.filter((item) => valueSelected(selection, item.value)).map((item) => item.value), needsReview }
  const changed = kind === 'status'
    ? JSON.stringify(currentStatus) !== JSON.stringify(initial.current)
    : JSON.stringify(result) !== JSON.stringify(initial.current)
  const hasValidChoice = kind === 'status' ? baseOptions.some((choice) => valueSelected(selection, choice.value))
    : result.mode === 'include' ? result.values.some((key) => catalog.has(key))
    : baseOptions.some((choice) => valueSelected(result, choice.value))
  const tooMany = kind !== 'status' && result.values.length > FILTER_SELECTION_LIMIT
  const canApply = loadState === 'ready' && changed && hasValidChoice && !tooMany
  const summary = kind === 'status' ? statusSummary(currentStatus) : selectionSummary(result, labels, kind === 'payee' ? 'payees' : 'categories')

  useEffect(() => { (searchRef.current ?? bulkRef.current)?.focus({ preventScroll: true }) }, [])

  const close = () => {
    const popup = popupRef.current
    const ownedFocus = document.activeElement === document.body || popup?.contains(document.activeElement)
    if (ownedFocus && anchor.isConnected && !document.querySelector('.bp-modal-overlay')) anchor.focus({ preventScroll: true })
    onClose()
  }
  const apply = () => {
    if (!canApply) return
    onApply(kind === 'status' ? currentStatus : result)
    close()
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (isComposingKey(event.nativeEvent)) {
      if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
      return
    }
    if (event.repeat && (event.key === 'Enter' || event.key === 'Escape' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); return }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); event.stopPropagation(); apply(); return }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    const isCheckbox = target instanceof HTMLInputElement && target.type === 'checkbox'
    const fromSearch = target === searchRef.current && event.key === 'ArrowDown'
    if (!fromSearch && (!isCheckbox || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))) return
    const inputs = Array.from(popupRef.current?.querySelectorAll<HTMLInputElement>('input[data-filter-choice]:not(:disabled)') ?? [])
    if (!inputs.length) return
    const index = inputs.indexOf(target as HTMLInputElement)
    const next = fromSearch || event.key === 'Home' ? 0 : event.key === 'End' ? inputs.length - 1 : Math.max(0, Math.min(inputs.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))
    event.preventDefault(); event.stopPropagation(); inputs[next].focus()
  }
  const toggle = (keys: string[], value: boolean) => {
    if (!query) setSelection((current) => changeSelection(current, keys, value))
    else setSearchUnchecked((current) => {
      const next = new Set(current.query === query ? current.keys : [])
      keys.forEach((key) => value ? next.delete(key) : next.add(key))
      return { query, keys: next }
    })
  }
  const checkboxFocus = (key: string) => ({
    'data-filter-choice': key,
    tabIndex: key === focusKey ? 0 : -1,
    onFocus: () => setActiveChoice(key),
  })

  return createPortal(<form ref={popupRef} className="bp-column-filter-popover bp-checkbox-filter" aria-label={`${title} filter`} style={position} onKeyDown={keyDown} onSubmit={(event) => { event.preventDefault(); apply() }}>
    {kind !== 'status' && <div className="bp-filter-search">
      <input ref={searchRef} type="text" aria-label={`Search ${title} filter choices`} placeholder={`Search ${title.toLowerCase()}…`} value={search} onChange={(event) => changeSearch(event.target.value)} />
      {search && <Button size="sm" variant="quiet" iconOnly aria-label="Clear filter search" onClick={() => { changeSearch(''); searchRef.current?.focus() }}><X aria-hidden="true" /></Button>}
    </div>}
    <label className="bp-filter-check bp-filter-bulk"><MixedCheckbox checked={visible.length > 0 && checkedCount === visible.length} mixed={checkedCount > 0 && checkedCount < visible.length} disabled={!visible.length} inputRef={bulkRef} onChange={(event) => {
      if (!query) setSelection(event.target.checked ? allValues() : { mode: 'include', values: [] })
      else toggle(visible.map((choice) => choice.value), event.target.checked)
    }} />{query ? 'Select all search results' : 'All values'}</label>
    {query && <label className="bp-filter-check bp-filter-bulk"><input type="checkbox" checked={addToFilter} onChange={(event) => setAddToFilter(event.target.checked)} />Add current selection to filter</label>}
    <div className="bp-filter-choices" role="group" aria-label={`${title} choices`}>
      {loadState !== 'error' && groupList.map((group) => {
        const parent = group.parent
        const keys = group.choices.map((choice) => choice.value)
        const selected = group.choices.filter((choice) => checked(choice.value)).length
        return <div className="bp-filter-choice-group" key={parent ? `parent:${parent.id}` : `value:${keys[0]}`}>
          {parent && <label className="bp-filter-check bp-filter-parent"><MixedCheckbox {...checkboxFocus(`parent:${parent.id}`)} checked={selected === keys.length} mixed={selected > 0 && selected < keys.length} onChange={(event) => toggle(keys, event.target.checked)} />{parent.label}</label>}
          {group.choices.map((choice) => <label className={`bp-filter-check${parent ? ' is-child' : ''}${choice.unavailable ? ' is-unavailable' : ''}`} key={choice.value} title={choice.label}>
            <input type="checkbox" {...checkboxFocus(`value:${choice.value}`)} checked={checked(choice.value)} onChange={(event) => toggle([choice.value], event.target.checked)} />
            <span>{choice.displayLabel ?? choice.label}</span>
          </label>)}
        </div>
      })}
      {loadState === 'error' ? <span className="bp-filter-empty" role="status">Values could not be loaded.</span>
        : !visible.length && <span className="bp-filter-empty" role="status">{loadState === 'loading' ? 'Loading values…' : 'No matching choices.'}</span>}
    </div>
    {kind === 'status' && <label className="bp-filter-check bp-filter-review"><input type="checkbox" checked={needsReview} onChange={(event) => setNeedsReview(event.target.checked)} />Needs review</label>}
    {tooMany && <small className="bp-filter-error" role="status">Choose at most {FILTER_SELECTION_LIMIT} specific values, or use All values.</small>}
    <div className="bp-column-filter-actions">
      {hasValidChoice || loadState !== 'ready'
        ? <span className="bp-filter-summary" title={summary}>{summary}</span>
        : <span className="bp-filter-summary bp-filter-error" role="status">Select at least one value.</span>}
      <Button size="md" onClick={() => { onApply(kind === 'status' ? allStatuses() : allValues()); close() }}>Clear</Button>
      <Button size="md" onClick={close}>Cancel</Button>
      <Button size="md" variant="primary" type="submit" disabled={!canApply}>Apply</Button>
    </div>
  </form>, document.body)
}

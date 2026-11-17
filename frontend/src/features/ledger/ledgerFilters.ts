export const LEDGER_STATUSES = [
  { value: 'pending', label: 'Bank pending' },
  { value: 'cleared', label: 'Cleared' },
  { value: 'uncleared', label: 'Uncleared' },
  { value: 'reconciled', label: 'Reconciled' },
  { value: 'unmatched', label: 'Unmatched' },
] as const

export type LedgerStatus = typeof LEDGER_STATUSES[number]['value']
export const FILTER_SELECTION_LIMIT = 200
export interface ValueSelection { mode: 'include' | 'exclude'; values: string[] }
export interface StatusFilter { values: LedgerStatus[]; needsReview: boolean }
export interface AmountRangeFilter { minimum: string; maximum: string }
export interface LedgerFilters {
  source: string
  range: string
  payee: ValueSelection
  description: string
  category: ValueSelection
  memo: string
  amount: AmountRangeFilter
  status: StatusFilter
}
export type LedgerFilterValue = string | AmountRangeFilter | ValueSelection | StatusFilter
export type LedgerFilterKey = keyof LedgerFilters

export function allValues(): ValueSelection { return { mode: 'exclude', values: [] } }
export function allStatuses(): StatusFilter { return { values: LEDGER_STATUSES.map((item) => item.value), needsReview: false } }
export function freshLedgerFilters(): LedgerFilters {
  return { source: 'all_active', range: 'all', payee: allValues(), description: '', category: allValues(), memo: '', amount: { minimum: '', maximum: '' }, status: allStatuses() }
}

export const COLUMN_FILTER_KEYS: Partial<Record<string, LedgerFilterKey>> = {
  source: 'source', date: 'range', payee: 'payee', description: 'description', category: 'category', memo: 'memo', amount_cents: 'amount', inflow: 'amount', status: 'status',
}
export const COLUMN_FILTER_LABELS: Record<string, string> = {
  source: 'Source', date: 'Date', payee: 'Payee', description: 'Description', category: 'Category', memo: 'Memo', amount_cents: 'Amount', inflow: 'Amount', status: 'Status',
}

export function hasValueSelection(selection: ValueSelection): boolean {
  return selection.mode === 'include' || selection.values.length > 0
}
export function valueSelected(selection: ValueSelection, key: string): boolean {
  return selection.mode === 'include' ? selection.values.includes(key) : !selection.values.includes(key)
}
export function canonicalSelection(selection: ValueSelection): ValueSelection {
  return { mode: selection.mode, values: [...new Set(selection.values)].sort() }
}
export function replacePayeeSelection(selection: ValueSelection, sourceId: number, destinationId: number): ValueSelection {
  if (!selection.values.includes(String(sourceId))) return selection
  return canonicalSelection({ ...selection, values: selection.values.map((value) => value === String(sourceId) ? String(destinationId) : value) })
}
export function changeSelection(selection: ValueSelection, keys: string[], checked: boolean): ValueSelection {
  const values = new Set(selection.values)
  for (const key of keys) {
    if (checked === (selection.mode === 'include')) values.add(key)
    else values.delete(key)
  }
  return canonicalSelection({ mode: selection.mode, values: [...values] })
}
export function selectionSummary(selection: ValueSelection, labels: ReadonlyMap<string, string>, plural: string): string {
  if (!hasValueSelection(selection)) return 'All values'
  if (selection.mode === 'include' && selection.values.length === 0) return 'None selected'
  const [first] = selection.values
  const target = selection.values.length === 1 ? labels.get(first) ?? `Unavailable #${first}` : `${selection.values.length} ${plural}`
  return `${selection.mode === 'include' ? 'Only' : 'All except'}: ${target}`
}
export function statusSummary(status: StatusFilter): string {
  const names = LEDGER_STATUSES.filter((item) => status.values.includes(item.value)).map((item) => item.label)
  const target = names.length === LEDGER_STATUSES.length ? 'All statuses' : names.length === 0 ? 'None selected' : names.length === 1 ? names[0] : `${names.length} statuses`
  return `${target}${status.needsReview ? '; Needs review' : ''}`
}
export function allocationCategoryKey(allocation: { category_id: number | null; unassigned: boolean }): string {
  return allocation.unassigned ? 'unassigned' : allocation.category_id === null ? 'none' : String(allocation.category_id)
}
export function hasLedgerFilter(filters: LedgerFilters, key: LedgerFilterKey): boolean {
  if (key === 'payee' || key === 'category') return hasValueSelection(filters[key])
  if (key === 'status') return filters.status.needsReview || filters.status.values.length !== LEDGER_STATUSES.length
  if (key === 'amount') return Boolean(filters.amount.minimum.trim() || filters.amount.maximum.trim())
  const value = filters[key]
  return value !== '' && value !== 'all' && value !== 'all_active'
}
export function hasActiveLedgerFilters(filters: LedgerFilters): boolean {
  return (Object.keys(filters) as LedgerFilterKey[]).some((key) => hasLedgerFilter(filters, key))
}
export function appendLedgerFilters(params: URLSearchParams, filters: LedgerFilters): void {
  if (filters.source === 'excluded') params.set('scope', 'excluded')
  else if (filters.source === 'all_sources') params.set('scope', 'all_sources')
  else {
    params.set('scope', 'active')
    if (filters.source !== 'all_active') params.set('source', filters.source)
  }
  if (filters.range !== 'all') params.set('range', filters.range)
  if (hasValueSelection(filters.payee)) {
    params.set('payee_mode', filters.payee.mode)
    filters.payee.values.forEach((value) => params.append('payee_ids', value))
  }
  if (filters.description.trim()) params.set('description', filters.description.trim())
  if (hasValueSelection(filters.category)) {
    params.set('category_mode', filters.category.mode)
    filters.category.values.forEach((value) => params.append('category_values', value))
  }
  if (filters.memo.trim()) params.set('memo', filters.memo.trim())
  const minimum = Number(filters.amount.minimum.replace(/[$,]/g, ''))
  const maximum = Number(filters.amount.maximum.replace(/[$,]/g, ''))
  if (filters.amount.minimum.trim() && Number.isFinite(minimum)) params.set('amount_min_cents', String(Math.round(minimum * 100)))
  if (filters.amount.maximum.trim() && Number.isFinite(maximum)) params.set('amount_max_cents', String(Math.round(maximum * 100)))
  if (filters.status.values.length !== LEDGER_STATUSES.length) filters.status.values.forEach((value) => params.append('statuses', value))
  if (filters.status.needsReview) params.set('needs_review', 'true')
}

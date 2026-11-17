import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { DollarSign, Merge, Plus, Save, Scale, Trash2, X } from 'lucide-react'
import type { CategoryTree, LedgerRow, TransactionCategorization } from '../../api/types'
import { parseLedgerAmount, splitAmountText } from './useLedgerEditor'
import { LedgerCategoryPicker, LedgerDirectionalAmountInput } from './LedgerEditors'
import { focusNextLedgerCell } from './ledgerFocus'
import { ApiError } from '../../api/client'
import { Button } from '../../components/Button'
import { isComposingKey } from '../../lib/keyboard'
import { amountInputText } from '../../lib/money'

export interface SplitAllocationDraft {
  key: string
  id?: number | null
  categoryId: number | null
  categoryTouched: boolean
  memo: string
  amount: string
  unassigned: boolean
}

export interface SplitDraft {
  rowId: number
  parentAmount: string
  originalToken: string
  allocations: SplitAllocationDraft[]
}

export function LedgerSplitEditor({
  draft,
  hasChanges,
  categories,
  columnCount,
  categoryColumnIndex,
  separateAmountColumns,
  disabled,
  recoveryDisabled,
  onChange,
  onCancel,
  onSave,
  onRefreshUnknown,
  onReloadSaved,
  onDiscardUncertain,
  onUnsplitDraft,
  onRecoveryReloadingChange,
  onRecoveryStateChange,
}: {
  draft: SplitDraft
  hasChanges: boolean
  categories: CategoryTree[]
  columnCount: number
  categoryColumnIndex: number
  separateAmountColumns: boolean
  disabled: boolean
  recoveryDisabled: boolean
  onChange: (draft: SplitDraft) => void
  onCancel: () => void
  onSave: (categorization: TransactionCategorization, expectedToken: string) => Promise<void>
  onRefreshUnknown: () => Promise<LedgerRow | null>
  onReloadSaved: (row: LedgerRow) => Promise<void>
  onDiscardUncertain: () => void
  onUnsplitDraft: (categoryId: number | null) => void
  onRecoveryReloadingChange: (reloading: boolean) => void
  onRecoveryStateChange: (active: boolean) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [appendFocusKey, setAppendFocusKey] = useState<string | null>(null)
  const [outcomeUnknown, setOutcomeUnknown] = useState(false)
  const [requiresReload, setRequiresReload] = useState(false)
  const [inspection, setInspection] = useState<LedgerRow | null | undefined>(undefined)
  const [reloading, setReloading] = useState(false)
  const firstAmountRef = useRef<HTMLInputElement>(null)
  const parentCents = parseLedgerAmount(draft.parentAmount)
  const parsed = draft.allocations.map((allocation, index) => ({ allocation, index, cents: parseLedgerAmount(allocation.amount) }))
  const ordinary = parsed.filter(({ allocation }) => !allocation.unassigned)
  const allocated = parsed.reduce((sum, item) => sum + (item.cents ?? 0), 0)
  const remaining = parentCents === null ? null : parentCents - allocated
  const meaningful = parsed.filter(({ cents }) => cents !== null && cents !== 0)
  const frozen = disabled || reloading || outcomeUnknown || requiresReload

  useEffect(() => {
    onRecoveryStateChange(outcomeUnknown || requiresReload)
    return () => onRecoveryStateChange(false)
  }, [onRecoveryStateChange, outcomeUnknown, requiresReload])

  const allocationError = (lines: typeof parsed) => {
    const amountProblem = lines.find(({ cents }) => cents === null || cents === 0)
    if (amountProblem) {
      const row = amountProblem.index + 1
      if (!amountProblem.allocation.amount.trim()) return `Enter an amount for split ${row}.`
      if (amountProblem.cents === 0) return `The amount for split ${row} must not be zero.`
      return `Enter a valid amount with no more than two decimal places for split ${row}.`
    }
    const categoryProblem = lines.find(({ allocation }) => !allocation.categoryTouched)
    return categoryProblem ? `Choose a category or explicitly select No category for split ${categoryProblem.index + 1}.` : null
  }

  const firstCategoryId = draft.allocations[0]?.categoryId
  useEffect(() => {
    if (firstCategoryId !== null && firstCategoryId !== undefined) queueMicrotask(() => firstAmountRef.current?.focus())
  }, [firstCategoryId])

  const update = (patch: Partial<SplitDraft>) => {
    if (disabled || outcomeUnknown || requiresReload) return
    onChange({ ...draft, ...patch })
    setError(null)
  }
  const updateAllocation = (key: string, patch: Partial<SplitAllocationDraft>) => update({
    allocations: draft.allocations.map((allocation) => allocation.key === key ? { ...allocation, ...patch } : allocation),
  })
  const normalizeAllocationAmount = (key: string, amount: string, value: number | null) => {
    if (value === null || !amount.trim()) return
    const negative = /^[-−]/.test(amount.replace(/[$,\s]/g, ''))
    const normalized = `${negative ? '−' : ''}${splitAmountText(Math.abs(value))}`
    if (normalized !== amount) updateAllocation(key, { amount: normalized })
  }
  const add = () => {
    const key = `new-${crypto.randomUUID()}`
    setAppendFocusKey(key)
    update({ allocations: [...draft.allocations, { key, categoryId: null, categoryTouched: false, memo: '', amount: '', unassigned: false }] })
  }
  const remove = (key: string) => update({ allocations: draft.allocations.filter((allocation) => allocation.key !== key) })
  const remainderFor = (key: string) => parentCents === null ? null : parentCents - parsed.filter((item) => item.allocation.key !== key).reduce((sum, item) => sum + (item.cents ?? 0), 0)
  const fillRemaining = (key: string) => {
    const remainder = remainderFor(key)
    if (remainder !== null) updateAllocation(key, { amount: splitAmountText(remainder) })
  }
  const saveFailure = (caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 409) { setRequiresReload(true); setError('The transaction changed. Reload it before saving this split.') }
    else if (!(caught instanceof ApiError) || caught.status >= 500 || caught.code === 'unknown_error') { setOutcomeUnknown(true); setError('Save outcome unknown. Refresh and inspect before trying again.') } else setError(caught instanceof ApiError ? caught.message : 'The split could not be saved.')
  }
  const unsplit = async () => {
    if (frozen) return
    const first = draft.allocations[0]
    const categoryId = first && !first.unassigned && first.categoryTouched ? first.categoryId : null
    if (!draft.allocations.some((allocation) => allocation.id != null)) { onUnsplitDraft(categoryId); return }
    try { await onSave({ kind: 'single', category_id: categoryId }, draft.originalToken) } catch (caught) { saveFailure(caught) }
  }
  const distribute = () => {
    if (parentCents === null) return
    const validationError = allocationError(ordinary)
    if (validationError) { setError(validationError); return }
    const source = ordinary
    if (source.length === 0) return
    const sign = Math.sign(source[0].cents!)
    if (!source.every(({ cents }) => Math.sign(cents!) === sign)) { setError('Auto-distribute requires ordinary lines with one shared sign.'); return }
    const weight = source.reduce((sum, item) => sum + Math.abs(item.cents!), 0)
    const unallocated = parentCents - source.reduce((sum, item) => sum + item.cents!, 0)
    if (unallocated === 0) return
    const raw = source.map((item, index) => ({ index, cents: item.cents!, share: unallocated * Math.abs(item.cents!) / weight }))
    const rounded = raw.map((item) => ({ ...item, delta: item.share < 0 ? Math.ceil(item.share) : Math.floor(item.share) }))
    let extra = unallocated - rounded.reduce((sum, item) => sum + item.delta, 0)
    for (const item of [...rounded].sort((a, b) => Math.abs(b.share - b.delta) - Math.abs(a.share - a.delta) || a.index - b.index)) {
      if (!extra) break
      const increment = extra > 0 ? 1 : -1
      item.delta += increment
      extra -= increment
    }
    if (rounded.some((item) => item.cents + item.delta === 0 || Math.sign(item.cents + item.delta) !== sign)) { setError('That distribution would create a zero or reverse-sign allocation.'); return }
    update({ allocations: draft.allocations.filter((allocation) => !allocation.unassigned).map((allocation) => {
      const item = rounded.find((candidate) => source[candidate.index].allocation.key === allocation.key)
      return item ? { ...allocation, amount: splitAmountText(item.cents + item.delta) } : allocation
    }) })
  }
  const submit = async () => {
    if (frozen || !hasChanges) return
    if (parentCents === null) { setError('Enter a valid parent amount with no more than two decimal places.'); return }
    const validationError = allocationError(ordinary.filter(({ allocation }) => allocation.categoryTouched || allocation.memo.trim() || allocation.amount.trim()))
    if (validationError) { setError(validationError); return }
    if (meaningful.length < 2) { setError('A split needs at least two nonzero allocations.'); return }
    if (remaining !== 0) { setError('Allocation amounts must equal the parent amount exactly.'); return }
    const allocations = parsed.filter(({ allocation }) => allocation.unassigned || allocation.amount.trim() !== '').map(({ allocation, cents }) => ({ id: allocation.id, category_id: allocation.categoryId, memo: allocation.memo, amount_cents: cents!, ...(allocation.unassigned ? { unassigned: true } : {}) }))
    try { await onSave({ kind: 'split', allocations }, draft.originalToken) } catch (caught) { saveFailure(caught) }
  }
  const spacer = categoryColumnIndex
  return <>
    {draft.allocations.map((allocation, index) => {
      const remainder = allocation.unassigned ? null : remainderFor(allocation.key)
      const cents = parseLedgerAmount(allocation.amount)
      const onAmountBlur = () => normalizeAllocationAmount(allocation.key, allocation.amount, cents)
      const onAmountKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter') event.preventDefault() }
      return <tr className={`bp-split-allocation${allocation.unassigned ? ' is-unassigned' : ''}`} key={allocation.key} tabIndex={-1} data-ledger-edit-session={`split-${draft.rowId}`} data-split-line={index} onKeyDownCapture={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter' && event.repeat) { event.preventDefault(); event.stopPropagation() } }} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); document.querySelector<HTMLButtonElement>(`[data-split-save="${draft.rowId}"]`)?.click() } }}>
        <td colSpan={spacer} aria-hidden="true" />
        <td className="bp-split-category" data-column="category"><div className="bp-split-line"><span className="bp-split-connector">{index === draft.allocations.length - 1 ? '└' : '├'}</span><LedgerCategoryPicker onAdvance={focusNextLedgerCell} ariaLabel="Allocation category" sessionId={`split-${draft.rowId}`} value={allocation.categoryId} categories={categories} disabled={disabled} emptyLabel={allocation.unassigned ? 'Unassigned split' : allocation.categoryTouched ? 'No category' : 'Choose category'} autoFocus={(index === 0 && allocation.categoryId === null && !allocation.categoryTouched) || appendFocusKey === allocation.key} onChange={(categoryId) => updateAllocation(allocation.key, { categoryId, categoryTouched: true, unassigned: false })} /></div></td>
        <td data-column="memo"><input className="bp-cell-input" aria-label="Allocation memo" value={allocation.memo} disabled={disabled} placeholder="Memo" onChange={(event) => updateAllocation(allocation.key, { memo: event.target.value })} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter') event.preventDefault() }} /></td>
        {separateAmountColumns ? <>
          <td data-column="outflow"><LedgerDirectionalAmountInput ref={index === 0 ? firstAmountRef : undefined} aria-label="Allocation outflow" value={allocation.amount} direction="outflow" disabled={disabled} onChange={(amount) => updateAllocation(allocation.key, { amount })} onBlur={onAmountBlur} onKeyDown={onAmountKeyDown} /></td>
          <td data-column="inflow"><LedgerDirectionalAmountInput aria-label="Allocation inflow" value={allocation.amount} direction="inflow" disabled={disabled} onChange={(amount) => updateAllocation(allocation.key, { amount })} onBlur={onAmountBlur} onKeyDown={onAmountKeyDown} /></td>
        </> : <td data-column="amount_cents"><input ref={index === 0 ? firstAmountRef : undefined} className={`bp-cell-input bp-amount-input${(cents ?? 0) < 0 ? ' is-negative' : ''}`} aria-label="Allocation amount" value={allocation.amount} disabled={disabled} inputMode="decimal" placeholder="0.00" onChange={(event) => { const amount = amountInputText(event.target.value); if (amount !== null) updateAllocation(allocation.key, { amount }) }} onBlur={() => { if (cents !== null && allocation.amount.trim() !== '' && splitAmountText(cents) !== allocation.amount) updateAllocation(allocation.key, { amount: splitAmountText(cents) }) }} onKeyDown={(event) => { if (isComposingKey(event.nativeEvent)) return; if (event.key === 'Enter') event.preventDefault() }} /></td>}
        <td className="bp-split-remove-cell" colSpan={Math.max(1, columnCount - spacer - (separateAmountColumns ? 4 : 3))}><span className="bp-split-row-actions">{!allocation.unassigned && <Button size="sm" title="Set this line to the unallocated amount" disabled={frozen || remainder === null || remainder === cents} onClick={() => fillRemaining(allocation.key)}><DollarSign aria-hidden="true" />Remainder</Button>}<Button size="sm" variant="danger" iconOnly title="Remove allocation" aria-label="Remove allocation" disabled={frozen} onClick={() => remove(allocation.key)}><Trash2 aria-hidden="true" /></Button></span></td>
      </tr>
    })}
    <tr className="bp-split-footer" tabIndex={-1} data-ledger-edit-session={`split-${draft.rowId}`}><td className="bp-split-feedback" colSpan={spacer}>{error && <span className="bp-split-error" role="alert">{error}</span>}{inspection !== undefined && <span className="bp-split-inspection">{inspection ? <>Saved: {splitAmountText(inspection.amount_cents)} · {inspection.allocations.length ? inspection.allocations.map((allocation) => `${allocation.category_name ?? (allocation.unassigned ? 'Unassigned split' : 'No category')} ${splitAmountText(allocation.amount_cents)}`).join(', ') : inspection.category_name ? inspection.subcategory_name ? `${inspection.category_name}: ${inspection.subcategory_name}` : inspection.category_name : 'No category'}</> : 'Register refreshed. Inspect the saved transaction, then discard this uncertain draft.'}</span>}</td><td className="bp-split-footer-cell" colSpan={columnCount - spacer}><div className="bp-split-footer-content"><Button size="sm" disabled={frozen} onClick={add}><Plus aria-hidden="true" />Add split</Button><Button size="sm" disabled={frozen || remaining === null || remaining === 0 || ordinary.length === 0} onClick={distribute}><Scale aria-hidden="true" />Auto-distribute</Button><span className="bp-button-group bp-split-actions">{remaining !== null && remaining !== 0 && <span className="bp-split-state" role="status">{splitAmountText(remaining)} remaining</span>}{(outcomeUnknown || requiresReload) && inspection === undefined && <Button size="sm" disabled={recoveryDisabled || reloading} onClick={() => void onRefreshUnknown().then((current) => { setInspection(current); setError(current ? 'Saved transaction loaded for comparison.' : 'Register refreshed. The create outcome remains uncertain.') }).catch(() => setError('Refresh failed. Try refresh again before choosing an outcome.'))}>Refresh</Button>}{inspection && <Button size="sm" disabled={recoveryDisabled || reloading} onClick={() => { setReloading(true); onRecoveryReloadingChange(true); void onReloadSaved(inspection).then(() => { setOutcomeUnknown(false); setRequiresReload(false); setInspection(undefined); setError(null) }).catch(() => setError('Reload failed. Try Reload saved version again or cancel.')).finally(() => { setReloading(false); onRecoveryReloadingChange(false) }) }}>Reload saved version</Button>}{inspection !== undefined && <Button size="sm" disabled={recoveryDisabled || reloading} onClick={onDiscardUncertain}>Discard uncertain draft</Button>}<Button size="sm" title="Remove every split line and keep the first line's category" disabled={frozen} onClick={() => void unsplit()}><Merge aria-hidden="true" />Un-split</Button><Button data-split-save={draft.rowId} size="sm" variant="primary" title={disabled ? 'Saving…' : 'Save (Cmd/Ctrl+Enter)'} aria-label="Save split" disabled={frozen || !hasChanges} onClick={() => void submit()}><Save aria-hidden="true" />Save</Button><Button size="sm" title="Cancel" aria-label="Cancel split editing" disabled={disabled || reloading} onClick={onCancel}><X aria-hidden="true" />Cancel</Button></span></div></td></tr>
  </>
}

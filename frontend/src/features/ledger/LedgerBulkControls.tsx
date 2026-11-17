import type { HTMLAttributes, ReactNode } from 'react'
import { X } from 'lucide-react'
import type { CategoryTree, LedgerBulkChanges } from '../../api/types'
import { Button } from '../../components/Button'
import { LedgerCategoryPicker, LedgerOptionPicker } from './LedgerEditors'
import type { ledgerPayeeOptions } from './payeeCategory'

export const STAGED_CHANGES_NOTICE = 'Save or cancel the staged changes first.'
type MetadataChanges = Pick<LedgerBulkChanges, 'payee_id' | 'category_id' | 'memo'>
type MetadataField = keyof MetadataChanges

export function LedgerBulkControls({ count, totalCount, label, children, className, ...props }: HTMLAttributes<HTMLDivElement> & {
  count: number
  totalCount: number
  label: string
}) {
  return <div {...props} className={`bp-bulk-toolbar${className ? ` ${className}` : ''}`} role="region" aria-label={label}>
    <div className="bp-bulk-count"><strong>{count} selected of {totalCount}</strong></div>
    {children}
  </div>
}

export function BulkResetButton({ label, staged, disabled, onReset }: { label: string; staged: boolean; disabled: boolean; onReset: () => void }) {
  return staged && <Button size="md" variant="quiet" iconOnly aria-label={`Reset ${label}`} title={`Reset ${label}`} disabled={disabled} onClick={onReset}><X aria-hidden="true" /></Button>
}

function bulkFieldStaging(changes: object, field: string, label: string, onReset: () => void) {
  return { unchanged: !(field in changes), unchangedLabel: 'Leave unchanged', triggerLabel: label, onReset }
}

export function BulkMetadataFields({ changes, payeeOptions, categories, sessionId, labelPrefix = '', disabled, fieldEligible, payeeCompanion, onPayeeChange, onCategoryChange, onMemoChange, onReset }: {
  changes: MetadataChanges
  payeeOptions: ReturnType<typeof ledgerPayeeOptions>
  categories: CategoryTree[]
  sessionId: string
  labelPrefix?: string
  disabled: boolean
  fieldEligible: (field: MetadataField) => boolean
  payeeCompanion?: ReactNode
  onPayeeChange: (value: number) => void
  onCategoryChange: (value: number | null) => void
  onMemoChange: (value: string) => void
  onReset: (field: MetadataField) => void
}) {
  const reset = (field: MetadataField, label: string) => <BulkResetButton label={`${labelPrefix}${label.toLowerCase()}`} staged={field in changes} disabled={disabled} onReset={() => onReset(field)} />
  return <>
    <span className="bp-bulk-field is-payee">
      <LedgerOptionPicker ariaLabel={`Bulk ${labelPrefix}payee`} sessionId={sessionId} value={changes.payee_id ?? null} options={payeeOptions} emptyLabel="Choose payee" allowEmpty={false} disabled={disabled || !fieldEligible('payee_id')} staging={bulkFieldStaging(changes, 'payee_id', 'Payee', () => onReset('payee_id'))} onChange={(value) => { if (value !== null) onPayeeChange(value) }} />
      {payeeCompanion}
      {reset('payee_id', 'Payee')}
    </span>
    <span className="bp-bulk-field is-category">
      <LedgerCategoryPicker ariaLabel={`Bulk ${labelPrefix}category`} sessionId={sessionId} value={changes.category_id ?? null} categories={categories} disabled={disabled || !fieldEligible('category_id')} staging={bulkFieldStaging(changes, 'category_id', 'Category', () => onReset('category_id'))} onChange={onCategoryChange} />
      {reset('category_id', 'Category')}
    </span>
    <span className="bp-bulk-memo">
      <input aria-label={`Replacement ${labelPrefix}memo`} disabled={disabled || !fieldEligible('memo')} value={changes.memo ?? ''} placeholder="Memo…" title="Empty leaves memos unchanged; text replaces every selected memo" onChange={(event) => event.target.value === '' ? onReset('memo') : onMemoChange(event.target.value)} />
    </span>
  </>
}

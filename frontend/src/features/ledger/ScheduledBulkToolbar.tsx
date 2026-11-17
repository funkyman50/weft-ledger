import { useEffect, useRef, useState } from 'react'
import { ArrowUpFromDot, ChevronDown, Save, X } from 'lucide-react'
import type { Account, CategoryTree, Payee, ScheduleBulkChanges, ScheduledTransaction } from '../../api/types'
import { Button } from '../../components/Button'
import { ActionMenu, ActionMenuItem } from '../../components/ActionMenu'
import { isComposingKey } from '../../lib/keyboard'
import { BulkMetadataFields, LedgerBulkControls, STAGED_CHANGES_NOTICE } from './LedgerBulkControls'
import { ledgerPayeeOptions } from './payeeCategory'

export function ScheduledBulkToolbar({ rows, selectableCount, changes, accounts, payees, categories, disabled, cancelDisabled, onChange, onSave, onEnter, onSkip, onSend, onCancel }: {
  rows: ScheduledTransaction[]
  selectableCount: number
  changes: ScheduleBulkChanges
  accounts: Account[]
  payees: Payee[]
  categories: CategoryTree[]
  disabled: boolean
  cancelDisabled: boolean
  onChange: (changes: ScheduleBulkChanges) => void
  onSave: () => void
  onEnter: () => void
  onSkip: () => void
  onSend: (account: Account) => void
  onCancel: () => void
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const staged = Object.keys(changes).length > 0
  const allEdit = rows.length > 0 && rows.every((row) => row.allowed_actions.includes('edit'))
  const actionsBlocked = disabled || staged
  const close = () => { setOpen(false); anchorRef.current?.focus({ preventScroll: true }) }
  useEffect(() => { if (actionsBlocked || !accounts.length) setOpen(false) }, [accounts.length, actionsBlocked])
  const reset = (key: keyof ScheduleBulkChanges) => {
    const next = { ...changes }; delete next[key]; onChange(next)
  }
  const reason = staged ? STAGED_CHANGES_NOTICE : 'Every selected schedule must allow this action.'
  const enterDisabled = actionsBlocked || !rows.length || !rows.every((row) => row.allowed_actions.includes('enter_now'))
  const skipDisabled = actionsBlocked || !rows.length || !rows.every((row) => row.allowed_actions.includes('skip'))
  return <LedgerBulkControls className="is-schedule" count={rows.length} totalCount={selectableCount} label="Selected schedule actions" onKeyDown={(event) => {
    if (isComposingKey(event.nativeEvent)) return
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); event.stopPropagation(); if (!event.repeat && !disabled && staged && allEdit) onSave() }
  }}>
    {rows.length > 1 && <div className="bp-bulk-fields">
      <BulkMetadataFields changes={changes} payeeOptions={ledgerPayeeOptions(payees, changes.payee_id ?? null)} categories={categories} sessionId="schedule-bulk" labelPrefix="schedule " disabled={disabled} fieldEligible={() => allEdit}
        onPayeeChange={(payee_id) => onChange({ ...changes, payee_id })}
        onCategoryChange={(category_id) => onChange({ ...changes, category_id })}
        onMemoChange={(memo) => onChange({ ...changes, memo })}
        onReset={reset}
      />
    </div>}
    <div className="bp-button-group bp-bulk-actions">
      {(rows.length > 1 || staged) && <Button size="md" variant="primary" disabled={disabled || !allEdit || !staged} onClick={onSave}><Save aria-hidden="true" />Save</Button>}
      <Button size="md" disabled={enterDisabled} title={enterDisabled ? reason : undefined} onClick={onEnter}><ArrowUpFromDot aria-hidden="true" />Enter this occurrence</Button>
      <Button size="md" disabled={skipDisabled} title={skipDisabled ? reason : undefined} onClick={onSkip}><ArrowUpFromDot className="bp-icon-flipped" aria-hidden="true" />Skip this occurrence</Button>
      <Button ref={anchorRef} size="md" disabled={actionsBlocked || !accounts.length} title={staged ? reason : !accounts.length ? 'No destination is valid for every selected schedule.' : 'Move unentered occurrences for every selected schedule'} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Send to account<ChevronDown aria-hidden="true" /></Button>
      <Button size="md" disabled={cancelDisabled} onClick={onCancel}><X aria-hidden="true" />Cancel</Button>
    </div>
    {'payee_id' in changes && rows.some((row) => row.pause_reason) && <p className="bp-bulk-message">A valid Payee resumes eligible paused schedules and skips missed dates through today.</p>}
    {open && <ActionMenu anchorRef={anchorRef} menuRef={popupRef} width={220} aria-label="Send selected schedules to account" onDismiss={(reason) => reason === 'outside' ? setOpen(false) : close()}>
      {accounts.map((account) => <ActionMenuItem key={account.id} onClick={() => { close(); onSend(account) }}>{account.name}</ActionMenuItem>)}
    </ActionMenu>}
  </LedgerBulkControls>
}

import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import { PayeeDeletionEffects, PayeeReferenceList, PayeeReferencePagination } from './PayeeReferenceList'
import type { usePayeeManager } from './usePayeeManager'

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

export function PayeeReferencesDialog({ manager: m, onRefresh }: {
  manager: ReturnType<typeof usePayeeManager>
  onRefresh: () => Promise<void>
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const state = m.referencesState!
  const previousMode = useRef(state.mode)
  useLayoutEffect(() => {
    if (previousMode.current === state.mode) return
    previousMode.current = state.mode
    cancelRef.current?.focus()
  }, [state.mode])
  const data = m.references.data
  const source = data?.payee ?? m.payees.find((payee) => payee.id === state.payeeId)
  const name = source?.name ?? 'this payee'
  const replacing = state.mode === 'replace'
  const loading = m.references.isFetching || !data
  const blocked = Boolean(data && (data.displayed_transaction_count || data.schedule_count))
  const destinations = m.payees.filter((payee) => payee.kind === 'ordinary' && payee.id !== state.payeeId)
  const itemCount = data ? data.transaction_count + data.schedule_count : 0
  const followingNames = data && data.offset === 0 && data.next_offset === null
    ? [...new Set(data.groups.flatMap((group) => group.transaction && group.transaction.payee_id !== data.payee.id ? [group.transaction.payee_name] : []))]
    : []
  const categoryName = (id: number | null) => {
    for (const parent of m.categories) {
      const category = parent.children.find((child) => child.id === id)
      if (category) return `${parent.name}: ${category.name}`
    }
    return null
  }
  const preferences = (payee: { default_category_id: number | null; remembered_category_id: number | null }) => [
    payee.default_category_id !== null && `default category ${categoryName(payee.default_category_id) ?? '(unavailable)'}`,
    payee.remembered_category_id !== null && `remembered category ${categoryName(payee.remembered_category_id) ?? '(unavailable)'}`,
  ].filter((item): item is string => Boolean(item))
  const close = () => { if (!m.busy) m.closeReferences() }
  return <Modal size="md" role="alertdialog" labelledBy="payee-references-title" initialFocusRef={cancelRef} onRequestClose={close}>
    <DialogHeader
      titleId="payee-references-title"
      title={replacing ? `Replace ${name}` : `Delete ${name}?`}
      subtitle={replacing ? 'Moves everything that uses this payee to another payee.' : 'Removes this payee from your payee list.'}
      closeDisabled={m.busy}
      onClose={close}
    />
    <div className="bp-dialog-body">
      {replacing && <label className="bp-field">
        Replace with
        <FilterSelect ariaLabel="Replacement payee" autoFocus={false} searchable
          value={state.destinationId === null ? '' : String(state.destinationId)}
          options={[{ value: '', label: 'Choose a payee' }, ...destinations.map((payee) => ({ value: String(payee.id), label: payee.name }))]}
          disabled={m.busy}
          onChange={(value) => m.setReplacementDestination(value ? Number(value) : null)} />
      </label>}
      {m.references.isError ? <div className="bp-callout bp-callout--error" role="alert">
        <p>This payee’s records could not be loaded.</p>
        <Button size="md" disabled={m.busy} onClick={() => void m.references.refetch()}>Retry</Button>
      </div> : loading ? <p className="bp-dialog-copy" role="status">Loading records…</p> : <>
        {!replacing && (blocked ? <div className="bp-callout bp-callout--warning">
          <strong>{name} is still in use</strong>
          {data.displayed_transaction_count > 0 && <p>Shown on {counted(data.displayed_transaction_count, 'transaction')}. Assign them to another payee in Payee transactions.</p>}
          {data.schedule_count > 0 && <p>Used by {counted(data.schedule_count, 'schedule')}. Assign them to another payee in Schedules.</p>}
          <p>Or use Replace payee to move everything at once.</p>
        </div> : <>
          <p className="bp-dialog-copy">{itemCount === 0 && data.rules.length === 0 ? 'Nothing uses this payee.' : 'No transaction or schedule in your ledger shows this payee.'}</p>
          <PayeeDeletionEffects following={data.following_transaction_count} unknown={data.unknown_transaction_count} rules={data.rules}
            followingName={followingNames.length === 1 ? followingNames[0] : null} />
        </>)}
        {replacing && (data.destination ? <div className="bp-callout bp-callout--danger">
          <strong>Everything using {name} will use {data.destination.name}</strong>
          <p>{counted(data.transaction_count, 'transaction record')}{data.schedule_count > 0 && ` and ${counted(data.schedule_count, 'schedule')}`} move to {data.destination.name}, then {name} is removed. Categories, splits, amounts and transfer links don’t change.</p>
          {preferences(data.destination).length > 0 && <p>{data.destination.name} keeps its {preferences(data.destination).join(' and ')}.</p>}
          {preferences(data.payee).length > 0 && <p>{name}’s {preferences(data.payee).join(' and ')} {preferences(data.payee).length === 1 ? 'is' : 'are'} removed.</p>}
          {data.rules.length > 0 && <p>{data.rules.length === 1 ? 'Rule' : 'Rules'} {data.rules.map((rule) => rule.position).join(', ')} will assign {data.destination.name} instead.</p>}
        </div> : <p className="bp-dialog-copy">{counted(data.transaction_count, 'transaction record')}{data.schedule_count > 0 && ` and ${counted(data.schedule_count, 'schedule')}`}{data.rules.length > 0 && ` and ${counted(data.rules.length, 'rule')}`} use {name}. Choose the payee that replaces it.</p>)}
        {itemCount > 0 && <details className="bp-payee-reference-details" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
          <summary>Affected items ({itemCount})</summary>
          <PayeeReferenceList groups={data.groups} sourceId={data.payee.id} replacement={replacing ? data.destination?.name ?? null : undefined} />
          <PayeeReferencePagination total={data.total_groups} offset={data.offset} nextOffset={data.next_offset} disabled={m.busy} onPage={m.setReferencesOffset} />
        </details>}
      </>}
      {(replacing || !blocked) && <p className="bp-note">
        {replacing ? 'This can’t be undone and clears earlier Undo history. A future bank import can bring back the old name unless a rule assigns the new payee.'
          : `This can’t be undone and clears earlier Undo history.${data && data.following_transaction_count > 0 ? ' If a matched transaction is later separated, its records keep the new payee.' : ''}`}
      </p>}
      {m.error && <div className="bp-callout bp-callout--error" role="alert">{m.error}</div>}
      {(m.outcomeUnknown || m.needsRefresh) && <Button size="md" disabled={m.pending} onClick={() => void onRefresh()}>Refresh and inspect</Button>}
    </div>
    <div className="bp-dialog-footer">
      <Button ref={cancelRef} size="lg" disabled={m.busy} onClick={close}>Cancel</Button>
      {!replacing && source?.kind === 'ordinary' && <Button size="lg" disabled={m.busy || destinations.length === 0} onClick={() => m.setReferenceMode('replace')}>Replace payee…</Button>}
      {replacing ? <Button size="lg" variant="danger" busy={m.pending} disabled={m.busy || loading || m.references.isError || !data?.destination || data.destination.id !== state.destinationId} onClick={m.confirmReplacement}>{m.pending ? 'Replacing…' : 'Replace and remove payee'}</Button>
        : <Button size="lg" variant="danger" busy={m.pending} disabled={m.busy || loading || m.references.isError || blocked} onClick={m.confirmDelete}>{m.pending ? 'Deleting…' : 'Delete payee'}</Button>}
    </div>
  </Modal>
}

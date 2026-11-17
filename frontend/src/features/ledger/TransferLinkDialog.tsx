import { useState } from 'react'
import { Link2, Plus } from 'lucide-react'

import type { CategoryTree, ComparisonRowEdits, Payee, TransferCandidate, TransferContext } from '../../api/types'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { DialogHeader } from '../../components/DialogHeader'
import { money } from '../../lib/money'
import { LedgerSourceIcon } from './LedgerSourceIcon'
import { ComparisonMetadataField, ComparisonReadOnlyRow, TransactionComparison } from './TransactionComparison'
import { TransactionCandidateList } from './TransactionCandidateList'
import { categoryLabel, dateLabel, flagDisplay, statusDisplay } from './transactionDisplay'

function sideLabel(cents: number) {
  return cents < 0 ? 'Money out' : 'Money in'
}

type QueueDialog = {
  current: number
  total: number
  saved: number
  skipped: number
  uncertain: number
  inspectionRequired: boolean
  onLink: (candidateId: number, edits: ComparisonRowEdits) => Promise<unknown>
  onSaveUnlinked: () => Promise<unknown>
  onCreate: (edits: ComparisonRowEdits) => Promise<unknown>
  onSkip: () => void
  onExit: () => void
}

type TransferAction = 'save' | 'create' | 'link'

export function TransferLinkDialog({
  payees, categories, context, loading, writing, outcomeUnknown, error: workflowError,
  sourceAccountName, queue, onClose, onChooseCandidate, onChooseDestination,
  onFindNearby, onFindAll, onLoadMore, onRefresh, onLink, onCreate, onSaveUnlinked,
}: {
  payees: Payee[]
  categories: CategoryTree[]
  context: TransferContext | null
  loading: boolean
  writing: boolean
  outcomeUnknown: boolean
  error?: string | null
  sourceAccountName: string
  queue?: QueueDialog | null
  onClose: () => void
  onChooseCandidate: (candidateId: number) => void
  onChooseDestination: (accountId: number) => void
  onFindNearby: () => void
  onFindAll: () => void
  onLoadMore: () => void
  onRefresh: () => void
  onLink: (candidateId: number, edits: ComparisonRowEdits) => Promise<unknown>
  onCreate: (edits: ComparisonRowEdits) => Promise<unknown>
  onSaveUnlinked: () => Promise<unknown>
}) {
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<TransferAction | null>(null)
  const [choosingDestination, setChoosingDestination] = useState(false)
  const [newCounterpart, setNewCounterpart] = useState(false)
  const [draft, setDraft] = useState<{ target: string; edits: ComparisonRowEdits } | null>(null)
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null)
  const busy = loading || writing
  const requiresRefresh = outcomeUnknown || workflowError === 'The transfer changed. Refresh the comparison before confirming again.'
  const locked = requiresRefresh || Boolean(queue?.inspectionRequired)
  const source = context?.source
  const sourceDraft = context?.proposal?.draft ?? context?.draft
  const sourceAmount = sourceDraft?.amount_cents ?? source?.amount_cents ?? 0
  const sourceDate = sourceDraft?.date ?? source?.date ?? ''
  const destinationName = context?.destination?.name ?? 'No counterpart selected'
  const creating = newCounterpart || (!context?.candidate && context?.candidates.length === 0)
  const candidate = creating ? null : context?.candidate
  const displayingTarget = Boolean(context?.destination && (creating || candidate))
  const targetKey = `${context?.destination?.id ?? ''}:${creating ? 'new' : candidate?.id}`
  const edits = draft?.target === targetKey ? draft.edits : {}
  const dirty = Boolean(draft && Object.keys(draft.edits).length > 0)
  const targetPayee = edits.payee_id ?? (creating ? context?.counterpart_payee_id : candidate?.payee_id) ?? null
  const targetCategory = edits.category_id !== undefined ? edits.category_id : candidate?.category_id ?? null
  const targetMemo = edits.memo ?? candidate?.memo ?? ''
  const realPayee = payees.some((payee) => payee.id === targetPayee && (payee.kind === 'ordinary' || payee.kind === 'myself'))
  const valid = creating ? realPayee : !dirty || realPayee
  const canEdit = (field: 'payee_id' | 'category_id' | 'memo') => !busy && !locked && !discardAction && Boolean(context?.destination) && (creating
    ? Boolean(context?.allowed_actions.includes('create_counterpart') && !context.search_all_accounts)
    : Boolean(candidate?.allowed_actions.includes('edit') && candidate.editable_fields.includes(field)))
  const change = (patch: ComparisonRowEdits) => {
    if (creating) setNewCounterpart(true)
    setDraft({ target: targetKey, edits: { ...edits, ...patch } })
  }
  const guard = (action: () => void) => {
    if (dirty) setDiscardAction(() => action)
    else action()
  }
  const leave = () => guard(queue ? queue.onExit : onClose)
  const run = (action: TransferAction, callback: () => Promise<unknown>) => {
    setError(null)
    setActing(action)
    void callback().catch((caught) => setError(caught instanceof Error ? caught.message : 'The transfer action could not be completed.')).finally(() => setActing(null))
  }
  const create = () => targetPayee && run('create', () => (queue?.onCreate ?? onCreate)({ ...edits, payee_id: targetPayee }))
  const link = () => candidate && run('link', () => (queue?.onLink ?? onLink)(candidate.id, edits))
  const sourcePayee = context?.proposal_payee_name ?? source?.payee_name ?? '—'
  const sourceDescription = source?.description ?? context?.draft?.description ?? ''
  const sourceFlag = sourceDraft ? sourceDraft.flag : source?.flag ?? null
  const metadataField = (field: keyof ComparisonRowEdits, value: number | string | null, label: string) => <ComparisonMetadataField field={field} label={`Counterpart ${label}`} value={value} payees={payees} categories={categories} disabled={!canEdit(field)} onChange={change} />
  const dialogError = error ?? workflowError
  const chooseCandidate = (id: number) => guard(() => { setDraft(null); setNewCounterpart(false); onChooseCandidate(id) })
  const refresh = () => guard(() => { setDraft(null); onRefresh() })
  const suffix = queue ? ' and next' : ''

  return <Modal size="lg" labelledBy="transfer-link-title" loading={!context && loading} onRequestClose={() => { if (discardAction) setDiscardAction(null); else if (queue ? !writing : !busy) leave() }}>
    <DialogHeader titleId="transfer-link-title" title={queue ? `Transfer ${queue.current} of ${queue.total}` : 'Link transfers'} subtitle={context && <>{creating ? 'Review the new manual counterpart. Your edits are saved only when you create it.' : candidate ? 'Review and edit the selected counterpart before linking.' : 'Choose a transaction below, or choose New counterpart.'} {context.destination?.closed && `${destinationName} is closed; transfer history remains available.`}</>} onClose={leave} closeDisabled={Boolean(discardAction) || (queue ? writing : busy)} />
    <div className="bp-dialog-body">
      {context ? <>
        {(source || context.draft) && <TransactionComparison ariaLabel="Transfer transaction comparison"
          leftHeading={<><LedgerSourceIcon source={source?.source === 'plaid' ? 'plaid' : 'manual'} /><strong>{sideLabel(sourceAmount)} · {sourceAccountName}</strong></>}
          rightHeading={<><LedgerSourceIcon source={candidate?.source === 'plaid' ? 'plaid' : 'manual'} /><strong>{sideLabel(candidate?.amount_cents ?? -sourceAmount)} · {destinationName}{creating && context.destination ? ' · New counterpart' : ''}</strong></>}>
          <ComparisonReadOnlyRow label="Account" left={sourceAccountName} right={destinationName} />
          <ComparisonReadOnlyRow label="Date" left={dateLabel(sourceDate)} right={candidate ? dateLabel(candidate.date) : displayingTarget ? dateLabel(sourceDate) : '—'} />
          <ComparisonReadOnlyRow label="Transfer" left={context.destination?.name ?? source?.transfer?.account_name ?? 'No transfer'} right={displayingTarget ? sourceAccountName : '—'} proposed={Boolean(context.destination && (source?.transfer_account_id !== context.destination.id || displayingTarget && candidate?.transfer_account_id !== source?.account_id))} />
          <ComparisonReadOnlyRow label="Payee" left={sourcePayee} right={displayingTarget ? metadataField('payee_id', targetPayee, 'Payee') : '—'} />
          <ComparisonReadOnlyRow label="Description" left={sourceDescription || '—'} right={candidate ? candidate.description || '—' : displayingTarget ? `Transfer ${sourceAmount > 0 ? 'to' : 'from'} ${sourceAccountName}` : '—'} />
          <ComparisonReadOnlyRow label="Category" left={context.draft?.category_label ?? (source ? categoryLabel(source, 'No category') : 'No category')} right={displayingTarget ? metadataField('category_id', targetCategory, 'Category') : '—'} />
          <ComparisonReadOnlyRow label="Memo" left={(sourceDraft?.memo ?? source?.memo) || '—'} right={displayingTarget ? metadataField('memo', targetMemo, 'Memo') : '—'} />
          {(sourceFlag || candidate?.flag) && <ComparisonReadOnlyRow label="Flag" left={flagDisplay(sourceFlag)} right={candidate ? flagDisplay(candidate.flag) : '—'} />}
          <ComparisonReadOnlyRow label="Amount" left={money(sourceAmount)} right={candidate ? money(candidate.amount_cents) : displayingTarget ? money(-sourceAmount) : '—'} />
          <ComparisonReadOnlyRow label="Status" left={source ? statusDisplay(source) : 'Uncleared'} right={candidate ? statusDisplay(candidate) : displayingTarget ? 'Uncleared' : '—'} />
        </TransactionComparison>}
        {context.search_all_accounts && choosingDestination && <div role="group" aria-label="Counterpart destination account">
          <p className="bp-dialog-copy"><strong>Choose the counterpart account</strong></p>
          <div className="bp-list">{context.counterpart_destinations.map((destination) => <button type="button" className="bp-list-row" key={destination.id} disabled={busy || locked || Boolean(discardAction)} onClick={() => guard(() => { setDraft(null); setNewCounterpart(true); setChoosingDestination(false); onChooseDestination(destination.id) })}><span>{destination.name}</span><small>{destination.type}</small></button>)}</div>
        </div>}
        {candidate && <p className="bp-note">Link saves your counterpart edits and remembers its Payee for this transfer direction. Edit the starting transaction in the ledger.</p>}
        {!valid && <p className="bp-note">Choose a real counterpart Payee before saving these edits.</p>}
        <TransactionCandidateList candidates={context.candidates} selectedId={candidate?.id ?? null} scope={context.scope} nextCursor={context.next_cursor} loading={busy || locked || Boolean(discardAction)} empty={context.scope === 'all' ? context.search_all_accounts ? 'No eligible transactions were found.' : 'No eligible transactions were found in this account.' : undefined} onNearby={onFindNearby} onAll={onFindAll} onChoose={chooseCandidate} onLoadMore={onLoadMore} detail={(row) => `${(row as TransferCandidate).account_name} · ${categoryLabel(row, 'No category')}${row.transfer ? '' : ' · Transfer target will be assigned'}`} />
      </> : loading ? <p className="bp-dialog-copy" role="status">Loading transfer details…</p> : <div className="bp-callout bp-callout--error" role="alert">{dialogError ?? 'Transfer details could not be loaded.'}</div>}
      {discardAction && <div className="bp-callout bp-callout--warning" role="alert"><p>Discard your unsaved counterpart edits?</p><div className="bp-callout-actions"><Button size="md" onClick={() => setDiscardAction(null)}>Keep editing</Button><Button size="md" variant="danger" onClick={() => { const action = discardAction; setDiscardAction(null); setDraft(null); action() }}>Discard edits</Button></div></div>}
      {outcomeUnknown && <div className="bp-callout bp-callout--error" role="alert">The last write may have succeeded. Refresh and inspect the saved result before another action.</div>}
      {dialogError && context && <div className="bp-callout bp-callout--error" role="alert">{dialogError}</div>}
    </div>
    <div className="bp-dialog-footer">
      {queue && <Button size="lg" disabled={writing || queue.inspectionRequired || Boolean(discardAction)} onClick={() => guard(queue.onSkip)}>Skip</Button>}
      <Button size="lg" disabled={writing || Boolean(discardAction)} onClick={leave}>Cancel</Button>
      {requiresRefresh || queue?.inspectionRequired || !context
        ? <Button size="lg" variant="primary" disabled={busy || Boolean(discardAction)} onClick={refresh}>Refresh transfer details</Button>
        : <>
          {context.allowed_actions.includes('save_unlinked') && <Button size="lg" busy={acting === 'save'} disabled={busy || Boolean(discardAction)} onClick={() => guard(() => run('save', queue?.onSaveUnlinked ?? onSaveUnlinked))}>Save unlinked{suffix}</Button>}
          {!creating && <Button size="lg" disabled={busy || Boolean(discardAction)} onClick={() => guard(() => { setDraft(null); setNewCounterpart(true) })}><Plus aria-hidden="true" />New counterpart…</Button>}
          {creating && (context.search_all_accounts
            ? <Button size="lg" disabled={busy || context.counterpart_destinations.length === 0 || Boolean(discardAction)} onClick={() => setChoosingDestination(!choosingDestination)}>Choose counterpart account…</Button>
            : <Button size="lg" variant="primary" busy={acting === 'create'} disabled={busy || !valid || !context.destination || !context.allowed_actions.includes('create_counterpart') || Boolean(discardAction)} onClick={create}><Plus aria-hidden="true" />Create counterpart{suffix}</Button>)}
          {!creating && <Button size="lg" variant="primary" busy={acting === 'link'} disabled={busy || !valid || !candidate || !context.allowed_actions.includes('link') || Boolean(discardAction)} onClick={link}><Link2 aria-hidden="true" />Link transfer{suffix}</Button>}
        </>}
    </div>
  </Modal>
}

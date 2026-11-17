import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import type { CategoryTree, ComparisonRowEdits, Payee, LedgerRow, MatchContext, MatchFinderContext, MatchSource, PendingLifecycleContext, PendingLifecycleSelections, PendingLifecycleSource, RelationshipAction, TransactionConnectionsContext } from '../../api/types'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { DialogHeader } from '../../components/DialogHeader'
import { money } from '../../lib/money'
import { RelationshipControls, SourceGrid, type SourceColumn, type SourceGridRow } from './BankContinuityDialog'
import { LedgerSourceIcon } from './LedgerSourceIcon'
import { ComparisonChoiceRow, ComparisonMetadataField, ComparisonReadOnlyRow, TransactionComparison } from './TransactionComparison'
import { TransactionCandidateList } from './TransactionCandidateList'
import { categoryLabel, dateLabel, flagDisplay, statusDisplay, valueLabel } from './transactionDisplay'

export type MatchDialogMode = 'suggested' | 'manual' | 'finder' | 'linked'

export interface MatchSelections {
  payee_source: MatchSource
  transfer_source: MatchSource
  description_source: MatchSource
  category_source: MatchSource
  memo_source: MatchSource
  flag_source: MatchSource
}

export interface MatchDialogProps {
  mode: MatchDialogMode
  context: MatchContext
  onClose: () => void
  onMatch?: (selections: MatchSelections) => Promise<void>
  onDismiss?: () => Promise<void>
  onCorrectRelationship: (action: RelationshipAction) => Promise<void>
  finder?: MatchFinderContext
  finderLoading?: boolean
  onFinderScope?: (scope: 'nearby' | 'all') => void
  onFinderCandidate?: (candidateId: number) => void
  onFinderMore?: () => void
}

function sameCategoryBreakdown(left: LedgerRow, right: LedgerRow): boolean {
  if (!left.allocations.length && !right.allocations.length) return left.category_id === right.category_id
  return left.allocations.length === right.allocations.length && left.allocations.every((allocation, index) => {
    const other = right.allocations[index]
    return Boolean(other)
      && allocation.category_id === other.category_id
      && allocation.memo === other.memo
      && allocation.amount_cents === other.amount_cents
      && allocation.unassigned === other.unassigned
  })
}

export function MatchDialog({ mode, context, onClose, onMatch, onDismiss, onCorrectRelationship, finder, finderLoading = false, onFinderScope, onFinderCandidate, onFinderMore }: MatchDialogProps) {
  const [pendingAction, setPendingAction] = useState<'match' | 'dismiss' | null>(null)
  const [correcting, setCorrecting] = useState(false)
  const busy = Boolean(pendingAction) || correcting
  const [error, setError] = useState<string | null>(null)
  const { feed, history } = context
  const layered = feed.source === 'plaid' && (feed.bank_continuity?.associations.length ?? 0) > 0
  const [loadedHistory, setLoadedHistory] = useState<TransactionConnectionsContext | null>(null)
  const [historyFailure, setHistoryFailure] = useState<{ feedId: number; message: string } | null>(null)
  const [historyAttempt, setHistoryAttempt] = useState(0)
  const bankHistory = loadedHistory?.transaction_id === feed.id ? loadedHistory : null
  const historyError = historyFailure?.feedId === feed.id ? historyFailure.message : null
  useEffect(() => {
    if (!layered || bankHistory || historyError) return
    const controller = new AbortController()
    const feedId = feed.id
    apiClient.get<TransactionConnectionsContext>(`/api/transactions/connections/context?transaction_id=${feedId}`, controller.signal)
      .then((loaded) => { if (!controller.signal.aborted) setLoadedHistory(loaded) })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return
        setHistoryFailure({ feedId, message: apiErrorMessage(caught, 'Bank history could not be loaded.') })
      })
    return () => controller.abort()
  }, [bankHistory, feed.id, historyAttempt, historyError, layered])
  const retryHistory = () => {
    setHistoryFailure(null)
    setHistoryAttempt((attempt) => attempt + 1)
  }
  const [selections, setSelections] = useState<MatchSelections>(() => ({
    payee_source: context.selections.payee,
    transfer_source: context.selections.transfer,
    description_source: context.selections.description,
    category_source: context.selections.category,
    memo_source: context.selections.memo,
    flag_source: context.selections.flag,
  }))
  const linked = mode === 'linked'
  const blocked = context.blocking_reason !== null
  const title = linked ? 'Transaction connections' : mode === 'suggested' ? 'Suggested match' : mode === 'finder' ? 'Find match' : 'Match transactions'
  const dialogCopy = linked
    ? 'Records connected to this transaction.'
    : 'Choose which source supplies each editable field. Confirming marks the resulting bank transaction Reviewed. Date, amount, and status always come from Plaid.'

  const runAction = async (action: 'match' | 'dismiss', callback?: () => Promise<void>) => {
    if (!callback || busy) return
    setPendingAction(action)
    setError(null)
    try {
      await callback()
    } catch (caught) {
      setError(caught instanceof ApiError && ['history_expired', 'history_epoch_stale', 'history_recovery_required'].includes(caught.code)
        ? 'Your choices are still here. Try this action again after the register session refreshes.'
        : caught instanceof Error ? caught.message : 'The match action could not be completed.')
    } finally {
      setPendingAction(null)
    }
  }

  const setSource = (field: keyof MatchSelections, source: MatchSource) => {
    setSelections((current) => ({ ...current, [field]: source }))
  }

  const choiceFields: Array<{ key: keyof MatchSelections; label: string; cell: (row: LedgerRow) => ReactNode; differs: boolean }> = [
    { key: 'payee_source', label: 'Payee', cell: (row) => valueLabel(row.payee_name), differs: valueLabel(feed.payee_name) !== valueLabel(history.payee_name) },
    { key: 'transfer_source', label: 'Transfer', cell: (row) => row.transfer?.account_name ?? 'No transfer', differs: feed.transfer_account_id !== history.transfer_account_id },
    { key: 'description_source', label: 'Description', cell: (row) => valueLabel(row.description), differs: valueLabel(feed.description) !== valueLabel(history.description) },
    { key: 'category_source', label: 'Category', cell: (row) => categoryLabel(row), differs: !sameCategoryBreakdown(feed, history) },
    { key: 'memo_source', label: 'Memo', cell: (row) => valueLabel(row.memo), differs: valueLabel(feed.memo) !== valueLabel(history.memo) },
  ]
  if (feed.flag !== null || history.flag !== null || bankHistory?.sources.some((source) => source.flag !== null) || context.transfer?.partner?.flag != null) {
    choiceFields.push({ key: 'flag_source', label: 'Flag', cell: (row) => flagDisplay(row.flag), differs: feed.flag !== history.flag })
  }
  const selectable = new Set(['feed', 'history'])
  const gridRows: SourceGridRow[] = [
    { key: 'date', label: 'Date', cell: (row) => dateLabel(row.date), lockedTo: 'locked to bank' },
    ...choiceFields.map((field): SourceGridRow => {
      const fixed = field.key === 'payee_source'
        ? context.fixed_fields.includes('payee')
        : field.key === 'transfer_source' ? context.fixed_fields.includes('transfer')
          : field.key === 'category_source' && context.fixed_fields.includes('category')
      if (fixed) {
        return { key: field.key, label: field.label, cell: field.cell, lockedTo: `fixed to ${context.selections[field.key === 'payee_source' ? 'payee' : field.key === 'transfer_source' ? 'transfer' : 'category'] === 'feed' ? 'bank' : 'your history'}` }
      }
      return {
        key: field.key, label: field.label, cell: field.cell, differs: field.differs,
        choice: { name: field.key, selectable, selected: selections[field.key], disabled: linked || busy, onChange: (column) => setSource(field.key, column as MatchSource) },
      }
    }),
    { key: 'amount', label: 'Amount', cell: (row) => money(row.amount_cents), lockedTo: 'locked to bank' },
    { key: 'status', label: 'Status', cell: (row, column) => column.key === 'history' ? '' : statusDisplay(row), lockedTo: 'locked to bank' },
  ]
  const columns: SourceColumn[] = [
    { key: 'feed', label: feed.source === 'plaid' ? undefined : 'Bank', row: feed },
    { key: 'history', label: history.source === 'manual' ? 'Manual' : 'Yours', row: history },
  ]
  const relationshipActions = linked
    ? [...(bankHistory?.actions ?? []), ...(context.unmatch_action ? [context.unmatch_action] : []), ...(context.transfer ? [context.transfer.action] : [])]
    : []

  return <Modal size="lg" labelledBy="match-dialog-title" loading={layered && !bankHistory && !historyError} onRequestClose={() => { if (!busy) onClose() }}>
    <DialogHeader titleId="match-dialog-title" title={title} subtitle={dialogCopy} onClose={onClose} closeDisabled={busy} />
    <div className="bp-dialog-body bp-match-body">
      <SourceGrid ariaLabel="Feed and history transaction comparison" columns={columns} rows={gridRows}
        earlier={bankHistory ?? undefined} transfer={context.transfer} endColumn="history" disabled={busy} />
      {layered && !bankHistory && !historyError && <p className="bp-note" role="status">Loading earlier bank records…</p>}
      {layered && historyError && <div className="bp-callout bp-callout--error" role="alert">
        <p>{historyError}</p>
        <div className="bp-callout-actions"><Button size="md" disabled={busy} onClick={retryHistory}>Retry</Button></div>
      </div>}
      {context.transfer?.unavailable_reason && <p className="bp-note">{context.transfer.unavailable_reason}</p>}
      {finder && onFinderScope && onFinderCandidate && onFinderMore && <TransactionCandidateList candidates={finder.candidates} selectedId={finder.candidate?.id ?? null} scope={finder.scope} nextCursor={finder.next_cursor} loading={finderLoading || busy} onNearby={() => onFinderScope('nearby')} onAll={() => onFinderScope('all')} onChoose={onFinderCandidate} onLoadMore={onFinderMore} detail={(row) => `${row.payee_name || row.description || 'No payee'} · ${categoryLabel(row)}`} />}
      {!linked && context.rationale && <div className="bp-callout bp-callout--warning">{context.rationale}</div>}
      {(feed.transfer || history.transfer) && mode === 'suggested' && <p className="bp-note">Possible duplicate: both entries currently count until you accept this bank/history match.</p>}
      {context.blocking_reason && <div className="bp-callout bp-callout--error" role="alert">{context.blocking_reason}</div>}
      {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
      {linked && <RelationshipControls actions={relationshipActions} representative={context.representative} onAction={onCorrectRelationship} disabled={busy} onBusyChange={setCorrecting} />}
    </div>
    <div className="bp-dialog-footer">
      <Button size="lg" onClick={onClose} disabled={busy}>{linked ? 'Close' : 'Cancel'}</Button>
      {mode === 'suggested' && <Button size="lg" busy={pendingAction === 'dismiss'} disabled={busy} onClick={() => void runAction('dismiss', onDismiss)}>{pendingAction === 'dismiss' ? 'Dismissing…' : 'Not a match'}</Button>}
      {!linked && <Button size="lg" variant="primary" busy={pendingAction === 'match'} disabled={busy || blocked} onClick={() => void runAction('match', onMatch ? () => onMatch(selections) : undefined)}>{pendingAction === 'match' ? 'Matching…' : 'Match'}</Button>}
    </div>
  </Modal>
}

type LifecycleDraft = Omit<PendingLifecycleSelections, 'payee_source'> & { payee_source: PendingLifecycleSource | null }
type LifecycleRow = { key: keyof PendingLifecycleSelections; label: string; pending: ReactNode; cleared: ReactNode; differs?: boolean }

export function PendingLifecycleDialog({
  context,
  payees,
  categories,
  onClose,
  onResolve,
  onDisappear,
  onChooseFromLedger,
  onRelationshipAction,
}: {
  context: PendingLifecycleContext
  payees: Payee[]
  categories: CategoryTree[]
  onClose: () => void
  onResolve: (selections: PendingLifecycleSelections, edits: ComparisonRowEdits) => Promise<void>
  onDisappear: () => Promise<void>
  onChooseFromLedger: () => void
  onRelationshipAction?: (relation: PendingLifecycleContext['history_relations'][number]) => Promise<void>
}) {
  const [pendingAction, setPendingAction] = useState<'resolve' | 'disappear' | 'relationship' | null>(null)
  const [confirmingDisappear, setConfirmingDisappear] = useState(false)
  const disappearCancelRef = useRef<HTMLButtonElement>(null)
  const disappearTriggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (confirmingDisappear) disappearCancelRef.current?.focus() }, [confirmingDisappear])
  const cancelDisappear = () => {
    const previousFocus = document.activeElement
    setConfirmingDisappear(false)
    requestAnimationFrame(() => {
      if (document.activeElement === previousFocus || document.activeElement === document.body) disappearTriggerRef.current?.focus({ preventScroll: true })
    })
  }
  const [error, setError] = useState<string | null>(null)
  const [selections, setSelections] = useState<LifecycleDraft>(() => ({
    payee_source: context.selections.payee,
    transfer_source: context.selections.transfer,
    category_source: context.selections.category,
    memo_source: context.selections.memo,
    flag_source: context.selections.flag,
  }))
  const { pending, cleared } = context
  const hasSplit = Boolean(pending.allocations.length || cleared?.allocations.length)
  const [edits, setEdits] = useState<ComparisonRowEdits>({})
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null)
  const guard = (action: () => void) => {
    if (Object.keys(edits).length) setDiscardAction(() => action)
    else action()
  }
  const fieldKey = (key: keyof PendingLifecycleSelections): keyof ComparisonRowEdits | null => key === 'payee_source' ? 'payee_id' : key === 'category_source' ? 'category_id' : key === 'memo_source' ? 'memo' : null
  const change = (patch: ComparisonRowEdits) => {
    setEdits((current) => ({ ...current, ...patch }))
    const field = 'payee_id' in patch ? 'payee_source' : 'category_id' in patch ? 'category_source' : 'memo_source'
    setSelections((current) => ({ ...current, [field]: 'cleared' }))
  }
  const targetEditor = (key: keyof PendingLifecycleSelections, fallback: ReactNode) => {
    const field = fieldKey(key)
    if (!cleared || !field || (field === 'category_id' && hasSplit)) return fallback
    return <ComparisonMetadataField field={field} label={`Cleared ${field === 'payee_id' ? 'Payee' : field === 'category_id' ? 'Category' : 'Memo'}`} value={edits[field] !== undefined ? edits[field]! : cleared[field]} payees={payees} categories={categories} disabled={Boolean(pendingAction) || Boolean(discardAction) || !cleared.allowed_actions.includes('edit') || !cleared.editable_fields.includes(field)} onChange={change} />
  }
  const run = async (action: 'resolve' | 'disappear' | 'relationship', callback: () => Promise<void>) => {
    if (pendingAction) return
    setPendingAction(action)
    setError(null)
    try {
      await callback()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The pending lifecycle action could not be completed.')
    } finally {
      setPendingAction(null)
    }
  }
  const choose = (field: keyof PendingLifecycleSelections, source: PendingLifecycleSource) => {
    setSelections((current) => ({ ...current, [field]: source }))
    const key = fieldKey(field)
    if (source === 'pending' && key) setEdits((current) => { const next = { ...current }; delete next[key]; return next })
  }
  const rows: LifecycleRow[] = cleared ? [
    { key: 'payee_source', label: 'Payee', pending: valueLabel(pending.payee_name), cleared: valueLabel(cleared.payee_name) },
    { key: 'transfer_source', label: 'Transfer', pending: pending.transfer?.account_name ?? 'No transfer', cleared: cleared.transfer?.account_name ?? 'No transfer', differs: pending.transfer_account_id !== cleared.transfer_account_id },
    { key: 'category_source', label: 'Category', pending: categoryLabel(pending), cleared: categoryLabel(cleared), differs: !sameCategoryBreakdown(pending, cleared) },
    { key: 'memo_source', label: 'Memo', pending: valueLabel(pending.memo), cleared: valueLabel(cleared.memo) },
    { key: 'flag_source', label: 'Flag', pending: flagDisplay(pending.flag), cleared: flagDisplay(cleared.flag), differs: pending.flag !== cleared.flag },
  ] : []
  return <Modal size="lg" labelledBy="pending-lifecycle-title" onRequestClose={() => { if (discardAction) setDiscardAction(null); else if (!pendingAction) guard(onClose) }}>
    <DialogHeader titleId="pending-lifecycle-title" title="Resolve pending transaction" subtitle={cleared ? 'Choose which row supplies editable fields. Confirming resolves the pending transaction and marks the resulting transaction Reviewed. Cleared Plaid details replace the missing pending row.' : 'Choose the cleared transaction that replaces this pending row, or remove it.'} onClose={() => guard(onClose)} closeDisabled={Boolean(pendingAction) || Boolean(discardAction)} />
    <div className="bp-dialog-body">
      {cleared ? <>
        <TransactionComparison ariaLabel="Pending and cleared transaction comparison" leftHeading={<><LedgerSourceIcon source="plaid" /><strong>Pending</strong></>} rightHeading={<><LedgerSourceIcon source="plaid" /><strong>Cleared</strong></>}>
          <ComparisonReadOnlyRow label="Date" left={dateLabel(pending.date)} right={dateLabel(cleared.date)} lockedTo="locked to Cleared" />
          {rows.map((row) => {
            const fixed = row.key === 'payee_source'
              ? context.fixed_fields.includes('payee')
              : row.key === 'transfer_source' ? context.fixed_fields.includes('transfer')
                : row.key === 'category_source' && context.fixed_fields.includes('category')
            if (fixed) {
              const fixedSource = context.selections[row.key === 'payee_source' ? 'payee' : row.key === 'transfer_source' ? 'transfer' : 'category'] ?? 'pending'
              return <ComparisonReadOnlyRow key={row.key} label={row.label} left={row.pending} right={row.cleared} lockedTo={`fixed to ${fixedSource === 'pending' ? 'Pending' : 'Cleared'}`} />
            }
            return <ComparisonChoiceRow<PendingLifecycleSource> key={row.key} label={row.label}
              left={{ source: 'pending', name: 'Pending', content: row.pending }} right={{ source: 'cleared', name: 'Cleared', content: targetEditor(row.key, row.cleared) }} rightEditable={Boolean(fieldKey(row.key)) && !(row.key === 'category_source' && hasSplit)}
              selected={selections[row.key]} onChange={(source) => choose(row.key, source)} differs={row.differs} disabled={Boolean(pendingAction) || Boolean(discardAction)} />
          })}
          <ComparisonReadOnlyRow label="Description" left={valueLabel(pending.rule_description ?? pending.description)} right={valueLabel(cleared.rule_description ?? cleared.description)} lockedTo="locked to Cleared" />
          <ComparisonReadOnlyRow label="Amount" left={money(pending.amount_cents)} right={money(cleared.amount_cents)} lockedTo="locked to Cleared" />
          <ComparisonReadOnlyRow label="Status" left={statusDisplay(pending)} right={statusDisplay(cleared)} lockedTo="locked to Cleared" />
        </TransactionComparison>
        {context.rationale && <div className="bp-callout bp-callout--warning">{context.rationale}</div>}
      </> : <p className="bp-dialog-copy">No likely cleared transaction was found.</p>}
      {context.history_relations.map((relation) => <p className="bp-note" key={relation.id}>{relation.feed_transaction_id === pending.id ? 'Pending' : 'Cleared'} row has a {relation.state} history relationship. <Button size="sm" variant="quiet" disabled={Boolean(pendingAction)} onClick={() => guard(() => { void run('relationship', () => onRelationshipAction ? onRelationshipAction(relation) : Promise.resolve()) })}>{relation.state === 'matched' ? 'Unmatch history transaction' : 'Dismiss suggestion'}</Button></p>)}
      {confirmingDisappear && <div className="bp-callout bp-callout--danger">
        <strong>Remove this pending transaction?</strong>
        <p>{context.disappearance_message}</p>
        <div className="bp-callout-actions">
          <Button ref={disappearCancelRef} size="md" disabled={Boolean(pendingAction)} onClick={cancelDisappear}>Cancel</Button>
          <Button size="md" variant="danger" busy={pendingAction === 'disappear'} disabled={Boolean(pendingAction)} onClick={() => void run('disappear', onDisappear)}>{pendingAction === 'disappear' ? 'Removing…' : 'Remove'}</Button>
        </div>
      </div>}
      {discardAction && <div className="bp-callout bp-callout--warning" role="alert"><p>Discard your unsaved cleared-transaction edits?</p><div className="bp-callout-actions"><Button size="md" onClick={() => setDiscardAction(null)}>Keep editing</Button><Button size="md" variant="danger" onClick={() => { const action = discardAction; setDiscardAction(null); setEdits({}); action() }}>Discard edits</Button></div></div>}
      {cleared && <p className="bp-callout bp-callout--warning">Resolving this transaction and saving these edits cannot be undone. This ends the page’s earlier Undo history.</p>}
      {context.blocking_reason && <div className="bp-callout bp-callout--error" role="alert">{context.blocking_reason}</div>}
      {error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
    </div>
    <div className="bp-dialog-footer">
      <Button size="lg" onClick={() => guard(onClose)} disabled={Boolean(pendingAction) || Boolean(discardAction)}>Cancel</Button>
      <Button ref={disappearTriggerRef} size="lg" disabled={Boolean(pendingAction) || Boolean(discardAction) || confirmingDisappear} onClick={() => guard(() => setConfirmingDisappear(true))}>Charge disappeared</Button>
      {cleared
        ? <Button size="lg" variant="primary" busy={pendingAction === 'resolve'} disabled={Boolean(pendingAction) || Boolean(discardAction) || !selections.payee_source || context.blocking_reason !== null} onClick={() => selections.payee_source && void run('resolve', () => onResolve(selections as PendingLifecycleSelections, edits))}>{pendingAction === 'resolve' ? 'Resolving…' : 'Resolve as cleared'}</Button>
        : <Button size="lg" variant="primary" disabled={Boolean(pendingAction) || context.blocking_reason !== null} onClick={() => guard(onChooseFromLedger)}>Choose from ledger</Button>}
    </div>
  </Modal>
}

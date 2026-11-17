import { MatchDialog, type MatchSelections } from './MatchDialog'
import type { MatchDialogState } from './useMatchWorkflow'
import { Modal } from '../../components/Modal'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { money } from '../../lib/money'
import { TransactionCandidateList } from './TransactionCandidateList'
import { ComparisonReadOnlyRow, TransactionComparison } from './TransactionComparison'
import { LedgerSourceIcon } from './LedgerSourceIcon'
import { categoryLabel, dateLabel } from './transactionDisplay'
import type { RelationshipAction } from '../../api/types'

export function MatchWorkflow({
  dialog, onClose, onMatch, onDismiss, onCorrectRelationship, onFinderScope, onFinderCandidate, onFinderMore,
}: {
  dialog: MatchDialogState
  onClose: () => void
  onMatch: (selections: MatchSelections) => Promise<void>
  onDismiss: () => Promise<void>
  onCorrectRelationship: (action: RelationshipAction) => Promise<void>
  onFinderScope: (scope: 'nearby' | 'all') => void
  onFinderCandidate: (id: number) => void
  onFinderMore: () => void
}) {
  if (!dialog?.context && dialog?.finder) {
    const source = dialog.finder.source
    const feed = source.match_role === 'feed' ? source : null
    const history = source.match_role === 'history' ? source : null
    return <Modal size="lg" labelledBy="match-dialog-title" onRequestClose={onClose}>
      <DialogHeader titleId="match-dialog-title" title="Find match" subtitle="Choose a transaction to preview. Choosing one does not change either transaction." onClose={onClose} />
      <div className="bp-dialog-body">
        <TransactionComparison ariaLabel="Match source preview" leftHeading={<><LedgerSourceIcon source={feed?.source === 'manual' ? 'manual' : 'plaid'} /><strong>Bank</strong></>} rightHeading={<><LedgerSourceIcon source={history?.source === 'plaid' ? 'plaid' : 'manual'} /><strong>Yours</strong></>}>
          <ComparisonReadOnlyRow label="Date" left={feed ? dateLabel(feed.date) : '—'} right={history ? dateLabel(history.date) : '—'} />
          <ComparisonReadOnlyRow label="Description" left={feed?.description || '—'} right={history?.description || '—'} />
          <ComparisonReadOnlyRow label="Amount" left={feed ? money(feed.amount_cents) : '—'} right={history ? money(history.amount_cents) : '—'} />
        </TransactionComparison>
        <TransactionCandidateList candidates={dialog.finder.candidates} selectedId={null} scope={dialog.finder.scope} nextCursor={dialog.finder.next_cursor} loading={Boolean(dialog.finderLoading)} onNearby={() => onFinderScope('nearby')} onAll={() => onFinderScope('all')} onChoose={onFinderCandidate} onLoadMore={onFinderMore} detail={(row) => `${row.payee_name || row.description || 'No payee'} · ${categoryLabel(row)}`} />
      </div>
      <div className="bp-dialog-footer"><Button size="lg" onClick={onClose}>Cancel</Button></div>
    </Modal>
  }
  if (dialog?.context === null) {
    return <Modal size="lg" labelledBy="match-dialog-title" loading onRequestClose={onClose}>
      <DialogHeader titleId="match-dialog-title" title={dialog.mode === 'linked' ? 'Transaction connections' : 'Match transaction'} subtitle={dialog.mode === 'linked' ? 'Loading connected records…' : 'Loading match candidates…'} onClose={onClose} />
      <div className="bp-dialog-body"><p className="bp-dialog-copy">The comparison appears once the candidates load.</p></div>
    </Modal>
  }
  if (!dialog?.context) return null
  return <MatchDialog key={dialog.context.context_token} mode={dialog.mode} context={dialog.context} onClose={onClose} onMatch={dialog.mode === 'linked' ? undefined : onMatch} onDismiss={dialog.mode === 'suggested' ? onDismiss : undefined} onCorrectRelationship={onCorrectRelationship} finder={dialog.finder} finderLoading={dialog.finderLoading} onFinderScope={onFinderScope} onFinderCandidate={onFinderCandidate} onFinderMore={onFinderMore} />
}

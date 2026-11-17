import type { LedgerRow } from '../../api/types'
import { Button } from '../../components/Button'
import { money } from '../../lib/money'

function CandidateScopeButtons({ scope, disabled, onNearby, onAll }: {
  scope: 'nearby' | 'all'
  disabled: boolean
  onNearby: () => void
  onAll: () => void
}) {
  return <div className="bp-candidate-search-actions"><Button size="sm" disabled={disabled || scope === 'nearby'} onClick={onNearby}>Nearby dates</Button><Button size="sm" disabled={disabled || scope === 'all'} onClick={onAll}>All dates</Button></div>
}

export function TransactionCandidateList({
  candidates, selectedId, scope, nextCursor, loading, empty, onNearby, onAll, onChoose, onLoadMore, detail,
}: {
  candidates: LedgerRow[]
  selectedId: number | null
  scope: 'nearby' | 'all'
  nextCursor: string | null
  loading: boolean
  empty?: string
  onNearby: () => void
  onAll: () => void
  onChoose: (id: number) => void
  onLoadMore: () => void
  detail: (row: LedgerRow) => string
}) {
  const emptyMessage = empty ?? (scope === 'nearby' ? 'No eligible transactions were found within seven days. Try All dates.' : 'No eligible transactions were found.')
  return <>
    <CandidateScopeButtons scope={scope} disabled={loading} onNearby={onNearby} onAll={onAll} />
    {candidates.length ? <div className="bp-list bp-list--scroll" role="group" aria-label="Eligible transaction candidates">
      {candidates.map((row) => <button type="button" key={row.id} className={`bp-list-row bp-candidate-row${selectedId === row.id ? ' is-selected' : ''}`} disabled={loading} onClick={() => onChoose(row.id)}><span>{row.date} · {row.description || 'No description'}</span><strong>{money(row.amount_cents)}</strong><small>{detail(row)}{row.match?.state === 'dismissed' ? ' · Previously marked not a match' : ''}</small></button>)}
    </div> : <p className="bp-note">{emptyMessage}</p>}
    {nextCursor && <Button size="sm" disabled={loading} onClick={onLoadMore}>Load more candidates</Button>}
  </>
}

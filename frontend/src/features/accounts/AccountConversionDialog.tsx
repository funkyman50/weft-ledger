import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { usePlaidLink } from 'react-plaid-link'
import { Check, CircleAlert, Clock, Info, Link2, LoaderCircle, Plus } from 'lucide-react'
import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import { invalidateAccountAndTransactionQueries } from '../../api/hooks'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import { money } from '../../lib/money'
import { recordDiagnostic, recordPlaidLinkExit } from '../../lib/diagnostics'
import { LedgerSourceIcon } from '../ledger/LedgerSourceIcon'
import { ComparisonChoiceRow, ComparisonReadOnlyRow, TransactionComparison } from '../ledger/TransactionComparison'
import { categoryLabel, dateLabel, flagDisplay, valueLabel } from '../ledger/transactionDisplay'
import type { Account, LedgerHistoryState, LedgerRow, MatchSource } from '../../api/types'

type ProviderAccount = { id: string; name: string; mask: string; type: string; subtype: string }
type ExistingProviderAccount = { provider_account_id: string; name: string; mask: string | null; type: string | null; subtype: string | null; currency: string | null; current_balance_cents: number | null; mapped_account: { id: number; name: string } | null }
type ExistingItemAccounts = { item_id: number; institution: string; accounts: ExistingProviderAccount[]; missing_mapped_accounts: Array<{ id: number; name: string }> }
type Choices = {
  payee_source: MatchSource
  transfer_source: MatchSource
  description_source: MatchSource
  category_source: MatchSource
  memo_source: MatchSource
  flag_source: MatchSource
}
type BalanceTotals = { cleared_balance_cents: number; uncleared_balance_cents: number; working_balance_cents: number }
type Preview = {
  preview_token: string
  buckets: Record<ReviewBucket, { rows: number; open: number; matched: number }>
  unresolved_count: number
  matched_count: number
  returning_count: number
  returning_ready_count: number
  superseded_skipped_count: number
  pending_candidate_count: number
  pending_candidate_amount_cents: number
  plaid_current_balance_cents: number | null
  currency_code: string | null
  currency_warning: boolean
  balance_fetched_at: string | null
  before: BalanceTotals
  after: BalanceTotals | null
  previous_starting_balance_cents: number | null
  starting_balance_cents: number | null
  history_seam_date: string | null
  history_seam_before_cents: number | null
  history_seam_after_cents: number | null
  can_commit: boolean
}
type Attempt = { id: string; account_id: number; state: 'fetching' | 'review' | 'failed'; error: string | null; institution: string; shared_item_id: number | null; provider_account: { name?: string; official_name?: string; mask?: string; type?: string; subtype?: string }; review_all_new: boolean; review: Preview | null }
type ReviewBucket = 'ready' | 'choice' | 'new' | 'kept' | 'pending'
type ReviewStatus = 'open' | 'blocked' | 'matched' | 'new' | 'pending'
type FeedRow = { id: string; date: string; payee_name: string | null; description: string; amount_cents: number; pending: boolean; memo: string; flag: null; category_name: string | null }
type ReviewFeedRow = FeedRow & { review_bucket: ReviewBucket; review_status: ReviewStatus; matched_history_id: number | null; ready_history_id: number | null; blocking_reason: string | null; extra: boolean }
type ReviewHistoryRow = LedgerRow & { review_bucket: ReviewBucket; matched_feed_id: string | null; extra: boolean }
type Edge = { feed_id: string; history_id: number; returning: boolean; blocking_reason: string | null; fixed_owner: MatchSource | null; decision?: { state: string } | null }
type Page<T> = { rows: T[]; total_count: number; next_cursor: string | null }
type ComparisonValue = { edge: Edge; feed: FeedRow; history: LedgerRow; feed_matched_history_id: number | null; history_matched_feed_id: string | null; choices: Choices; rationale: string }
type Review = { attempt: Attempt; feed: Page<ReviewFeedRow>; history: Page<ReviewHistoryRow>; selected_feed_id: string | null; selected_history_id: number | null; feed_candidate_ids: number[]; history_candidate_ids: string[]; comparison: ComparisonValue | null }
type Stage = 'other' | 'choose' | 'start' | 'existing' | 'fetching' | 'review' | 'outcome'

const compatibleProviderType = (providerType: string | null, accountType: Account['type']) =>
  providerType === 'depository' && (accountType === 'checking' || accountType === 'savings')
  || providerType === 'cash' && accountType === 'cash'
  || providerType === 'credit' && accountType === 'credit'
  || providerType === 'loan' && accountType === 'loan'
const search = (values: Record<string, string | number | null>) => new URLSearchParams(Object.entries(values).flatMap(([key, value]) => value === null || value === '' ? [] : [[key, String(value)]])).toString()
const amountFilterCents = (value: string) => value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100)
const providerContext = (attempt: Attempt) => [
  attempt.institution,
  attempt.provider_account.official_name || attempt.provider_account.name,
  attempt.provider_account.mask ? `••••${attempt.provider_account.mask}` : null,
  attempt.provider_account.subtype || attempt.provider_account.type,
].filter(Boolean).join(' · ')

const BUCKETS: Array<[ReviewBucket, string, string]> = [['ready', 'Ready to match', 'Ready'], ['choice', 'Needs a choice', 'Needs a choice'], ['new', 'New from the bank', 'New'], ['kept', 'Kept from your history', 'Kept'], ['pending', 'Pending at the bank', 'Pending']]
const BUCKET_SHORT = Object.fromEntries(BUCKETS.map(([value, , short]) => [value, short])) as Record<ReviewBucket, string>
const FEED_MARKS: Record<ReviewStatus, { Icon: typeof Link2; label: string }> = {
  open: { Icon: CircleAlert, label: 'Needs a choice' },
  blocked: { Icon: CircleAlert, label: 'Blocked' },
  matched: { Icon: Link2, label: 'Matched' },
  new: { Icon: Plus, label: 'Imports as a new row' },
  pending: { Icon: Clock, label: 'Pending at the bank (optional)' },
}

function FeedMark({ row, onToggle }: { row: ReviewFeedRow; onToggle?: () => void }) {
  const { Icon, label } = FEED_MARKS[row.review_status]
  const title = row.review_status === 'blocked' && row.blocking_reason ? `Blocked: ${row.blocking_reason}` : label
  if (onToggle) {
    const action = row.review_status === 'matched' ? 'Unlink this Ready match' : 'Use this Ready match'
    return <button type="button" className={`bp-account-conversion-mark is-${row.review_status}`} title={`${title}. ${action}.`} aria-label={action} onClick={onToggle}><Icon aria-hidden="true" /></button>
  }
  return <span className={`bp-account-conversion-mark is-${row.review_status}`} role="img" aria-label={title} title={title}><Icon aria-hidden="true" /></span>
}

function Register<T extends ReviewFeedRow | ReviewHistoryRow>({ title, page, highlight, mark, filter, onFilter, date, onDate, amount, onAmount, onSelect, onMore }: {
  title: string
  page: Page<T> | undefined
  highlight: (id: string) => string
  mark: (row: T) => ReactNode
  filter: string
  onFilter: (value: string) => void
  date: string
  onDate: (value: string) => void
  amount: string
  onAmount: (value: string) => void
  onSelect: (id: string | number) => void
  onMore: () => void
}) {
  return <section className="bp-account-conversion-register">
    <header><h3>{title} <span>{page?.total_count ?? 0}</span></h3><input className="bp-control bp-control--sm" value={filter} aria-label={`Search ${title}`} onChange={(event) => onFilter(event.target.value)} placeholder="Search" /><input className="bp-control bp-control--sm" type="date" value={date} aria-label={`Filter ${title} by date`} onChange={(event) => onDate(event.target.value)} /><input className="bp-control bp-control--sm" type="number" step="0.01" value={amount} aria-label={`Filter ${title} by amount`} onChange={(event) => onAmount(event.target.value)} placeholder="Amount" /></header>
    <div className="bp-account-conversion-register-scroll" onScroll={(event) => { const node = event.currentTarget; if (page?.next_cursor && node.scrollHeight - node.clientHeight - node.scrollTop < 120) onMore() }}>
      {page?.rows.map((row) => { const matched = 'review_status' in row ? row.review_status === 'matched' : row.matched_feed_id !== null; return <div className={`bp-account-conversion-row${highlight(String(row.id))}`} key={row.id}><span className="bp-account-conversion-status">{mark(row)}</span><button type="button" onClick={() => onSelect(row.id)}><span>{dateLabel(row.date)}</span><span>{row.extra && <span className="bp-account-conversion-bucket-tag">{matched ? 'matched in' : 'in'} {BUCKET_SHORT[row.review_bucket]}</span>}{row.payee_name || '—'}</span><span>{row.description}</span><strong>{money(row.amount_cents)}</strong></button></div> })}
      {page && !page.rows.length && <div className="bp-empty">No rows in this outcome.</div>}
    </div>
  </section>
}

function PairComparison({ value, selectedSide, pending, onSave }: { value: ComparisonValue | null; selectedSide: 'feed' | 'history' | null; pending: boolean; onSave: (state: 'accepted' | 'separate' | 'unresolved', choices: Choices) => void }) {
  const [choices, setChoices] = useState<Choices | null>(null)
  useEffect(() => setChoices(value?.choices ?? null), [value])
  if (!value || !choices) return <div className="bp-empty">{selectedSide === 'feed' ? 'No history row has the same amount within 7 days, so this bank row imports as a new row.' : selectedSide === 'history' ? 'No bank row has the same amount within 7 days, so this row stays in your history as it is.' : 'Select a row to see its possible matches.'}</div>
  const fields: Array<[keyof Choices, string, string, string]> = [
    ['payee_source', 'Payee', valueLabel(value.feed.payee_name), valueLabel(value.history.payee_name)],
    ['transfer_source', 'Transfer', 'No transfer', value.history.transfer?.account_name ?? 'No transfer'],
    ['description_source', 'Description', valueLabel(value.feed.description), valueLabel(value.history.description)],
    ['category_source', 'Category', value.feed.category_name || '—', categoryLabel(value.history)],
    ['memo_source', 'Memo', '—', valueLabel(value.history.memo)],
  ]
  const isFixedField = (key: keyof Choices) => Boolean(value.edge.fixed_owner && key === 'transfer_source')
  const differingCount = fields.filter(([key, , feed, history]) => !isFixedField(key) && feed !== history).length + Number((value.feed.flag !== null || value.history.flag !== null) && value.feed.flag !== value.history.flag)
  const differenceLabel = `${differingCount} field${differingCount === 1 ? '' : 's'} ${differingCount === 1 ? 'differs' : 'differ'}`
  const blocked = Boolean(value.edge.blocking_reason)
  const returning = value.edge.returning
  const acceptedHere = value.edge.decision?.state === 'accepted'
  const keptSeparately = value.edge.decision?.state === 'separate'
  const feedElsewhere = !acceptedHere && value.feed_matched_history_id !== null
  const historyElsewhere = !acceptedHere && value.history_matched_feed_id !== null
  const note = returning ? value.rationale : acceptedHere ? `Matched. ${value.rationale}` : feedElsewhere ? 'This bank row is already matched to another history row.' : historyElsewhere ? 'This history row is already matched to another bank row.' : keptSeparately ? `Kept separately. ${value.rationale}` : value.rationale
  const actions = returning ? null : acceptedHere
    ? <><Button size="md" disabled={pending} onClick={() => onSave('unresolved', choices)}>Unlink</Button><Button size="md" disabled={pending} onClick={() => onSave('accepted', choices)}>Save field choices</Button></>
    : feedElsewhere || historyElsewhere
      ? <Button size="md" variant="primary" disabled={pending || blocked} onClick={() => onSave('accepted', choices)}>Use this match instead</Button>
      : <>{!keptSeparately && <Button size="md" disabled={pending} onClick={() => onSave('separate', choices)}>Keep separately</Button>}<Button size="md" variant="primary" disabled={pending || blocked} onClick={() => onSave('accepted', choices)}>Use this match</Button></>
  return <section className="bp-account-conversion-comparison">{blocked && !acceptedHere && <div className="bp-callout bp-callout--error" role="alert">{value.edge.blocking_reason}</div>}<div className="bp-account-conversion-comparison-panel"><div className="bp-account-conversion-comparison-tools"><strong>{differenceLabel}</strong><span className={acceptedHere || feedElsewhere || historyElsewhere || keptSeparately ? 'is-info' : undefined}><Info size={12} aria-hidden="true" />{note}</span>{actions}</div><div className="bp-account-conversion-comparison-table"><TransactionComparison ariaLabel="Bank and history comparison" leftHeading={<><LedgerSourceIcon source="plaid" /><strong>Bank</strong></>} rightHeading={<><LedgerSourceIcon source="manual" /><strong>{value.history.source === 'plaid' ? 'Prior bank history' : 'Your history'}</strong></>}>
    <ComparisonReadOnlyRow label="Date" left={dateLabel(value.feed.date)} right={dateLabel(value.history.date)} lockedTo="locked to bank" />
    {fields.map(([key, label, feed, history]) => returning
      ? <ComparisonReadOnlyRow key={key} label={label} left={feed} right={history} lockedTo={key === 'description_source' ? 'bank updates description' : 'kept from your history'} />
      : isFixedField(key)
      ? <ComparisonReadOnlyRow key={key} label={label} left={feed} right={history} lockedTo={`fixed to ${value.edge.fixed_owner === 'feed' ? 'bank' : 'your history'}`} />
      : <ComparisonChoiceRow<MatchSource> key={key} label={label}
          left={{ source: 'feed', name: 'bank', content: feed }} right={{ source: 'history', name: 'history', content: history }}
          selected={choices[key]} onChange={(source) => setChoices({ ...choices, [key]: source })} disabled={pending} />)}
    {(value.feed.flag !== null || value.history.flag !== null) && (returning
      ? <ComparisonReadOnlyRow label="Flag" left={flagDisplay(value.feed.flag)} right={flagDisplay(value.history.flag)} lockedTo="kept from your history" />
      : <ComparisonChoiceRow<MatchSource> label="Flag"
          left={{ source: 'feed', name: 'bank', content: flagDisplay(value.feed.flag) }} right={{ source: 'history', name: 'history', content: flagDisplay(value.history.flag) }}
          selected={choices.flag_source} onChange={(source) => setChoices({ ...choices, flag_source: source })} differs={value.feed.flag !== value.history.flag} disabled={pending} />)}
    <ComparisonReadOnlyRow label="Amount" left={money(value.feed.amount_cents)} right={money(value.history.amount_cents)} lockedTo="locked to bank" />
    <ComparisonReadOnlyRow label="Status" left={value.feed.pending ? 'Pending at bank' : 'Bank cleared'} right={value.history.status} lockedTo="locked to bank" />
  </TransactionComparison></div></div></section>
}

function SidebarBalances({ preview }: { preview: Preview }) {
  const bank = preview.plaid_current_balance_cents
  const fetched = preview.balance_fetched_at ? `${preview.currency_code || 'Currency not reported'} · ${new Date(preview.balance_fetched_at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Fetch time unavailable'
  return <div className="bp-account-conversion-balances">
    <div className="bp-account-conversion-balance-grid"><span /><span>Before</span><span>After</span><span>Cleared</span><span>{money(preview.before.cleared_balance_cents)}</span><strong>{preview.after ? money(preview.after.cleared_balance_cents) : '—'}</strong><span>Uncleared</span><span>{money(preview.before.uncleared_balance_cents)}</span><strong>{preview.after ? money(preview.after.uncleared_balance_cents) : '—'}</strong><span>Working</span><span>{money(preview.before.working_balance_cents)}</span><strong>{preview.after ? money(preview.after.working_balance_cents) : '—'}</strong><span>Starting</span><span>{preview.previous_starting_balance_cents === null ? '—' : money(preview.previous_starting_balance_cents)}</span><strong>{preview.starting_balance_cents === null ? '—' : money(preview.starting_balance_cents)}</strong></div>
    <div className="bp-account-conversion-bank-balance"><div><span>Bank current</span><strong>{bank === null ? 'Unavailable' : money(bank)}</strong></div><div><small>{fetched}</small>{bank !== null && preview.after?.cleared_balance_cents === bank && <span className="bp-account-conversion-balance-match" title="Cleared after connecting equals the bank's current balance"><Check aria-hidden="true" />matches</span>}</div></div>
  </div>
}

export function AccountConversionDialog({ account, accounts, outcomeUnknown, reloadRequired, onClose, onResumeAccount, onOutcomeUnknown, onOutcomeResolved, onInspectHistory }: { account: Account; accounts: Account[]; outcomeUnknown: boolean; reloadRequired: boolean; onClose: () => void; onResumeAccount: (accountId: number) => void; onOutcomeUnknown: () => void; onOutcomeResolved: (connected: boolean) => void; onInspectHistory: () => Promise<LedgerHistoryState & { outcomeResolved: boolean }> }) {
  const queryClient = useQueryClient()
  const otherFocusRef = useRef<HTMLButtonElement>(null)
  const chooseFocusRef = useRef<HTMLButtonElement>(null)
  const startFocusRef = useRef<HTMLButtonElement>(null)
  const fetchingFocusRef = useRef<HTMLButtonElement>(null)
  const reviewFocusRef = useRef<HTMLButtonElement>(null)
  const [configurationIdentity, setConfigurationIdentity] = useState<string | null>(null)
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [linkMode, setLinkMode] = useState<'new' | 'update' | null>(null)
  const [publicToken, setPublicToken] = useState<string | null>(null)
  const [institution, setInstitution] = useState('')
  const [institutionId, setInstitutionId] = useState<string | null>(null)
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[] | null>(null)
  const [providerId, setProviderId] = useState('')
  const [existingItemId, setExistingItemId] = useState<number | null>(null)
  const [acknowledgeLateHistory, setAcknowledgeLateHistory] = useState(false)
  const [acknowledgePendingOverlap, setAcknowledgePendingOverlap] = useState(false)
  const [lostMappings, setLostMappings] = useState<Array<{ id: number; name: string }>>([])
  const [accessRecoveryRequired, setAccessRecoveryRequired] = useState(false)
  const recoveringAccess = useRef(false)
  const [accessRecoveryNeedsRefresh, setAccessRecoveryNeedsRefresh] = useState(false)
  const [bucket, setBucket] = useState<ReviewBucket>('ready')
  const [feedCursor, setFeedCursor] = useState<string | null>(null)
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [feedText, setFeedText] = useState('')
  const [historyText, setHistoryText] = useState('')
  const [feedDate, setFeedDate] = useState('')
  const [historyDate, setHistoryDate] = useState('')
  const [feedAmount, setFeedAmount] = useState('')
  const [historyAmount, setHistoryAmount] = useState('')
  const [feedId, setFeedId] = useState<string | null>(null)
  const [historyId, setHistoryId] = useState<number | null>(null)
  const [anchor, setAnchor] = useState<'feed' | 'history' | null>(null)
  const [firstDownload, setFirstDownload] = useState<'new' | 'existing' | null>(null)
  const [checkingOutcome, setCheckingOutcome] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attemptQuery = useQuery({ queryKey: ['account-conversion'], queryFn: () => apiClient.get<Attempt | null>('/api/account-conversion'), refetchInterval: (query) => query.state.data?.state === 'fetching' ? 3_000 : false })
  const currentAttempt = attemptQuery.data
  useEffect(() => {
    if (currentAttempt?.account_id === account.id && (currentAttempt.state === 'review' || currentAttempt.state === 'failed')) setFirstDownload(null)
  }, [account.id, currentAttempt?.account_id, currentAttempt?.state])
  const existingItems = useMemo(() => {
    const items = new Map<number, { institution: string; accounts: Map<number, string> }>()
    for (const localAccount of accounts) {
      const connection = localAccount.plaid_connection
      if (!connection) continue
      const item = items.get(connection.item_id) ?? { institution: connection.institution, accounts: new Map<number, string>() }
      item.accounts.set(localAccount.id, localAccount.name)
      items.set(connection.item_id, item)
    }
    return [...items.entries()].map(([id, item]) => ({ id, institution: item.institution, accounts: [...item.accounts.entries()].map(([accountId, name]) => ({ id: accountId, name })) }))
      .sort((left, right) => left.institution.localeCompare(right.institution))
  }, [accounts])
  const existingItemPath = existingItemId === null ? '' : `/api/accounts/${account.id}/conversion/existing-items/${existingItemId}/accounts`
  const existingItemQuery = useQuery({ queryKey: ['account-conversion-existing-item', account.id, existingItemId], queryFn: () => apiClient.get<ExistingItemAccounts>(existingItemPath), enabled: Boolean(existingItemPath) })
  useEffect(() => { setProviderId('') }, [existingItemId])
  const reviewPath = useMemo(() => currentAttempt ? `/api/account-conversion/${currentAttempt.id}/review?${search({ bucket, feed_cursor: feedCursor, history_cursor: historyCursor, feed_text: feedText, history_text: historyText, feed_date: feedDate, history_date: historyDate, feed_amount: amountFilterCents(feedAmount), history_amount: amountFilterCents(historyAmount), selected_feed_id: feedId, selected_history_id: historyId })}` : '', [currentAttempt, bucket, feedCursor, historyCursor, feedText, historyText, feedDate, historyDate, feedAmount, historyAmount, feedId, historyId])
  const reviewQuery = useQuery({ queryKey: ['account-conversion-review', reviewPath], queryFn: () => apiClient.get<Review>(reviewPath), placeholderData: keepPreviousData, enabled: Boolean(reviewPath && currentAttempt?.state === 'review' && currentAttempt.account_id === account.id) })
  const attempt = currentAttempt?.state === 'review' && reviewQuery.data?.attempt.id === currentAttempt.id ? reviewQuery.data.attempt : currentAttempt
  const refreshReview = async () => { await reviewQuery.refetch() }
  const start = useMutation({ mutationFn: () => apiClient.providerCommand<{ link_token?: string; configuration_identity?: string; attempt: Attempt | null }>(`/api/accounts/${account.id}/conversion/link-token`), onSuccess: (result) => result.attempt ? void attemptQuery.refetch() : result.link_token && (setConfigurationIdentity(result.configuration_identity ?? null), setLinkMode('new'), setLinkToken(result.link_token)), onError: (caught) => setError(apiErrorMessage(caught, 'Could not start the bank connection.')) })
  const updateAccess = useMutation({ mutationFn: (itemId: number) => apiClient.providerCommand<{ link_token: string }>(`/api/accounts/${account.id}/conversion/existing-items/${itemId}/update-link-token`), onSuccess: (result) => { setLinkMode('update'); setLinkToken(result.link_token); setError(null) }, onError: (caught) => { recoveringAccess.current = false; setError(apiErrorMessage(caught, 'Could not update access to this bank login.')) } })
  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess: (token, metadata) => {
    recordDiagnostic('plaid.link_conversion_succeeded', 'info', { account_count: metadata.accounts.length })
    setLinkToken(null)
    if (linkMode === 'update') {
      const recovering = recoveringAccess.current
      recoveringAccess.current = false
      setLinkMode(null)
      setProviderId('')
      setLostMappings([])
      void existingItemQuery.refetch().then((result) => {
        if (result.isError) setError('Bank access was updated, but Weft could not verify the linked accounts. Refresh this screen before continuing.')
        else if (result.data?.missing_mapped_accounts.length) {
          setLostMappings(result.data.missing_mapped_accounts)
          if (recovering) setAccessRecoveryRequired(true)
          setError(null)
        } else if (recovering) {
          setAccessRecoveryRequired(false)
          setAccessRecoveryNeedsRefresh(true)
          setError('Access is restored. Refresh the staged bank history before trying to connect again.')
        }
      })
      return
    }
    setLinkMode(null)
    setPublicToken(token)
    setInstitution(metadata.institution?.name ?? '')
    setInstitutionId(metadata.institution?.institution_id ?? null)
    setProviderAccounts(metadata.accounts)
    setProviderId(metadata.accounts[0]?.id ?? '')
  }, onExit: (plaidError) => { recordPlaidLinkExit(plaidError); recoveringAccess.current = false; setLinkToken(null); setLinkMode(null); if (plaidError) setError(plaidError.display_message || plaidError.error_message || 'Plaid Link closed with an error.') } })
  useEffect(() => { if (linkToken && ready) open() }, [linkToken, ready, open])
  useEffect(() => { setFeedCursor(null); setHistoryCursor(null); setFeedId(null); setHistoryId(null); setAnchor(null) }, [bucket, feedText, historyText, feedDate, historyDate, feedAmount, historyAmount])
  const exchange = useMutation({ mutationFn: () => apiClient.providerCommand<Attempt>(`/api/accounts/${account.id}/conversion/exchange`, { public_token: publicToken, configuration_identity: configurationIdentity, provider_account_id: providerId, institution, institution_id: institutionId }), onSuccess: async () => { setFirstDownload('new'); setPublicToken(null); await attemptQuery.refetch() }, onError: (caught) => setError(apiErrorMessage(caught, 'Could not stage the connection.')) })
  const stageExisting = useMutation({ mutationFn: () => apiClient.providerCommand<Attempt>(`/api/accounts/${account.id}/conversion/existing-items/${existingItemId}/stage`, { provider_account_id: providerId }), onSuccess: async () => { setFirstDownload('existing'); setLostMappings([]); await attemptQuery.refetch() }, onError: (caught) => setError(apiErrorMessage(caught, 'Could not stage this bank account. Refresh the account list and try again.')) })
  const requestRefresh = useMutation({ mutationFn: () => apiClient.providerCommand(`/api/account-conversion/${attempt!.id}/refresh`), onMutate: () => { setFirstDownload(null); setAcknowledgeLateHistory(false); setAcknowledgePendingOverlap(false) }, onSuccess: async () => { setAccessRecoveryNeedsRefresh(false); await attemptQuery.refetch() }, onError: (caught) => setError(apiErrorMessage(caught, 'Could not request a refresh.')) })
  const readyMatches = useMutation({ mutationFn: (accepted: boolean) => apiClient.post(`/api/account-conversion/${attempt!.id}/ready`, { accepted }), onSuccess: refreshReview })
  const reviewNew = useMutation({ mutationFn: (accepted: boolean) => apiClient.post(`/api/account-conversion/${attempt!.id}/review-new`, { accepted }), onSuccess: refreshReview })
  const decide = useMutation({ mutationFn: ({ state, choices, edge }: { state: 'accepted' | 'separate' | 'unresolved'; choices?: Choices; edge?: Pick<Edge, 'feed_id' | 'history_id'> }) => { const selected = edge || reviewQuery.data!.comparison!.edge; return apiClient.post(`/api/account-conversion/${attempt!.id}/pair`, { feed_id: selected.feed_id, history_id: selected.history_id, state, ...(choices ? { choices } : {}) }) }, onSuccess: refreshReview, onError: (caught) => setError(apiErrorMessage(caught, 'Could not save the decision.')) })
  const commit = useMutation({ mutationFn: () => apiClient.providerCommand(`/api/account-conversion/${attempt!.id}/commit`, { preview_token: attempt!.review!.preview_token, acknowledge_late_history: acknowledgeLateHistory, acknowledge_pending_overlap: acknowledgePendingOverlap }), onSuccess: async () => { await invalidateAccountAndTransactionQueries(queryClient); onClose() }, onError: (caught) => {
    if (caught instanceof ApiError && caught.code === 'conversion_preview_stale') {
      const detail = caught.detail && typeof caught.detail === 'object' ? caught.detail as Record<string, unknown> : {}
      const changes = [
        typeof detail.new_active_bank_row_count === 'number' && detail.new_active_bank_row_count > 0 ? `${detail.new_active_bank_row_count} new bank row${detail.new_active_bank_row_count === 1 ? '' : 's'}` : null,
        typeof detail.current_balance_delta_cents === 'number' && detail.current_balance_delta_cents !== 0 ? `bank current changed by ${money(detail.current_balance_delta_cents, true)}` : null,
      ].filter(Boolean)
      setError(`The bank activity changed during review${changes.length ? `: ${changes.join(' and ')}` : ''}. Review the updated rows and balance before connecting.`)
      setAcknowledgeLateHistory(false); setAcknowledgePendingOverlap(false)
      void refreshReview()
    } else if (caught instanceof ApiError && caught.code === 'conversion_bank_check_failed') {
      setError(caught.message)
      const detail = caught.detail && typeof caught.detail === 'object' ? caught.detail as Record<string, unknown> : {}
      if (detail.recovery === 'update_access' && typeof detail.shared_item_id === 'number') {
        setExistingItemId(detail.shared_item_id)
        setLostMappings([])
        setAccessRecoveryRequired(true)
        setAccessRecoveryNeedsRefresh(false)
      }
    } else if (caught instanceof ApiError && caught.code === 'ledger_outcome_inspection_required') {
      onOutcomeUnknown()
      setError(null)
    } else if (caught instanceof ApiError && caught.code !== 'unknown_error') setError(caught.message)
    else { onOutcomeUnknown(); setError('Weft could not confirm whether the connection completed. Check the saved account status before trying again.') }
  } })
  const abandon = useMutation({ mutationFn: () => apiClient.providerDelete(`/api/account-conversion/${attempt!.id}`), onSuccess: async () => { const result = await attemptQuery.refetch(); if (attempt?.account_id === account.id && !result.data) onClose() }, onError: (caught) => setError(apiErrorMessage(caught, 'Could not cancel the staged connection.')) })
  const review = reviewQuery.data?.attempt.id === attempt?.id ? reviewQuery.data : undefined
  const pending = start.isPending || exchange.isPending || updateAccess.isPending || stageExisting.isPending || requestRefresh.isPending || readyMatches.isPending || reviewNew.isPending || decide.isPending || commit.isPending || abandon.isPending
  const reviewSynchronizing = attemptQuery.isFetching || reviewQuery.isFetching
  const candidateIds = !review || reviewQuery.isPlaceholderData ? null : anchor === 'feed' ? review.feed_candidate_ids.map(String) : anchor === 'history' ? review.history_candidate_ids : []
  const clearSelection = () => { setFeedId(null); setHistoryId(null); setAnchor(null) }
  const selectFeed = (id: string | number) => {
    const value = String(id)
    if (anchor === 'feed' && feedId === value) return clearSelection()
    if (anchor === 'history' && candidateIds?.includes(value)) return setFeedId(value)
    setAnchor('feed'); setFeedId(value); setHistoryId(null)
  }
  const selectHistory = (id: string | number) => {
    const value = Number(id)
    if (anchor === 'history' && historyId === value) return clearSelection()
    if (anchor === 'feed' && candidateIds?.includes(String(value))) return setHistoryId(value)
    setAnchor('history'); setHistoryId(value); setFeedId(null)
  }
  const highlight = (side: 'feed' | 'history', paired: string | null) => (id: string) => {
    if (!anchor) return ''
    if (anchor === side) return id === (side === 'feed' ? feedId : String(historyId)) ? ' is-selected' : ''
    if (id === paired) return ' is-paired'
    if (!candidateIds) return ''
    return candidateIds.includes(id) ? ' is-candidate' : ' is-dimmed'
  }
  const toggleReady = (row: ReviewFeedRow) => bucket !== 'ready' || row.ready_history_id === null || !(row.review_status === 'open' || row.matched_history_id === row.ready_history_id)
    ? undefined
    : () => decide.mutate({ edge: { feed_id: row.id, history_id: row.ready_history_id! }, state: row.review_status === 'matched' ? 'unresolved' : 'accepted' })
  const ownAttempt = attempt?.account_id === account.id ? attempt : null
  const preview = ownAttempt?.review
  useEffect(() => { setAcknowledgePendingOverlap(false) }, [preview?.preview_token])
  const firstDownloadInProgress = ownAttempt?.state === 'fetching' && firstDownload !== null
  const selectionLocked = firstDownloadInProgress
  const newDownloadInProgress = firstDownloadInProgress && firstDownload === 'new'
  const existingDownloadInProgress = firstDownloadInProgress && firstDownload === 'existing'
  const stage: Stage = outcomeUnknown ? 'outcome' : attempt && !ownAttempt ? 'other' : providerAccounts && (!ownAttempt || firstDownload === 'new' && firstDownloadInProgress) ? 'choose' : existingItemId !== null && (!ownAttempt || firstDownload === 'existing' && firstDownloadInProgress) ? 'existing' : !ownAttempt ? 'start' : ownAttempt.state !== 'review' ? 'fetching' : 'review'
  const focusRefs = { other: otherFocusRef, choose: chooseFocusRef, start: startFocusRef, existing: chooseFocusRef, fetching: fetchingFocusRef, review: reviewFocusRef, outcome: fetchingFocusRef }
  const existingAccountsVerified = existingItemQuery.isSuccess && !existingItemQuery.isFetching && !existingItemQuery.isError
  const selectedExistingAccount = existingItemQuery.data?.accounts.find((row) => row.provider_account_id === providerId)
  const selectedExistingAccountCompatible = Boolean(selectedExistingAccount && !selectedExistingAccount.mapped_account && compatibleProviderType(selectedExistingAccount.type, account.type) && (!selectedExistingAccount.currency || selectedExistingAccount.currency === 'USD'))
  const postedBankRows = preview ? preview.buckets.ready.rows + preview.buckets.choice.rows + preview.buckets.new.rows : 0
  const suggestedReadyCount = preview ? preview.buckets.ready.rows - preview.returning_ready_count : 0
  const checkCommitOutcome = async () => {
    if (reloadRequired) return
    setCheckingOutcome(true)
    setError(null)
    try {
      const [attemptResult, freshAccounts] = await Promise.all([
        attemptQuery.refetch(),
        apiClient.get<Account[]>('/api/accounts'),
      ])
      if (attemptResult.isError) throw attemptResult.error
      queryClient.setQueryData(['accounts'], freshAccounts)
      const freshAccount = freshAccounts.find((candidate) => candidate.id === account.id)
      if (!attemptResult.data && freshAccount?.plaid_connection) {
        if (!(await onInspectHistory()).outcomeResolved) throw new Error('Save outcome is not yet known.')
        await invalidateAccountAndTransactionQueries(queryClient)
        onOutcomeResolved(true)
      } else if (attemptResult.data?.account_id === account.id && attemptResult.data.state === 'review' && !freshAccount?.plaid_connection) {
        if (!(await onInspectHistory()).outcomeResolved) throw new Error('Save outcome is not yet known.')
        onOutcomeResolved(false)
        setAcknowledgeLateHistory(false); setAcknowledgePendingOverlap(false)
      } else {
        setError('Weft still cannot confirm the result. Keep this dialog open and check again before retrying.')
      }
    } catch {
      setError('Weft could not refresh the connection status. Try checking again before retrying.')
    } finally {
      setCheckingOutcome(false)
    }
  }
  const updateAttemptAccess = (itemId: number) => {
    setExistingItemId(itemId)
    setLostMappings([])
    setAccessRecoveryNeedsRefresh(false)
    recoveringAccess.current = true
    updateAccess.mutate(itemId)
  }
  const subtitle = ownAttempt && !firstDownloadInProgress ? `${providerContext(ownAttempt)} — activity stays staged until you connect.` : 'Attach a bank feed without replacing this account or its history.'
  const downloadNote = 'Downloading history can take several minutes. It is safe to close this dialog.'
  const errorCallout = error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>

  return <Modal size={stage === 'review' ? 'workbench' : 'md'} labelledBy="conversion-title" loading={attemptQuery.isPending || stage === 'review' && !preview && !reviewQuery.isError} initialFocusRef={focusRefs[stage]} onRequestClose={() => !pending && onClose()}>
    <DialogHeader titleId="conversion-title" title={`Connect ${account.name}`} subtitle={subtitle} closeDisabled={pending} onClose={onClose} />
    {stage === 'other' && attempt && <>
      <div className="bp-dialog-body">
        <div className="bp-callout bp-callout--warning"><strong>Another connection is unfinished</strong><p>Weft keeps one resumable bank connection at a time. Resume that review or cancel it before connecting {account.name}.</p></div>
        {errorCallout}
      </div>
      <div className="bp-dialog-footer">
        <div className="bp-dialog-footer-start"><Button size="lg" variant="danger" busy={abandon.isPending} disabled={pending} onClick={() => abandon.mutate()}>{abandon.isPending ? 'Cancelling…' : 'Cancel existing connection'}</Button></div>
        <Button ref={otherFocusRef} size="lg" variant="primary" disabled={pending} onClick={() => onResumeAccount(attempt.account_id)}>Resume bank connection</Button>
      </div>
    </>}
    {stage === 'outcome' && <>
      <div className="bp-dialog-body">
        <div className="bp-callout bp-callout--warning" role="status"><strong>{reloadRequired ? 'Reload required' : 'Connection status needs checking'}</strong><p>{reloadRequired ? 'This tab belongs to an older ledger session. Reload before continuing.' : 'Refresh the account status to see whether the bank feed was connected. If the staged review is still here, you can continue after checking.'}</p></div>
        {!reloadRequired && errorCallout}
      </div>
      <div className="bp-dialog-footer">
        <Button size="lg" disabled={checkingOutcome} onClick={onClose}>Close</Button>
        {reloadRequired ? <Button ref={fetchingFocusRef} size="lg" variant="primary" onClick={() => window.location.reload()}>Reload register</Button> : <Button ref={fetchingFocusRef} size="lg" variant="primary" busy={checkingOutcome} onClick={() => void checkCommitOutcome()}>{checkingOutcome ? 'Checking…' : 'Check connection status'}</Button>}
      </div>
    </>}
    {stage === 'choose' && providerAccounts && <>
      <div className="bp-dialog-body">
        <label className="bp-field">Bank account<FilterSelect ref={chooseFocusRef} ariaLabel="Bank account" autoFocus={false} value={providerId} disabled={pending || selectionLocked} options={providerAccounts.map((row) => ({ value: row.id, label: `${row.name} · ••••${row.mask} · ${row.subtype || row.type}` }))} onChange={setProviderId} /></label>
        <p className="bp-note">{newDownloadInProgress ? downloadNote : 'History downloads into a review first; nothing changes in this account until you connect.'}</p>
        {errorCallout}
      </div>
      <div className="bp-dialog-footer">
        <Button size="lg" disabled={pending || selectionLocked} onClick={() => setProviderAccounts(null)}>Cancel</Button>
        <Button size="lg" variant="primary" busy={exchange.isPending || newDownloadInProgress} disabled={!providerId || pending || selectionLocked} onClick={() => exchange.mutate()}>{(exchange.isPending || newDownloadInProgress) && <LoaderCircle className="bp-account-conversion-loading-icon" aria-hidden="true" />}{exchange.isPending || newDownloadInProgress ? 'Downloading…' : 'Download history'}</Button>
      </div>
    </>}
    {stage === 'start' && <>
      <div className="bp-dialog-body">
        <p className="bp-dialog-copy">Choose how to connect {account.name}. Downloaded activity stays separate until you review its matches and balance effect.</p>
        {existingItems.length > 0 && <section className="bp-account-conversion-sources" aria-label="Existing bank connections">
          <h3>Existing bank connections</h3>
          {existingItems.map((item) => <button key={item.id} type="button" className="bp-account-conversion-source" disabled={pending} onClick={() => { setError(null); setLostMappings([]); setExistingItemId(item.id) }}>
            <strong>{item.institution}</strong><span>Already connected to {item.accounts.map((linked) => linked.name).join(', ') || 'another account'}</span><span>Add an account from this bank login</span>
          </button>)}
        </section>}
        {errorCallout}
      </div>
      <div className="bp-dialog-footer">
        <Button size="lg" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button ref={startFocusRef} size="lg" variant="primary" busy={start.isPending} disabled={pending} onClick={() => start.mutate()}>{start.isPending ? 'Connecting…' : 'Connect a new bank login'}</Button>
      </div>
    </>}
    {stage === 'existing' && <>
      <div className="bp-dialog-body">
        {existingItemQuery.isLoading ? <p className="bp-dialog-copy">Checking which bank accounts this login currently shares…</p> : existingItemQuery.isError ? <div className="bp-callout bp-callout--error" role="alert">{apiErrorMessage(existingItemQuery.error, 'Weft could not check this connection. Try again before choosing an account.')}</div> : <>
          <p className="bp-dialog-copy">Choose an account shared by {existingItemQuery.data?.institution}. Accounts already connected to Weft stay unavailable here.</p>
          {existingItemQuery.data?.missing_mapped_accounts.map((mapped) => <div className="bp-callout bp-callout--error" role="alert" key={mapped.id}>Bank access to {mapped.name} is missing. Restore access or disconnect that Weft account before continuing.</div>)}
          {lostMappings.map((mapped) => <div className="bp-callout bp-callout--error" role="alert" key={mapped.id}>The bank update removed access to {mapped.name}. Choose Update bank access again and keep it selected, or disconnect that Weft account.</div>)}
          <label className="bp-field">Bank account<FilterSelect ref={chooseFocusRef} ariaLabel="Bank account" autoFocus={false} value={providerId} disabled={pending || selectionLocked || !existingAccountsVerified || Boolean(existingItemQuery.data?.missing_mapped_accounts.length || lostMappings.length)} onChange={setProviderId} options={[
            { value: '', label: 'Choose a bank account' },
            ...(existingItemQuery.data?.accounts ?? []).map((row) => {
              const compatible = compatibleProviderType(row.type, account.type) && (!row.currency || row.currency === 'USD')
              const unavailableReason = row.mapped_account ? ` — connected to ${row.mapped_account.name}` : !compatible ? ` — not compatible with this ${account.type} account` : ''
              return { value: row.provider_account_id, label: `${row.name}${row.mask ? ` · ••••${row.mask}` : ''} · ${row.subtype || row.type || 'account type unavailable'}${row.currency ? ` · ${row.currency}` : ''}${unavailableReason}`, disabled: Boolean(row.mapped_account) || !compatible }
            }),
          ]} /></label>
          <p className="bp-note">{selectedExistingAccount?.current_balance_cents !== null && selectedExistingAccount?.current_balance_cents !== undefined ? `Current bank balance: ${money(selectedExistingAccount.current_balance_cents)}` : 'Choose an account to see its current bank balance.'}</p>
          {errorCallout}
          <div className="bp-callout bp-callout--warning"><strong>Keep existing accounts selected</strong><p>When Plaid asks you to update access, keep {existingItems.find((item) => item.id === existingItemId)?.accounts.map((linked) => linked.name).join(', ') || 'all Weft-linked accounts'} selected. Removing one can stop its feed.</p></div>
          <p className="bp-note">{existingDownloadInProgress ? downloadNote : "Don't see the account? Update access to ask the bank to share another account with Weft."}</p>
        </>}
      </div>
      <div className="bp-dialog-footer">
        <Button size="lg" disabled={pending || selectionLocked} onClick={() => { setExistingItemId(null); setProviderId(''); setError(null); setLostMappings([]) }}>Back</Button>
        <Button size="lg" disabled={pending || selectionLocked} busy={updateAccess.isPending} onClick={() => existingItemId !== null && updateAccess.mutate(existingItemId)}>{updateAccess.isPending ? 'Opening bank…' : lostMappings.length || existingItemQuery.data?.missing_mapped_accounts.length || existingItemQuery.isError ? 'Update bank access again' : 'Update bank access'}</Button>
        <Button size="lg" variant="primary" busy={stageExisting.isPending || existingDownloadInProgress} disabled={!selectedExistingAccountCompatible || !existingAccountsVerified || pending || selectionLocked || Boolean(existingItemQuery.data?.missing_mapped_accounts.length || lostMappings.length)} onClick={() => stageExisting.mutate()}>{(stageExisting.isPending || existingDownloadInProgress) && <LoaderCircle className="bp-account-conversion-loading-icon" aria-hidden="true" />}{stageExisting.isPending || existingDownloadInProgress ? 'Downloading…' : 'Download history'}</Button>
      </div>
    </>}
    {stage === 'fetching' && ownAttempt && <>
      <div className="bp-dialog-body">
        {ownAttempt.state === 'failed' ? <p className="bp-dialog-copy">{ownAttempt.error || 'The staged download paused.'}</p> : <p className="bp-dialog-copy bp-account-conversion-progress"><LoaderCircle className="bp-account-conversion-loading-icon" aria-hidden="true" />Downloading bank history. You can finish later and resume from this account.</p>}
        {lostMappings.length > 0 && <div className="bp-callout bp-callout--warning"><strong>Bank access needs attention</strong><p>The bank still does not share {lostMappings.map((row) => row.name).join(', ')} with Weft. Update bank access again and keep it selected, then refresh the staged history.</p></div>}
        {accessRecoveryNeedsRefresh && <div className="bp-callout bp-callout--warning"><strong>Refresh before reconnecting</strong><p>Bank access is restored. Refresh staged history to verify the bank accounts before trying to connect again.</p></div>}
        {errorCallout}
      </div>
      <div className="bp-dialog-footer">
        <Button size="lg" disabled={pending} onClick={onClose}>Finish later</Button>
        {ownAttempt.state === 'failed' && <><Button size="lg" variant="danger" busy={abandon.isPending} disabled={pending} onClick={() => abandon.mutate()}>{abandon.isPending ? 'Cancelling…' : 'Cancel connection'}</Button>{ownAttempt.shared_item_id !== null && <Button size="lg" disabled={pending} busy={updateAccess.isPending} onClick={() => updateAttemptAccess(ownAttempt.shared_item_id!)}>{lostMappings.length ? 'Update bank access again' : 'Update bank access'}</Button>}<Button ref={fetchingFocusRef} size="lg" variant="primary" busy={requestRefresh.isPending} disabled={pending || accessRecoveryRequired} onClick={() => requestRefresh.mutate()}>{requestRefresh.isPending ? 'Refreshing…' : 'Refresh'}</Button></>}
      </div>
    </>}
    {stage === 'review' && ownAttempt && !preview && <div className="bp-dialog-body">{reviewQuery.isError ? <div className="bp-callout bp-callout--error" role="alert">The connection review could not load. <Button size="sm" onClick={() => void reviewQuery.refetch()}>Retry</Button></div> : <p className="bp-note">Loading connection review…</p>}</div>}
    {stage === 'review' && ownAttempt && preview && <>
      <div className="bp-dialog-body bp-dialog-body--flush">
        <div className="bp-account-conversion-workbench">
          <aside className="bp-rail bp-account-conversion-buckets">
            <div className="bp-account-conversion-rail-heading"><span className="bp-label">Review</span><span className="bp-label">Rows</span></div>
            <div className="bp-rail-list">{BUCKETS.map(([value, label], index) => { const count = preview.buckets[value]; return <button ref={index === 0 ? reviewFocusRef : undefined} key={value} type="button" className={`bp-rail-row${bucket === value ? ' is-selected' : ''}`} aria-current={bucket === value ? 'page' : undefined} onClick={() => setBucket(value)}><span>{value === 'ready' && count.rows > 0 && suggestedReadyCount === 0 ? 'Already in this account' : label}</span>{count.open > 0 && <span className="bp-account-conversion-open" title={`${count.open} still need a decision`}>{count.open} open</span>}<b>{count.rows}</b></button> })}</div>
            <div className="bp-account-conversion-rail-heading is-balances"><span className="bp-label">Balances</span></div>
            <SidebarBalances preview={preview} />
          </aside>
          <div className="bp-account-conversion-main">
            <section className="bp-account-conversion-registers"><Register title="From the bank" page={review?.feed} highlight={highlight('feed', review?.selected_feed_id ?? null)} mark={(row) => <FeedMark row={row} onToggle={toggleReady(row)} />} filter={feedText} onFilter={setFeedText} date={feedDate} onDate={setFeedDate} amount={feedAmount} onAmount={setFeedAmount} onSelect={selectFeed} onMore={() => review?.feed.next_cursor && setFeedCursor(review.feed.next_cursor)} /><Register title="From your history" page={review?.history} highlight={highlight('history', review?.selected_history_id == null ? null : String(review.selected_history_id))} mark={(row) => row.matched_feed_id !== null && <span className="bp-account-conversion-mark is-matched" role="img" aria-label="Used by a match" title="Used by a match"><Link2 aria-hidden="true" /></span>} filter={historyText} onFilter={setHistoryText} date={historyDate} onDate={setHistoryDate} amount={historyAmount} onAmount={setHistoryAmount} onSelect={selectHistory} onMore={() => review?.history.next_cursor && setHistoryCursor(review.history.next_cursor)} /></section>
            {bucket === 'ready' && (suggestedReadyCount > 0 ? <label className="bp-check"><input type="checkbox" checked={preview.buckets.ready.matched - preview.returning_ready_count === suggestedReadyCount} disabled={pending} onChange={(event) => readyMatches.mutate(event.target.checked)} />Use all {suggestedReadyCount} suggested matches</label> : <p className="bp-note">These bank transactions are already in this account. Weft will reconnect them in place, keeping your notes and categories.</p>)}
            {bucket === 'new' && <label className="bp-check"><input type="checkbox" checked={ownAttempt.review_all_new} disabled={pending} onChange={(event) => reviewNew.mutate(event.target.checked)} />Mark all {preview.buckets.new.rows} imported rows Reviewed</label>}
            <section className="bp-account-conversion-review-disclosures" aria-label="Connection details">
              {ownAttempt.shared_item_id !== null && postedBankRows === 0 && preview.superseded_skipped_count === 0 && preview.plaid_current_balance_cents !== null && preview.plaid_current_balance_cents !== 0 && <div className="bp-callout bp-callout--warning"><strong>No posted bank history has arrived</strong><p>The bank reports a current balance of {money(preview.plaid_current_balance_cents)}, but Weft has no posted transactions for this account yet. Refresh once before connecting to check for history still in transit.</p></div>}
              {preview.currency_warning && <div className="bp-callout bp-callout--warning">The bank did not report a currency. Weft will treat these amounts as USD.</div>}
              {preview.history_seam_date && <p className="bp-note">At the start of your retained history on {preview.history_seam_date}, the running balance changes from {money(preview.history_seam_before_cents ?? 0)} to {money(preview.history_seam_after_cents ?? 0)}.</p>}
              <p className="bp-note">{preview.returning_count > 0 && <>{preview.returning_count} bank rows already in this account · </>}{preview.matched_count} matches · {preview.buckets.new.rows} new bank rows · {preview.buckets.kept.rows} history rows kept · {preview.buckets.pending.rows} pending bank rows.</p>
              {preview.superseded_skipped_count > 0 && <p className="bp-note">{preview.superseded_skipped_count} older bank row{preview.superseded_skipped_count === 1 ? '' : 's'} were replaced during an earlier connection. They will not be imported twice; their replacement entries remain unchanged.</p>}

            </section>
            {accessRecoveryRequired && ownAttempt.shared_item_id !== null && <div className="bp-callout bp-callout--warning"><strong>Bank access needs attention</strong><p>{lostMappings.length ? `The bank still does not share ${lostMappings.map((row) => row.name).join(', ')} with Weft. Restore access, then refresh the staged history before connecting.` : 'Restore access to the linked bank accounts, then refresh the staged history before connecting.'}</p><div className="bp-callout-actions"><Button size="md" disabled={pending} busy={updateAccess.isPending} onClick={() => updateAttemptAccess(ownAttempt.shared_item_id!)}>{lostMappings.length ? 'Update bank access again' : 'Update bank access'}</Button></div></div>}
            {accessRecoveryNeedsRefresh && <div className="bp-callout bp-callout--warning"><strong>Refresh before reconnecting</strong><p>Bank access is restored. Refresh the staged history to verify the bank accounts before trying to connect again.</p><div className="bp-callout-actions"><Button size="md" disabled={pending} busy={requestRefresh.isPending} onClick={() => requestRefresh.mutate()}>{requestRefresh.isPending ? 'Refreshing…' : 'Refresh bank history'}</Button></div></div>}
            <PairComparison value={review?.comparison ?? null} selectedSide={anchor} pending={pending} onSave={(state, choices) => decide.mutate({ state, choices })} />
            {errorCallout}
          </div>
        </div>
      </div>
      <div className="bp-dialog-footer">
        {preview.pending_candidate_count > 0 && <div className="bp-account-conversion-connect-ack"><strong>Pending overlap remains undecided</strong><p>{preview.pending_candidate_count} pending bank row{preview.pending_candidate_count === 1 ? '' : 's'} totaling {money(preview.pending_candidate_amount_cents)} may overlap retained history and count twice in Working immediately after connection.</p><label className="bp-check"><input type="checkbox" checked={acknowledgePendingOverlap} disabled={pending || reviewSynchronizing} onChange={(event) => setAcknowledgePendingOverlap(event.target.checked)} />I understand and will use Find match or Exclude to resolve this overlap after connecting.</label></div>}
        {ownAttempt.shared_item_id !== null && <div className="bp-account-conversion-connect-ack"><strong>Older bank history may still arrive</strong><label className="bp-check"><input type="checkbox" checked={acknowledgeLateHistory} disabled={pending} onChange={(event) => setAcknowledgeLateHistory(event.target.checked)} />I understand that late history can leave a Bank difference until I review it and use Re-init.</label><details><summary>Why this matters</summary><p>Plaid does not tell Weft when this added account's full history has arrived. Later older transactions may need matching and can leave a Bank difference until you review them and use Re-init to correct the Starting Balance. Weft will not change it automatically.</p></details></div>}
        <div className="bp-dialog-footer-start">
          <span className="bp-account-conversion-footer-note"><strong>{preview.unresolved_count ? `${preview.unresolved_count} unresolved posted choice${preview.unresolved_count === 1 ? '' : 's'}` : 'All posted choices resolved'}</strong><span>{preview.pending_candidate_count} optional pending candidate{preview.pending_candidate_count === 1 ? '' : 's'} ({money(preview.pending_candidate_amount_cents)})</span></span>
        </div>
        <Button size="lg" busy={requestRefresh.isPending} disabled={pending || accessRecoveryRequired} onClick={() => requestRefresh.mutate()}>{requestRefresh.isPending ? 'Refreshing…' : 'Refresh bank history'}</Button>
        <Button size="lg" variant="danger" busy={abandon.isPending} disabled={pending} onClick={() => abandon.mutate()}>{abandon.isPending ? 'Cancelling…' : 'Cancel connection'}</Button>
        <Button size="lg" disabled={pending} onClick={onClose}>Finish later</Button>
        <Button size="lg" variant="primary" busy={commit.isPending} disabled={!preview.can_commit || pending || reviewSynchronizing || accessRecoveryRequired || accessRecoveryNeedsRefresh || ownAttempt.shared_item_id !== null && !acknowledgeLateHistory || preview.pending_candidate_count > 0 && !acknowledgePendingOverlap} onClick={() => commit.mutate()}>{commit.isPending ? 'Connecting…' : 'Connect account'}</Button>
      </div>
    </>}
  </Modal>
}

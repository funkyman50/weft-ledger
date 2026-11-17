import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { ApiError, apiClient } from '../../api/client'
import { invalidateAccountAndTransactionQueries } from '../../api/hooks'
import type { Account, LedgerRow, LedgerTarget, StartingBalanceContext, StartingBalancePreview, StartingBalanceSuggestion, StartingBalanceTotals } from '../../api/types'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { Modal } from '../../components/Modal'
import { formatCents, money } from '../../lib/money'
import { dateLabel } from '../ledger/transactionDisplay'
import { parseLedgerAmount } from '../ledger/useLedgerEditor'
import { InitializationOnboarding } from './InitializationOnboarding'
import { dismissInitializationIntro, initializationIntroIsDue } from './initializationOnboardingCooldown'

interface PreviewInput { context_token: string; reference_balance_cents: number; included_pending: LedgerTarget[] }
interface HeldPreview { preview: StartingBalancePreview; input: PreviewInput }

const totalLabels: Array<[keyof StartingBalanceTotals, string]> = [
  ['starting_balance_cents', 'Starting balance'], ['cleared_balance_cents', 'Cleared'], ['uncleared_balance_cents', 'Uncleared'], ['working_balance_cents', 'Working'],
]

function selectionTargets(context: StartingBalanceContext, included: ReadonlySet<number>): LedgerTarget[] {
  return context.pending_rows.filter((row) => included.has(row.id)).map((row) => ({ id: row.id, edit_token: row.edit_token }))
}

function suggestionMessage(suggestion: StartingBalanceSuggestion | null): string | null {
  if (!suggestion) return null
  if (suggestion.status === 'unique') return `Suggested from the available balance${suggestion.available_balance_cents === null ? '' : ` ${money(suggestion.available_balance_cents)}`}. Review every selection before saving.`
  return suggestion.reason
}

export function StartingBalanceDialog({ account, onClose, onSaved, onResolveMissingPending, onInspectHistory, returnFocusRef, suspended = false }: {
  account: Account
  onClose: () => void
  onSaved: () => void
  onResolveMissingPending?: (row: LedgerRow) => void
  onInspectHistory?: () => Promise<unknown>
  suspended?: boolean
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const queryClient = useQueryClient()
  const openingAccountId = useRef(account.id).current
  const initialSetup = useRef(account.starting_balance_initialized_at === null).current
  const [context, setContext] = useState<StartingBalanceContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reference, setReference] = useState('')
  const [included, setIncluded] = useState<ReadonlySet<number>>(new Set())
  const [stage, setStage] = useState<'balance' | 'checklist'>('balance')
  const [intro, setIntro] = useState<null | 'initial' | 'replay'>(() => initializationIntroIsDue() ? 'initial' : null)
  const [suggestion, setSuggestion] = useState<StartingBalanceSuggestion | null>(null)
  const [suggestionPending, setSuggestionPending] = useState(false)
  const [held, setHeld] = useState<HeldPreview | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [completedElsewhere, setCompletedElsewhere] = useState(false)
  const referenceEditedRef = useRef(false)
  const referenceRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const introVisibleRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const wasSuspendedRef = useRef(false)
  const suggestionRequestedRef = useRef(false)
  const suggestionGenerationRef = useRef(0)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended

  const completionObserved = initialSetup && account.id === openingAccountId && account.starting_balance_initialized_at !== null
  const initializationFinished = completedElsewhere || completionObserved
  const blocked = (context?.missing_pending_rows.length ?? 0) > 0
  const previewInput = useMemo<PreviewInput | null>(() => {
    const cents = parseLedgerAmount(reference)
    return context && cents !== null ? { context_token: context.context_token, reference_balance_cents: cents, included_pending: selectionTargets(context, included) } : null
  }, [context, included, reference])
  const currentPreview = held?.input === previewInput ? held : null
  const canPreview = stage === 'checklist' && intro === null && !loading && !loadError && !suggestionPending && !needsRefresh && !blocked && !initializationFinished && !suspended && previewInput !== null
  const previewPending = canPreview && !currentPreview
  const displayedPreview = currentPreview ?? (previewPending ? held : null)

  const invalidateSuggestion = useCallback((allowAnotherRequest = false) => {
    suggestionGenerationRef.current += 1
    setSuggestionPending(false)
    if (allowAnotherRequest) suggestionRequestedRef.current = false
  }, [])

  const load = useCallback(async (preserveDraft = false) => {
    invalidateSuggestion(true)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setLoadError(null)
    try {
      const fresh = await apiClient.get<StartingBalanceContext>(`/api/accounts/${account.id}/starting-balance`, controller.signal)
      if (controller.signal.aborted) return
      if (initialSetup && fresh.initialized_at !== null) {
        setCompletedElsewhere(true); setContext(fresh); setHeld(null); setSuggestion(null); setNeedsRefresh(false); setError(null)
        return
      }
      setContext(fresh)
      setIncluded((current) => preserveDraft ? new Set(fresh.pending_rows.filter((row) => current.has(row.id)).map((row) => row.id)) : new Set(fresh.pending_rows.filter((row) => row.manually_cleared).map((row) => row.id)))
      if (!referenceEditedRef.current) setReference(fresh.bank_balance_cents === null ? '' : formatCents(fresh.bank_balance_cents))
      setHeld(null); setSuggestion(null); setNeedsRefresh(false); setError(null)
    } catch (caught) {
      if (!controller.signal.aborted) setLoadError(caught instanceof ApiError ? caught.message : 'The starting balance details could not be loaded.')
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }, [account.id, initialSetup, invalidateSuggestion])

  useEffect(() => { void load(); return () => abortRef.current?.abort() }, [load])
  useEffect(() => {
    if (initialSetup && account.id === openingAccountId && account.starting_balance_initialized_at !== null) void load(true)
  }, [account.id, account.starting_balance_initialized_at, initialSetup, load, openingAccountId])
  useEffect(() => { if (wasSuspendedRef.current && !suspended) void load(true); wasSuspendedRef.current = suspended }, [load, suspended])
  useEffect(() => () => { invalidateSuggestion() }, [invalidateSuggestion])

  useEffect(() => {
    if (!previewPending || !previewInput) return
    const controller = new AbortController()
    setError(null)
    void apiClient.postQuery<StartingBalancePreview>(`/api/accounts/${account.id}/starting-balance/preview`, previewInput, controller.signal).then((preview) => {
      if (!controller.signal.aborted) setHeld({ preview, input: previewInput })
    }).catch((caught) => {
      if (controller.signal.aborted) return
      setHeld(null)
      setNeedsRefresh(true)
      setError(caught instanceof ApiError && (caught.status === 409 || caught.code === 'starting_balance_missing_pending')
        ? 'This account changed in the meantime. Refresh to update the balances.'
        : `${caught instanceof ApiError ? caught.message : 'The balances could not be updated.'} Refresh to try again.`)
    })
    return () => controller.abort()
  }, [account.id, previewInput, previewPending])

  const clearDraftError = () => { if (!needsRefresh) setError(null) }
  const changeReference = (value: string) => { invalidateSuggestion(); referenceEditedRef.current = true; setReference(value); setSuggestion(null); clearDraftError() }
  const toggleRow = (id: number) => { invalidateSuggestion(); setIncluded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }); clearDraftError() }
  const parseReference = () => {
    const cents = parseLedgerAmount(reference)
    if (cents === null) { setError('Enter the bank balance as a dollar amount, like 1250.00 or -809.47.'); return null }
    return cents
  }
  const requireRefresh = (message: string) => { setHeld(null); setNeedsRefresh(true); setError(message) }
  const continueToChecklist = async () => {
    if (!context) return
    const cents = parseReference()
    if (cents === null) return
    setStage('checklist'); setError(null)
    if (suggestionRequestedRef.current) return
    suggestionRequestedRef.current = true
    const generation = ++suggestionGenerationRef.current
    setSuggestion(null); setSuggestionPending(true)
    try {
      const result = await apiClient.postQuery<StartingBalanceSuggestion>(`/api/accounts/${account.id}/starting-balance/suggestion`, { context_token: context.context_token, reference_balance_cents: cents })
      if (suggestionGenerationRef.current !== generation || suspendedRef.current) return
      setSuggestion(result)
      if (result.status === 'unique') setIncluded(new Set(result.included_pending.map((target) => target.id)))
    } catch (caught) {
      if (suggestionGenerationRef.current !== generation || suspendedRef.current) return
      setSuggestion({ status: 'unsupported', included_pending: [], available_balance_cents: null, reason: caught instanceof ApiError ? caught.message : 'Suggestions are unavailable. Choose pending transactions manually.' })
    } finally {
      if (suggestionGenerationRef.current === generation) setSuggestionPending(false)
    }
  }
  const save = async () => {
    if (!currentPreview || !canPreview || saving) return
    invalidateSuggestion()
    setSaving(true); setError(null)
    try {
      await apiClient.post<StartingBalanceContext>(`/api/accounts/${account.id}/starting-balance/confirm`, { preview_token: currentPreview.preview.preview_token, reference_balance_cents: currentPreview.input.reference_balance_cents, included_pending: currentPreview.input.included_pending })
      void invalidateAccountAndTransactionQueries(queryClient)
      onSaved()
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 409 || caught.code === 'starting_balance_missing_pending')) requireRefresh('This account changed before saving. Refresh and review the updated balances.')
      else if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500 && caught.code !== 'unknown_error') setError(caught.message)
      else requireRefresh("It's unclear whether the save went through. Refresh before trying again.")
    } finally { setSaving(false) }
  }

  const introVisible = intro !== null && !initializationFinished
  useEffect(() => {
    const wasIntroVisible = introVisibleRef.current
    introVisibleRef.current = introVisible
    if (!wasIntroVisible || introVisible) return
    const timer = window.setTimeout(() => (referenceRef.current ?? headingRef.current)?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [introVisible])

  if (suspended) return null
  const signedAccount = account.type === 'credit' || account.type === 'loan'
  const before = displayedPreview?.preview.before ?? context?.before ?? null
  const referencePresent = !introVisible && !initializationFinished && !loading && !loadError && context !== null && stage === 'balance'
  const close = () => { invalidateSuggestion(); onClose() }
  const refresh = () => {
    void (async () => {
      try {
        await onInspectHistory?.()
        await load(true)
      } catch {
        setError('Refresh failed. Try again before saving.')
      }
    })()
  }
  const dismissIntro = () => { dismissInitializationIntro(); setIntro(null) }
  const closeIntro = () => {
    if (intro === 'replay') setIntro(null)
    else close()
  }
  const replayIntro = () => {
    invalidateSuggestion()
    setIntro('replay')
  }

  return <Modal size="md" labelledBy={introVisible ? 'initialization-onboarding-title' : 'starting-balance-title'} loading={loading && !introVisible} initialFocusRef={referencePresent ? referenceRef : headingRef} returnFocusRef={returnFocusRef} onRequestClose={() => { if (!saving) { if (introVisible) closeIntro(); else close() } }}>
    {introVisible ? <InitializationOnboarding accountName={account.name} headingId="initialization-onboarding-title" headingRef={headingRef} replay={intro === 'replay'} onDismiss={dismissIntro} onClose={closeIntro} />
      : <>
        <DialogHeader
          titleId="starting-balance-title"
          titleRef={headingRef}
          title={initialSetup ? 'Initialize account' : 'Re-init account'}
          subtitle={<>{account.name} · {initialSetup ? 'Set the opening balance from your bank and review pending activity it may already include.' : 'Deliberately correct the saved opening balance. This does not resolve a routine Bank difference.'}</>}
          onClose={close}
          closeDisabled={saving}
          actions={!initializationFinished && <Button size="lg" variant="quiet" disabled={saving || suggestionPending || previewPending} onClick={replayIntro}>Explain setup</Button>}
        />
        <div className="bp-dialog-body">
          {initializationFinished ? (
            completedElsewhere && context?.initialized_at != null ? <p className="bp-dialog-copy">This account finished initialization in the background. The saved starting balance is now active.{context.before && ` Starting balance: ${money(context.before.starting_balance_cents)}. Working balance: ${money(context.before.working_balance_cents)}.`}</p>
              : loadError ? <div className="bp-callout bp-callout--error" role="alert">{loadError}</div>
                : <p className="bp-dialog-copy" role="status">Checking the saved initialization…</p>
          ) : loading ? <p className="bp-dialog-copy" role="status">Loading balances and pending transactions…</p>
            : loadError ? <div className="bp-callout bp-callout--error" role="alert">{loadError}</div>
              : context && <>
                <label className="bp-field">Bank-reported current balance
                  <input ref={referenceRef} className="bp-control" inputMode="decimal" autoComplete="off" placeholder="0.00" value={reference} disabled={saving || stage === 'checklist'} aria-describedby="starting-balance-reference-help" onChange={(event) => changeReference(event.target.value)} />
                  <p id="starting-balance-reference-help" className="bp-field-hint">{context.bank_balance_cents === null ? 'Enter the current balance shown by your bank.' : `Prefilled from the balance last fetched ${context.bank_balance_fetched_at ? new Date(context.bank_balance_fetched_at).toLocaleString() : 'at an unknown time'}. You can enter a fresher bank balance.`}{signedAccount && ' A balance you owe is negative, so a $500.00 debt is -500.00.'}</p>
                </label>
                {stage === 'checklist' && <>
                  <section className="bp-dialog-section" aria-labelledby="starting-balance-pending-title">
                    <div className="bp-dialog-section-heading"><strong id="starting-balance-pending-title">Which pending transactions are already included in this balance?</strong></div>
                    {context.pending_rows.length === 0 ? <p className="bp-dialog-copy">No pending transactions need a decision. Review the balances below.</p> : <div className="bp-list bp-list--scroll">{context.pending_rows.map((row) => <label key={row.id} className="bp-list-row"><input type="checkbox" checked={included.has(row.id)} disabled={saving} onChange={() => toggleRow(row.id)} /><span className="bp-starting-row-date">{dateLabel(row.date)}</span><span className="bp-starting-row-name">{row.description}</span><span className="bp-starting-row-amount">{money(row.amount_cents, true)}</span></label>)}</div>}
                    {suggestionMessage(suggestion) && <p className="bp-note">{suggestionMessage(suggestion)}</p>}
                    {context.pending_rows.length > 0 && <p className="bp-note">Save marks checked rows Cleared* and removes manual clearance from unchecked rows.</p>}
                  </section>
                  {blocked && <section className="bp-dialog-section" aria-labelledby="starting-missing-pending-title">
                    <div className="bp-dialog-section-heading"><strong id="starting-missing-pending-title">Resolve missing pending transactions first</strong></div>
                    <p className="bp-dialog-copy">These rows must be resolved before this initialization can be saved.</p>
                    <div className="bp-list">{context.missing_pending_rows.map((row) => <div className="bp-list-row" key={row.id}><span className="bp-starting-row-name">{dateLabel(row.date)} · {row.description} · {money(row.amount_cents, true)}</span><Button size="sm" onClick={() => onResolveMissingPending?.(row)}>Resolve</Button></div>)}</div>
                  </section>}
                  <table className="bp-starting-table" aria-label="Totals before and after initialization" aria-busy={suggestionPending || previewPending}><thead><tr><th scope="col"><span className="bp-visually-hidden">Total</span></th>{before && <th scope="col">Before</th>}<th scope="col">After</th></tr></thead><tbody>{totalLabels.map(([key, label]) => <tr key={key} className={key === 'starting_balance_cents' ? 'is-starting-balance' : undefined}><th scope="row">{label}</th>{before && <td>{money(before[key])}</td>}<td>{displayedPreview ? money(displayedPreview.preview.after[key]) : '—'}</td></tr>)}</tbody></table>
                  <p className="bp-visually-hidden" role="status">{suggestionPending ? 'Checking pending suggestions…' : previewPending ? 'Updating balances…' : ''}</p>
                </>}
              </>}
          {!initializationFinished && error && <div className="bp-callout bp-callout--error" role="alert">{error}</div>}
        </div>
        <div className="bp-dialog-footer">
          {initializationFinished ? <>
            <Button size="lg" onClick={close}>Close</Button>
            {loadError && <Button size="lg" disabled={loading} onClick={() => void load(true)}>Retry</Button>}
            <Button size="lg" variant="primary" onClick={close}>View register</Button>
          </> : <>
            {loadError && <Button size="lg" disabled={loading} onClick={() => void load()}>Retry</Button>}
            {needsRefresh && <Button size="lg" disabled={loading || saving} onClick={refresh}>Refresh</Button>}
            {stage === 'checklist' && <Button size="lg" disabled={saving} onClick={() => { invalidateSuggestion(); setStage('balance'); setHeld(null) }}>Back</Button>}
            <Button size="lg" disabled={saving} onClick={close}>Cancel</Button>
            {stage === 'balance'
              ? <Button size="lg" variant="primary" disabled={!context || loading || Boolean(loadError) || saving} onClick={() => void continueToChecklist()}>Continue</Button>
              : <Button size="lg" variant="primary" busy={saving} disabled={!canPreview || !currentPreview} onClick={() => void save()}>{saving ? 'Saving…' : 'Save starting balance'}</Button>}
          </>}
        </div>
      </>}
  </Modal>
}

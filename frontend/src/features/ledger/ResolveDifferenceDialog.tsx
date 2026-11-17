import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../api/client'
import type { Account, LedgerHistoryInspection, LoanAccountContext } from '../../api/types'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { Modal } from '../../components/Modal'
import { formatCents, money } from '../../lib/money'
import { dateLabel } from './transactionDisplay'
import { parseLedgerAmount } from './useLedgerEditor'
import { useLoanDialog } from './useLoanDialog'

function blocker(context: LoanAccountContext): string | null {
  const difference = context.difference_cents
  if (difference === null) return 'There is no current bank balance to compare. Enter a charge manually if you need one.'
  if (difference === 0) return 'Cleared already matches the bank balance.'
  if (difference < 0) return 'Weft shows more owed than the bank, so a charge cannot resolve it. Look for a missing payment or credit.'
  if (!context.payee?.assignable) return 'The latest transaction has no Payee to reuse. Enter this charge manually.'
  return null
}

export function ResolveDifferenceDialog({
  account,
  onClose,
  onSaved,
  onAddDetails,
  onInspectHistory,
}: {
  account: Account
  onClose: () => void
  onSaved: () => void
  onAddDetails: () => void
  onInspectHistory: () => Promise<LedgerHistoryInspection>
}) {
  const dialog = useLoanDialog<LoanAccountContext>({
    read: () => apiClient.get(`/api/loans/${account.id}`),
    inspect: onInspectHistory,
    onSaved,
  })
  const context = dialog.context
  const difference = context?.difference_cents ?? 0
  const [escrow, setEscrow] = useState('')
  const initial = useRef<string | null>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const reasonRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (!context?.details || initial.current !== null) return
    initial.current = formatCents(Math.min(context.details.escrow_cents, Math.max(difference, 0)))
    setEscrow(initial.current)
  }, [context, difference])
  const reason = context?.details ? blocker(context) : null
  const escrowCents = escrow.trim() ? parseLedgerAmount(escrow) : 0
  const valid = escrowCents !== null && escrowCents >= 0 && escrowCents <= difference
  const interestCents = valid ? difference - escrowCents! : null
  const showEscrow = context?.details && (context.details.kind === 'mortgage' || context.details.escrow_cents > 0)
  const capped = context?.details && context.details.escrow_cents > difference && difference > 0
  const missing = [
    context && interestCents && context.interest_category_id === null ? 'Interest & Fees' : null,
    context && escrowCents && context.escrow_category_id === null ? 'Escrow' : null,
  ].filter(Boolean)
  const blocked = dialog.busy || dialog.needsRefresh || dialog.saved
  const ready = Boolean(context?.details) && reason === null && valid
  const save = () => {
    if (!ready) return
    void dialog.save(() =>
      apiClient.post(`/api/loans/${account.id}/resolve`, {
        expected_difference_cents: difference,
        escrow_cents: escrowCents,
        interest_cents: interestCents,
      })
    )
  }
  return (
    <Modal size="sm" placement="corner" labelledBy="resolve-difference-title" loading={dialog.loading} initialFocusRef={reason ? reasonRef : saveRef} onRequestClose={() => { if (!blocked) onClose() }}>
      <DialogHeader titleId="resolve-difference-title" title="Resolve difference" subtitle={account.name} onClose={onClose} closeDisabled={blocked} />
      <div className="bp-dialog-body">
        {dialog.loadError && !context && (
          <div className="bp-callout bp-callout--error" role="alert">
            This loan could not be loaded.
            <div className="bp-callout-actions">
              <Button size="sm" onClick={() => void dialog.refresh()}>Retry</Button>
            </div>
          </div>
        )}
        {context && !context.details && (
          <p className="bp-dialog-copy">Weft can post this difference as an interest charge, split out escrow for a mortgage. Add loan details first.</p>
        )}
        {context?.details && reason && <p ref={reasonRef} tabIndex={-1} className="bp-dialog-copy bp-focus-quiet">{reason}</p>}
        {context?.details && !reason && (
          <>
            <dl className="bp-loan-summary">
              <div className="is-key">
                <dt>Charge</dt>
                <dd>{money(-difference)}</dd>
              </div>
              {showEscrow && (
                <div className="is-input">
                  <dt><label htmlFor="resolve-escrow">Escrow</label></dt>
                  <dd>
                    <input id="resolve-escrow" className="bp-control bp-control--sm bp-loan-amount" inputMode="decimal" value={escrow} disabled={blocked} onChange={(event) => setEscrow(event.target.value)} />
                  </dd>
                </div>
              )}
              <div>
                <dt>Interest</dt>
                <dd>{interestCents === null ? '—' : formatCents(interestCents)}</dd>
              </div>
            </dl>
            <p className="bp-note" role={valid ? undefined : 'alert'}>
              {!valid
                ? `Escrow must be between $0.00 and ${money(difference)}.`
                : `${dateLabel(context.today)} · ${context.payee!.name} · Cleared.${capped ? ' Escrow was capped at the difference.' : ''}${missing.length ? ` ${missing.join(' and ')} not found; saves as No category.` : ''}`}
            </p>
            {context.bank_updated_at && <p className="bp-note">Bank balance updated {new Date(context.bank_updated_at).toLocaleString()}.</p>}
          </>
        )}
        {dialog.error && <div className="bp-callout bp-callout--error" role="alert">{dialog.error}</div>}
      </div>
      {(!context?.details || !reason || dialog.needsRefresh) && <div className="bp-dialog-footer">
        {context && !context.details ? (
          <Button ref={saveRef} size="md" variant="primary" onClick={onAddDetails}>Add loan details</Button>
        ) : dialog.needsRefresh ? (
          <Button size="md" variant="primary" busy={dialog.busy} onClick={() => void dialog.refresh()}>
            {dialog.busy ? 'Inspecting…' : 'Inspect and refresh'}
          </Button>
        ) : (
          <Button ref={saveRef} size="md" variant="primary" busy={dialog.busy} disabled={blocked || !ready} onClick={save}>
            {dialog.busy ? 'Saving…' : 'Post charge'}
          </Button>
        )}
      </div>}
    </Modal>
  )
}

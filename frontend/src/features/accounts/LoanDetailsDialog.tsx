import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../api/client'
import type { Account, LedgerHistoryInspection, LoanAccountContext, LoanDetails } from '../../api/types'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal } from '../../components/Modal'
import { formatCents } from '../../lib/money'
import { parseLedgerAmount } from '../ledger/useLedgerEditor'
import { useLoanDialog } from '../ledger/useLoanDialog'

type Draft = { kind: LoanDetails['kind']; escrow: string }

function draftFrom(details: LoanDetails | null): Draft {
  return { kind: details?.kind ?? 'mortgage', escrow: formatCents(details?.escrow_cents ?? 0) }
}

export function LoanDetailsDialog({
  account,
  placement = 'center',
  onClose,
  onSaved,
  onInspectHistory,
}: {
  account: Account
  placement?: 'center' | 'corner'
  onClose: () => void
  onSaved: () => void
  onInspectHistory: () => Promise<LedgerHistoryInspection>
}) {
  const dialog = useLoanDialog<LoanAccountContext>({
    read: () => apiClient.get(`/api/loans/${account.id}`),
    inspect: onInspectHistory,
    onSaved,
  })
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null))
  const initial = useRef<string | null>(null)
  const [discard, setDiscard] = useState(false)
  const keepEditingRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!dialog.context || initial.current !== null) return
    const next = draftFrom(dialog.context.details)
    setDraft(next)
    initial.current = JSON.stringify(next)
    requestAnimationFrame(() => saveRef.current?.focus())
  }, [dialog.context])
  useEffect(() => {
    if (discard) keepEditingRef.current?.focus()
  }, [discard])
  const blocked = dialog.busy || dialog.needsRefresh || dialog.saved
  const escrow = draft.escrow.trim() ? parseLedgerAmount(draft.escrow) : 0
  const valid = escrow !== null && escrow >= 0
  const close = () => {
    if (blocked) return
    if (discard) setDiscard(false)
    else if (initial.current !== null && JSON.stringify(draft) !== initial.current) setDiscard(true)
    else onClose()
  }
  const save = (remove = false) => {
    if (!dialog.context || (!remove && !valid)) return
    void dialog.save(() =>
      apiClient.put(`/api/loans/${account.id}/details`, {
        details: remove ? null : { kind: draft.kind, escrow_cents: escrow },
      })
    )
  }
  return (
    <Modal size="sm" placement={placement} labelledBy="loan-details-title" loading={dialog.loading} initialFocusRef={saveRef} onRequestClose={close}>
      <DialogHeader titleId="loan-details-title" title="Loan details" subtitle={account.name} onClose={close} closeDisabled={blocked} />
      <div className="bp-dialog-body">
        {dialog.loadError && !dialog.context && (
          <div className="bp-callout bp-callout--error" role="alert">
            Loan details could not be loaded.
            <div className="bp-callout-actions">
              <Button size="md" onClick={() => void dialog.refresh()}>Retry</Button>
            </div>
          </div>
        )}
        {dialog.context && (
          <>
            <label className="bp-field">
              <span>Kind</span>
              <FilterSelect
                autoFocus={false}
                ariaLabel="Loan kind"
                value={draft.kind}
                disabled={blocked}
                options={[
                  { value: 'mortgage', label: 'Mortgage' },
                  { value: 'student', label: 'Student loan' },
                  { value: 'other', label: 'Other loan' },
                ]}
                onChange={(kind) => setDraft({ ...draft, kind: kind as Draft['kind'] })}
              />
            </label>
            <label className="bp-field">
              <span>Escrow per payment</span>
              <input
                className="bp-control"
                inputMode="decimal"
                value={draft.escrow}
                disabled={blocked}
                onChange={(event) => setDraft({ ...draft, escrow: event.target.value })}
              />
              <span className="bp-field-hint">Property taxes and homeowners insurance collected with each payment. Use 0 for none.</span>
            </label>
          </>
        )}
        {dialog.error && <div className="bp-callout bp-callout--error" role="alert">{dialog.error}</div>}
      </div>
      <div className="bp-dialog-footer">
        {discard ? (
          <>
            <p className="bp-dialog-footer-start bp-note" role="alert">Discard changes?</p>
            <Button ref={keepEditingRef} size="md" onClick={() => setDiscard(false)}>Keep editing</Button>
            <Button size="md" variant="danger" onClick={onClose}>Discard</Button>
          </>
        ) : (
          <>
            {dialog.context?.details && (
              <div className="bp-dialog-footer-start">
                <Button size="md" variant="quiet" disabled={blocked} onClick={() => save(true)}>Remove details</Button>
              </div>
            )}
            {dialog.needsRefresh ? (
              <Button size="md" variant="primary" busy={dialog.busy} onClick={() => void dialog.refresh()}>
                {dialog.busy ? 'Inspecting…' : 'Inspect and refresh'}
              </Button>
            ) : (
              <Button ref={saveRef} size="md" variant="primary" busy={dialog.busy} disabled={blocked || !valid || !dialog.context} onClick={() => save()}>
                {dialog.busy ? 'Saving…' : 'Save'}
              </Button>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

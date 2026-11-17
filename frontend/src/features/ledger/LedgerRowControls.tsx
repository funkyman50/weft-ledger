import { isComposingKey } from '../../lib/keyboard'
import { type ReactNode } from 'react'
import { HelpTooltip } from '../../components/HelpTooltip'
import { createLucideIcon, Link2, Merge } from 'lucide-react'

import { ApiError } from '../../api/client'
import type { AllowedAction, LedgerRow } from '../../api/types'
import { matchReviewMode, rowStateAction } from './rowPermissions'

const LEFT_HALF = { d: 'M10.6 1a8 8 0 0 0 0 16z', fill: 'currentColor', stroke: 'none' }
const RIGHT_HALF = { d: 'M13.4 7a8 8 0 0 1 0 16z', fill: 'currentColor', stroke: 'none' }
const PlaidMatchHalves = createLucideIcon('PlaidMatchHalves', [
  ['path', { ...LEFT_HALF, key: 'own' }],
  ['path', { ...RIGHT_HALF, opacity: '.4', key: 'partner' }],
])
const ManualMatchHalves = createLucideIcon('ManualMatchHalves', [
  ['path', { ...LEFT_HALF, opacity: '.4', key: 'partner' }],
  ['path', { ...RIGHT_HALF, key: 'own' }],
])

function allows(transaction: LedgerRow, action: AllowedAction): boolean {
  return transaction.allowed_actions.includes(action)
}

export function MatchButton({
  transaction,
  onOpen,
  onResolveLifecycle,
  onInspectConnections,
  disabled = false,
}: {
  transaction: LedgerRow
  onOpen: (transaction: LedgerRow) => void
  onResolveLifecycle: (transaction: LedgerRow) => void
  onInspectConnections: (transaction: LedgerRow) => void
  disabled?: boolean
}) {
  if (allows(transaction, 'pending_lifecycle')) {
    return (
      <button
        className="bp-match-button is-lifecycle"
        type="button"
        aria-label="Resolve pending transaction"
        title="Resolve pending transaction"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          event.currentTarget.focus({ preventScroll: true })
          onResolveLifecycle(transaction)
        }}
      >
        <Merge aria-hidden="true" />
      </button>
    )
  }

  if (matchReviewMode(transaction) === 'suggested') {
    return (
      <button
        className="bp-match-button is-suggested"
        type="button"
        aria-label="Possible match — review"
        title="Possible match — review"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          event.currentTarget.focus({ preventScroll: true })
          onOpen(transaction)
        }}
      >
        {transaction.source === 'plaid' ? <PlaidMatchHalves aria-hidden="true" /> : <ManualMatchHalves aria-hidden="true" />}
      </button>
    )
  }

  if (!allows(transaction, 'inspect_connections')) return <span className="bp-match-button-placeholder" aria-hidden="true" />
  return (
    <button
      className="bp-match-button is-linked"
      type="button"
      aria-label="Inspect connections"
      title="Inspect connections"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        onInspectConnections(transaction)
      }}
    >
      <Link2 aria-hidden="true" />
    </button>
  )
}

export function RowStateButton({
  transaction,
  onReview,
  onClearance,
  onError,
  onRequestAction,
  disabled = false,
  saving = false,
  onSavingAttempt,
}: {
  transaction: LedgerRow
  onReview: (id: number, approved: boolean) => Promise<void>
  onClearance: (transaction: LedgerRow) => Promise<void>
  onError: (message: string) => void
  onRequestAction: (action: (current: LedgerRow) => void) => void
  disabled?: boolean
  saving?: boolean
  onSavingAttempt?: () => void
}) {
  const action = rowStateAction(transaction)
  if (action === null) return <span className="bp-match-button-placeholder" aria-hidden="true" />
  const clearance = action === 'clearance'
  const cleared = transaction.status === 'cleared' || transaction.status === 'reconciled'
  const label = clearance
    ? cleared ? 'Mark transaction uncleared' : 'Mark transaction cleared'
    : transaction.approved ? 'Mark transaction as needing review' : 'Mark transaction reviewed'
  const toggle = async (current: LedgerRow) => {
    if (saving) { onSavingAttempt?.(); return }
    if (disabled) return
    try {
      if (rowStateAction(current) !== action) { onError('That transaction changed. Choose its current action.'); return }
      if (clearance) {
        if ((current.status === 'cleared' || current.status === 'reconciled') !== cleared) { onError('That transaction changed. Choose its current action.'); return }
        await onClearance(current)
      } else if (current.approved === transaction.approved) await onReview(current.id, !transaction.approved)
      else onError('That transaction changed. Choose its current action.')
    } catch (error) {
      onError(error instanceof ApiError ? error.message : clearance
        ? 'Transaction clearance could not be changed.'
        : 'Transaction review state could not be changed.')
    }
  }

  return (
    <button
      className={clearance ? `bp-clearance-button${cleared ? ' is-cleared' : ''}` : `bp-review-button ${transaction.approved ? 'is-reviewed' : 'needs-review'}`}
      type="button"
      aria-label={label}
      aria-pressed={clearance ? cleared : allows(transaction, 'clearance') ? undefined : transaction.approved}
      aria-busy={saving}
      aria-disabled={saving || undefined}
      title={clearance ? label : transaction.approved ? 'Reviewed — click to mark for review' : 'Mark reviewed'}
      disabled={disabled}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent) || ((event.key === 'Enter' || event.key === ' ') && event.repeat)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (event.detail > 1) return
        onRequestAction((current) => { void toggle(current) })
      }}
    >
      {clearance ? 'C' : 'R'}
    </button>
  )
}

function StatusHelp({ label, explanation }: { label: ReactNode; explanation: string }) {
  return <HelpTooltip className="bp-status-help" explanation={explanation}>{label}</HelpTooltip>
}

export function ManualClearStatus() {
  return <StatusHelp label={<>Cleared<span className="bp-manual-clear-asterisk">*</span></>} explanation="Manually cleared. Still pending at the bank." />
}

export function UnmatchedStatus({ cleared }: { cleared: boolean }) {
  return <StatusHelp label="Unmatched" explanation={`Unmatched. ${cleared ? 'Cleared' : 'Uncleared'} in Weft. No bank transaction has been matched.`} />
}

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { ApiError } from '../../api/client'
import type { AllowedAction, BankContinuityRecord, LedgerRow, RelationshipAction, TransactionConnectionsContext, TransferInspection } from '../../api/types'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { DialogHeader } from '../../components/DialogHeader'
import { money } from '../../lib/money'
import { LedgerSourceIcon } from './LedgerSourceIcon'
import { categoryLabel, dateLabel, flagDisplay, statusDisplay, statusLabel, valueLabel } from './transactionDisplay'

export interface TransactionConnectionsDialogProps {
  context: TransactionConnectionsContext
  onClose: () => void
  onCorrectRelationship: (action: RelationshipAction) => Promise<void>
}

const BANK_HISTORY_HOPS = 2

function bankHistoryChain(context: TransactionConnectionsContext): Array<{ record: BankContinuityRecord; source: LedgerRow }> {
  const chain: Array<{ record: BankContinuityRecord; source: LedgerRow }> = []
  let current = context.representative_id
  for (let hop = 0; hop < BANK_HISTORY_HOPS; hop += 1) {
    const record = context.records.find((candidate) => candidate.target_transaction_id === current)
    const source = record ? context.sources.find((row) => row.id === record.source_transaction_id) : undefined
    if (!record || !source) break
    chain.push({ record, source })
    current = record.source_transaction_id
  }
  return chain.reverse()
}

function bankColumnLabel(row: LedgerRow): string {
  if (row.source === 'manual') return 'Manual'
  return row.source === 'plaid' && (row.status === 'cleared' || row.status === 'reconciled') ? `Plaid ${statusLabel(row)}` : statusLabel(row)
}

function abbreviate(label: string): string {
  const name = label.startsWith('Transfer · ') ? label.slice('Transfer · '.length) : label.split(' · ')[0]
  return name.replace(/^Plaid /, '').split(/\s+/).map((word) => word.charAt(0)).join('').concat(label.endsWith('?') ? '?' : '').slice(0, 3)
}

export interface SourceColumn {
  key: string
  label?: string
  title?: string
  row: LedgerRow
}

function earlierColumns(context: TransactionConnectionsContext | undefined): SourceColumn[] {
  if (!context) return []
  return bankHistoryChain(context).map(({ source }) => ({
    key: `bank-${source.id}`,
    row: source,
    title: context.actions.find((action) => action.kind === 'bank' && action.source_id === source.id)?.evidence,
  }))
}

function transferColumns(transfer: TransferInspection | null | undefined): SourceColumn[] {
  return transfer?.partner ? [{ key: 'transfer', label: `Transfer · ${transfer.account_name}`, row: transfer.partner }] : []
}

function columnLabel(column: SourceColumn): string {
  return column.label ?? bankColumnLabel(column.row)
}

export interface SourceGridRow {
  key: string
  label: string
  cell: (row: LedgerRow, column: SourceColumn) => ReactNode
  lockedTo?: string
  differs?: boolean
  choice?: {
    name: string
    selectable: Set<string>
    selected: string | null
    disabled: boolean
    onChange: (columnKey: string) => void
  }
}

export function SourceGrid({ ariaLabel, columns: ownColumns, rows, earlier, transfer, endColumn, disabled = false }: {
  ariaLabel: string
  columns: SourceColumn[]
  rows: SourceGridRow[]
  earlier?: TransactionConnectionsContext
  transfer?: TransferInspection | null
  endColumn?: string
  disabled?: boolean
}) {
  const groupId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const columns = [...earlierColumns(earlier), ...ownColumns, ...transferColumns(transfer)]
  const columnKeys = columns.map((column) => `${column.key}:${column.row.id}`).join('|')
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const end = endColumn ? scroll.querySelector<HTMLElement>(`[data-column="${endColumn}"]`) : null
    scroll.scrollLeft = end
      ? scroll.scrollLeft + end.getBoundingClientRect().right - scroll.getBoundingClientRect().right
      : scroll.scrollWidth
  }, [columnKeys, endColumn])
  const collapsedCount = columns.filter((column) => collapsed.has(column.key)).length
  const expandedShare = Math.min(2, Math.max(1, columns.length - collapsedCount))
  const expandedWidth = `calc((100cqw - 93px - ${collapsedCount * 36}px) / ${expandedShare})`
  const template = columns.map((column) => collapsed.has(column.key) ? '36px' : expandedWidth).join(' ')
  const toggle = (key: string) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const isCollapsed = (column: SourceColumn) => collapsed.has(column.key)
  const headingTitle = (column: SourceColumn) => {
    const toggleText = `${isCollapsed(column) ? 'Expand' : 'Collapse'} ${columnLabel(column)}`
    return column.title ? `${column.title}\n${toggleText}` : toggleText
  }
  return <div className="bp-compare-grid" role="group" aria-label={ariaLabel}>
    <div className="bp-compare-fields">
      <div className="bp-compare-row bp-compare-heading"><span className="bp-compare-field">Field</span></div>
      {rows.map((row) => <div key={row.key} className={`bp-compare-row${row.lockedTo ? ' is-locked' : ''}`}>
        <span className="bp-compare-field" id={`${groupId}-${row.key}-label`}>
          {row.lockedTo && <span className="bp-compare-lock" aria-label={`${row.label} is ${row.lockedTo}`}><Lock aria-hidden="true" /></span>}
          {row.label}
        </span>
      </div>)}
    </div>
    <div ref={scrollRef} className="bp-compare-scroll">
      <div className="bp-compare-table" style={{ '--bp-compare-columns': template } as CSSProperties}>
        <div className="bp-compare-row bp-compare-heading">
          {columns.map((column) => <span key={column.key} data-column={column.key} className={`bp-compare-cell bp-compare-column${isCollapsed(column) ? ' is-collapsed' : ''}`}>
            <button type="button" className="bp-compare-column-title" aria-expanded={!isCollapsed(column)} title={headingTitle(column)} disabled={disabled} onClick={() => toggle(column.key)}>
              <LedgerSourceIcon source={column.row.source === 'plaid' ? 'plaid' : 'manual'} />
              <strong>{isCollapsed(column) ? abbreviate(columnLabel(column)) : columnLabel(column)}</strong>
            </button>
          </span>)}
        </div>
        {rows.map((row) => {
          const rowId = `${groupId}-${row.key}`
          return <div key={row.key} className={`bp-compare-row${row.lockedTo ? ' is-locked' : ''}${row.differs ? ' is-different' : ''}`} role="group" aria-labelledby={`${rowId}-label`}>
            {columns.map((column) => {
              const selectable = row.choice?.selectable.has(column.key) ?? false
              const content = isCollapsed(column) ? <span className="bp-compare-collapsed" aria-hidden="true">·</span> : row.cell(column.row, column)
              if (!selectable || !row.choice) return <span key={column.key} className={`bp-compare-cell${isCollapsed(column) ? ' is-collapsed' : ''}`}>{content}</span>
              const inputId = `${rowId}-${column.key}`
              return <label key={column.key} className={`bp-compare-cell bp-compare-choice${isCollapsed(column) ? ' is-collapsed' : ''}`} htmlFor={inputId}>
                <input id={inputId} type="radio" name={rowId} aria-label={`Use ${columnLabel(column)} ${row.label}`} checked={row.choice.selected === column.key} disabled={row.choice.disabled || disabled} onChange={() => row.choice?.onChange(column.key)} />
                {content}
              </label>
            })}
          </div>
        })}
      </div>
    </div>
  </div>
}

const ACTION_PERMISSION: Record<RelationshipAction['kind'], AllowedAction> = {
  bank: 'bank_continuity',
  match: 'unmatch',
  transfer: 'unlink_transfer',
}

function actionKey(action: RelationshipAction): string {
  return `${action.kind}-${action.id}-${action.source_id}-${action.target_id}`
}

function actionName(action: RelationshipAction): string {
  return action.kind === 'transfer' ? 'Unlink Transfer' : `Unmatch ${action.source_label} from ${action.target_label}`
}

function orderedActions(actions: RelationshipAction[]): RelationshipAction[] {
  const bank = actions.filter((action) => action.kind === 'bank')
  const earliest = bank.find((action) => !bank.some((other) => other.target_id === action.source_id))
  const chain = earliest ? [earliest, ...bank.filter((action) => action !== earliest)] : bank
  return [...chain, ...actions.filter((action) => action.kind === 'match'), ...actions.filter((action) => action.kind === 'transfer')]
}

export function RelationshipControls({ actions, representative, onAction, disabled, onBusyChange }: {
  actions: RelationshipAction[]
  representative: LedgerRow
  onAction: (action: RelationshipAction) => Promise<void>
  disabled: boolean
  onBusyChange: (busy: boolean) => void
}) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  const cancelRef = useRef<HTMLButtonElement>(null)
  const permitted = orderedActions(actions).filter((action) => representative.allowed_actions.includes(ACTION_PERMISSION[action.kind]))
  const open = permitted.find((action) => actionKey(action) === openKey) ?? null
  useEffect(() => { if (openKey) cancelRef.current?.focus() }, [openKey])
  if (!permitted.length) return null

  const cancel = () => {
    const key = openKey
    setOpenKey(null)
    setError(null)
    requestAnimationFrame(() => { if (key) triggers.current.get(key)?.focus({ preventScroll: true }) })
  }
  const confirm = async () => {
    if (!open || busy) return
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      await onAction(open)
    } catch (caught) {
      setError(caught instanceof ApiError && ['history_expired', 'history_epoch_stale', 'history_recovery_required'].includes(caught.code)
        ? 'Your register session changed. Try again after the register refreshes.'
        : caught instanceof Error ? caught.message : 'The relationship could not be changed.')
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }

  return <div className="bp-relationship-actions">
    <div className="bp-relationship-controls">
      {permitted.map((action) => {
        const key = actionKey(action)
        return <Button key={key} ref={(element) => { if (element) triggers.current.set(key, element); else triggers.current.delete(key) }}
          size="md" variant="danger" aria-expanded={openKey === key} disabled={disabled || busy || (openKey !== null && openKey !== key)}
          onClick={() => { setError(null); setOpenKey(key) }}>
          {actionName(action)}
        </Button>
      })}
    </div>
    {open && <div className="bp-callout bp-callout--danger" role="group" aria-label={actionName(open)}>
      <strong>{actionName(open)}?</strong>
      {open.evidence && <p>{open.evidence}</p>}
      <p>{open.consequence}</p>
      {error && <p className="bp-relationship-error" role="alert">{error}</p>}
      <div className="bp-callout-actions">
        <Button ref={cancelRef} size="md" disabled={busy} onClick={cancel}>Cancel</Button>
        <Button size="md" variant="danger" busy={busy} disabled={busy || disabled} onClick={() => void confirm()}>
          {busy ? (open.kind === 'transfer' ? 'Unlinking…' : 'Unmatching…') : open.kind === 'transfer' ? 'Unlink' : 'Unmatch'}
        </Button>
      </div>
    </div>}
  </div>
}

const bankReadOnlyRows: SourceGridRow[] = [
  { key: 'date', label: 'Date', cell: (row) => dateLabel(row.date) },
  { key: 'description', label: 'Description', cell: (row) => valueLabel(row.description) },
  { key: 'payee', label: 'Payee', cell: (row) => valueLabel(row.payee_name) },
  { key: 'category', label: 'Category', cell: (row) => categoryLabel(row) },
  { key: 'memo', label: 'Memo', cell: (row) => valueLabel(row.memo) },
  { key: 'flag', label: 'Flag', cell: (row) => flagDisplay(row.flag) },
  { key: 'amount', label: 'Amount', cell: (row) => money(row.amount_cents) },
  { key: 'status', label: 'Status', cell: (row) => statusDisplay(row) },
]

export function TransactionConnectionsDialog({ context, onClose, onCorrectRelationship }: TransactionConnectionsDialogProps) {
  const [busy, setBusy] = useState(false)
  const original = context.sources.find((row) => row.id === context.representative_id) ?? context.representative
  const shown = [...context.sources, ...(context.transfer?.partner ? [context.transfer.partner] : [])]
  const rows = bankReadOnlyRows.filter((row) => row.key !== 'flag' || shown.some((source) => source.flag !== null))
  const actions = [...context.actions, ...(context.transfer ? [context.transfer.action] : [])]

  return <Modal size="lg" labelledBy="transaction-connections-title" onRequestClose={() => { if (!busy) onClose() }}>
    <DialogHeader titleId="transaction-connections-title" title="Transaction connections" subtitle={`Records connected to this ${context.account_name} transaction.`} onClose={onClose} closeDisabled={busy} />
    <div className="bp-dialog-body bp-match-body">
      <SourceGrid ariaLabel="Connected records compared by field" columns={[{ key: `bank-${original.id}`, label: `${bankColumnLabel(original)} · ${context.account_name}`, row: original }]} rows={rows}
        earlier={context} transfer={context.transfer} endColumn={`bank-${original.id}`} disabled={busy} />
      {context.transfer?.unavailable_reason && <p className="bp-note">{context.transfer.unavailable_reason}</p>}
      <RelationshipControls actions={actions} representative={context.representative} onAction={onCorrectRelationship} disabled={busy} onBusyChange={setBusy} />
    </div>
    <div className="bp-dialog-footer">
      <Button size="lg" onClick={onClose} disabled={busy}>Close</Button>
    </div>
  </Modal>
}

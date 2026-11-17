import { useQuery } from '@tanstack/react-query'
import { accountInScope, appendAccountScope, isCombinedScope, type AccountScope } from '../../lib/accountScope'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Cell,
  type CellContext,
  type ColumnSizingState,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowRightLeft, ArrowUp, Funnel, FunnelX, Info, ListOrdered, ListSortAscending, RotateCcw } from 'lucide-react'
import { ApiError, apiClient } from '../../api/client'
import { useUnlinkTransfer } from '../../api/hooks'
import { Button } from '../../components/Button'
import { FilterSelect, type FilterSelectOption } from '../../components/FilterSelect'
import { usePickerPosition } from '../../components/pickerPosition'
import type {
  Account,
  CategoryTree,
  Payee,
  LedgerRow,
  LedgerFilterChoices,
  BulkTransferQueueStart,
  LedgerHistoryOutcome,
  TransactionConnectionsContext,
  TransferReviewProposal,
} from '../../api/types'
import { formatCents, money } from '../../lib/money'
import { isComposingKey } from '../../lib/keyboard'
import { ledgerPayeeOptions } from './payeeCategory'
import {
  LedgerAmountInput,
  LedgerEditorActions,
  LedgerCategoryPicker,
  LedgerDatePicker,
  LedgerDirectionalAmountInput,
  LedgerMemoInput,
  LedgerOptionPicker,
  LedgerTransferPicker,
  NewEntryExitDialog,
} from './LedgerEditors'
import { matchReviewMode } from './rowPermissions'
import { clickedLedgerCell, enterLedgerCell, focusEntryField, focusNextLedgerCell, useCleanEditorDismiss, useEditorClickAway, type LedgerCellTarget } from './ledgerFocus'
import { LedgerSourceIcon, type LedgerSource } from './LedgerSourceIcon'
import { TransferPopover } from './TransferPopover'
import type { MatchDialogMode } from './MatchDialog'
import { TransactionFlagPicker } from './TransactionFlagPicker'
import { emptyCell, chronologyRank, compareChronology, compareDefaultLedgerRows, defaultBalanceCutoff, ledgerDisplayGroup, statusDisplay, statusLabel as transactionStatusLabel, transferDirection } from './transactionDisplay'
import {
  MatchButton,
  RowStateButton,
  UnmatchedStatus,
} from './LedgerRowControls'
import { LedgerContextMenu } from './LedgerContextMenu'
import {
  COLUMN_FILTER_KEYS,
  COLUMN_FILTER_LABELS,
  hasLedgerFilter,
  type AmountRangeFilter,
  type LedgerFilterKey,
  type LedgerFilters,
  type LedgerFilterValue,
  hasValueSelection, valueSelected, allocationCategoryKey, selectionSummary, statusSummary,
} from './ledgerFilters'
import { LedgerCheckboxFilter, type FilterChoice } from './LedgerCheckboxFilter'
import { parseLedgerAmount, type LedgerDisplayRow, type EditorTransferIntent, type useLedgerEditor } from './useLedgerEditor'
import { useBulkApply } from './useBulkApply'
import { LedgerBulkToolbar } from './LedgerBulkToolbar'
import { LedgerSplitEditor } from './LedgerSplitEditor'
import { nativeLedgerShortcutOwner, type LedgerHistoryGuard } from './useLedgerHistory'
import { useLedgerSelection } from './useLedgerSelection'
import { useLedgerScroll } from './useLedgerScroll'
import { isRowControl, rowKeyAction, selectionGesture } from './ledgerSelection'
import { STAGED_CHANGES_NOTICE } from './LedgerBulkControls'
import { LedgerColumnsMenu, type LedgerColumnsChange } from './LedgerColumnsMenu'

const LEDGER_ROW_HEIGHT = 27
const FLEX_COLUMN_LAYOUT: Record<string, { weight: number; minWidth: number }> = {
  account: { weight: 150, minWidth: 120 },
  payee: { weight: 144, minWidth: 110 },
  transfer: { weight: 170, minWidth: 140 },
  description: { weight: 240, minWidth: 160 },
  category: { weight: 130, minWidth: 130 },
  memo: { weight: 190, minWidth: 120 },
}

function displayAmount(cents: number, signed = true): string {
  if (Math.abs(cents) < 100_000_000) return money(signed ? cents : Math.abs(cents), signed)
  const value = `$${Math.abs(Math.round(cents / 100)).toLocaleString('en-US')}`
  return signed ? cents < 0 ? `−${value}` : `+${value}` : value
}

function displayDate(value: string, formatter: Intl.DateTimeFormat): string {
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? date.toString() : formatter.format(date)
}

function transactionSource(transaction: LedgerDisplayRow): LedgerSource {
  if (transaction.source === 'starting_balance') return 'balance'
  if (transaction.source === 'manual') return 'manual'
  return 'plaid'
}

function isPinnedTransaction(transaction: LedgerDisplayRow): boolean {
  return 'is_draft' in transaction ? false : transaction.pinned
}

function statusLabel(transaction: LedgerDisplayRow): string {
  if (transaction.missing_pending) return 'Pending?'
  if (isPinnedTransaction(transaction)) return 'Unmatched'
  return transactionStatusLabel(transaction)
}

const MISSING_PENDING_TOOLTIP = 'Plaid stopped reporting this pending transaction. It remains visible but is excluded from Working Balance while awaiting a posted replacement.'

const DisplayCell = memo(({ cell, render }: {
  cell: Cell<LedgerDisplayRow, unknown>
  render: ColumnDef<LedgerDisplayRow>['cell']
}) => {
  // Cell templates must be hook-free render callbacks so stable components persist and controls are not replaced mid-click.
  return typeof render === 'function' ? render(cell.getContext()) : render ?? null
})

const TRANSFER_STATE_LABELS = { linked: 'Linked', unlinked: 'Unlinked', attention: 'Needs review' } as const

function TransferTarget({ amountCents, accountName, state }: { amountCents: number; accountName: string; state?: keyof typeof TRANSFER_STATE_LABELS }) {
  return <span className="bp-transfer-target"><span className="bp-transfer-arrow" aria-hidden="true">{amountCents < 0 ? '→' : amountCents > 0 ? '←' : '⇄'}</span><span className="bp-transfer-account">{accountName}</span>{state && <span className={`bp-transfer-state is-${state}`}>{TRANSFER_STATE_LABELS[state]}</span>}</span>
}

function TransferBadge({ row, blocked, onJump, onUnlink, onRequestOpen, cell = false }: { onRequestOpen: (open: () => void) => void; row: LedgerRow; blocked: boolean; cell?: boolean; onJump: () => void; onUnlink: (context: TransactionConnectionsContext) => Promise<void> }) {
  const [context, setContext] = useState<TransactionConnectionsContext | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!row.transfer) return null
  const transfer = row.transfer
  const inspect = () => {
    setConfirming(false)
    setError(null)
    setContext(null)
    if (!row.allowed_actions.includes('unlink_transfer') && transfer.state !== 'linked') return
    void apiClient.get<TransactionConnectionsContext>(`/api/transactions/connections/context?transaction_id=${row.id}`)
      .then(setContext).catch((caught) => setError(caught instanceof Error ? caught.message : 'Transfer details could not be loaded.'))
  }
  return <TransferPopover onRequestOpen={onRequestOpen} triggerLabel={cell ? `${transferDirection(row.amount_cents)} ${transfer.account_name}; ${TRANSFER_STATE_LABELS[transfer.state]}` : `Transfer with ${transfer.account_name}; ${transfer.state}`} trigger={cell ? <TransferTarget amountCents={row.amount_cents} accountName={transfer.account_name} state={transfer.state} /> : undefined} triggerTitle={cell && transfer.attention_reasons.length ? transfer.attention_reasons.join(' · ') : undefined} direction={transferDirection(row.amount_cents)} accountName={transfer.account_name} tone={transfer.state} busy={busy} focusKey={context} onOpen={inspect}>{(close) => <>
    {transfer.state !== 'linked' && <p>{transfer.state === 'attention' ? transfer.attention_reasons.join(' ') : `No transaction in ${transfer.account_name} is linked to this one.`}</p>}
    {error && <p className="bp-transfer-popover-error" role="alert">{error}</p>}
    {(context?.transfer?.partner || row.allowed_actions.includes('unlink_transfer') && context?.transfer) && <div className={`bp-transfer-popover-actions${confirming ? ' is-confirming' : ''}`}>
      {confirming && context?.transfer ? <><p className="bp-callout bp-callout--danger">{context.transfer.action.consequence}</p><Button size="md" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button><Button size="md" variant="danger" busy={busy} disabled={blocked} onClick={() => { setBusy(true); void onUnlink(context).then(() => close()).catch((caught) => setError(caught instanceof Error ? caught.message : 'Unlink failed.')).finally(() => setBusy(false)) }}>Unlink</Button></> : <>
        {context?.transfer?.partner && <Button size="md" onClick={() => { close(false); onJump() }}>Jump To</Button>}
        {row.allowed_actions.includes('unlink_transfer') && context?.transfer && <Button size="md" variant="danger" disabled={blocked} onClick={() => setConfirming(true)}>Unlink</Button>}
      </>}
    </div>}
  </>}</TransferPopover>
}

interface LedgerTableProps {
  accountId: AccountScope
  accounts: Account[]
  usesPlaidWorkflow: boolean
  separateAmountColumns: boolean
  showRunningBalance: boolean
  onShowRunningBalanceChange: (enabled: boolean) => void
  onSeparateAmountColumnsChange: (enabled: boolean) => void
  balanceAvailable: boolean
  showBankDescription: boolean
  onShowBankDescriptionChange: (enabled: boolean) => void
  showTransferColumn: boolean
  onShowTransferColumnChange: (enabled: boolean) => void
  locked?: boolean
  transactions: LedgerDisplayRow[]
  allCount: number
  filteredCount: number
  pending: boolean
  payees: Payee[]
  categories: CategoryTree[]
  height: number
  hasMore: boolean
  loadingOlder: boolean
  editorSession: ReturnType<typeof useLedgerEditor>
  stateCommandsBlocked: boolean
  onMakeRecurring: (row: LedgerRow) => void
  onDuplicate: (source: LedgerRow) => void
  onStartTransferQueue: (start: BulkTransferQueueStart) => void
  onStartFindTransferQueue: (entries: Array<{ id: number; edit_token: string }>) => void
  writePending: boolean
  aggregatePending: boolean
  commandRecoveryActive: boolean
  pendingRowIds: Set<number>
  transientBusy: boolean
  onRefreshAfterApply: (originViewKey: string, reviewed: boolean) => Promise<boolean>
  queryReadVersion: number
  onReadSelection: (signal?: AbortSignal) => Promise<LedgerRow[]>
  onBulkStagedChange: (staged: boolean) => void
  onSelectionChange: (selected: boolean) => void
  scheduleSelected: boolean
  blockedBySchedule: boolean
  selectionSlotRef: (element: HTMLDivElement | null) => void
  onLoadOlder: () => Promise<boolean>
  onError: (message: string) => void
  onOpenMatch: (mode: MatchDialogMode, bank: LedgerRow, history: LedgerRow) => void
  onFindMatch: (source: LedgerRow) => void
  onOpenLifecycle: (pending: LedgerRow) => void
  onOpenTransfer: (source: LedgerRow, proposal?: TransferReviewProposal) => void
  onEditPayee: (id: number) => void
  onEditorTransfer: (intent: EditorTransferIntent) => void
  onInspectConnections: (source: LedgerRow) => void
  onGoToTransfer: (source: LedgerRow) => void
  lifecyclePickerPending: LedgerRow | null
  onChooseLifecycleCleared: (cleared: LedgerRow) => void
  onCancelLifecyclePicker: () => void
  matchResetKey: number
  viewKey: string
  selectionKey: string
  filterViewGeneration: number
  filters: LedgerFilters
  onFilterChange: (key: LedgerFilterKey, value: LedgerFilterValue) => void
  onRequestWorkspaceAction: (action: () => void) => void
  revealTransactionId?: number | null
  revealAccountId?: number | null
  onRevealComplete?: (found: boolean) => void
  onRevealProgress?: () => void
  onCancelReveal?: () => void
  onHistoryGuardChange: (guard: LedgerHistoryGuard) => void
  onInspectHistory: () => Promise<unknown>
  historyRecoveryOutcome: LedgerHistoryOutcome | null
  renderFooter: (summary: { count: number; totalCents: number | null }) => ReactNode
}

type EntryTarget = 'keyboard' | LedgerCellTarget

interface EditorFocusTarget {
  id: number
  isNew: boolean
  entryOrigin?: 'transaction' | 'transfer'
}

interface MatchPair {
  bank: LedgerRow
  history: LedgerRow
}

function ColumnFilterPopover({
  accountId,
  filterKey,
  label,
  value,
  anchor,
  onApply,
  onClose,
}: {
  accountId: AccountScope | null
  filterKey: Exclude<LedgerFilterKey, 'payee' | 'category' | 'status'>
  label: string
  value: string | AmountRangeFilter
  anchor: HTMLElement
  onApply: (value: string | AmountRangeFilter) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(typeof value === 'string' ? value : '')
  const [amountDraft, setAmountDraft] = useState<AmountRangeFilter>(
    typeof value === 'string' ? { minimum: '', maximum: '' } : value,
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef(anchor)
  triggerRef.current = anchor
  const popupRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const textField = filterKey === 'description' || filterKey === 'memo' ? filterKey : null
  const [term, setTerm] = useState('')
  useEffect(() => {
    const handle = window.setTimeout(() => setTerm(draft.trim()), 250)
    return () => window.clearTimeout(handle)
  }, [draft])
  const suggestionQuery = useQuery({
    queryKey: ['transactions', 'filter-suggestions', accountId, textField, term],
    enabled: textField !== null && accountId !== null && term !== '',
    retry: false,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ field: textField!, q: term })
      appendAccountScope(params, accountId)
      return apiClient.get<{ values: string[] }>(`/api/transactions/filter-suggestions?${params}`, signal)
    },
  })
  const suggestions = term === draft.trim() ? (suggestionQuery.data?.values ?? []).filter((suggestion) => suggestion !== term) : []

  const optionPairs = filterKey === 'source'
    ? [
        ['all_active', 'All'],
        ['excluded', 'Excluded bank imports'],
        ['all_sources', 'All sources'],
        ['plaid', 'Plaid'],
        ['manual', 'Manual'],
        ['starting_balance', 'Starting balance'],
      ]
    : filterKey === 'range'
      ? [
          ['all', 'All dates'],
          ['this_month', 'This month'],
          ['latest_3_months', 'Latest 3 months'],
          ['this_year', 'This year'],
        ]
      : null
  const options: FilterSelectOption[] | null = optionPairs?.map(([optionValue, optionLabel]) => ({
    value: optionValue,
    label: optionLabel,
  })) ?? null

  const popoverWidth = filterKey === 'amount' ? 250 : filterKey === 'source' || filterKey === 'range' ? 170 : 214
  const position = usePickerPosition(true, triggerRef, popupRef, popoverWidth)

  return createPortal(
    <form
      ref={popupRef}
      className="bp-column-filter-popover"
      aria-label={`${label} filter`}
      style={position}
      onSubmit={(event) => {
        event.preventDefault()
        onApply(filterKey === 'amount' ? amountDraft : draft)
        onClose()
      }}
    >
      <strong>Filter {label}</strong>
      {filterKey === 'amount' ? (
        <><small className="bp-column-filter-help">Negative amounts are outflows; positive amounts are inflows.</small><div className="bp-amount-filter-range">
          <label>
            <span>Minimum</span>
            <input
              ref={inputRef}
              aria-label="Minimum amount"
              type="number"
              step="0.01"
              value={amountDraft.minimum}
              inputMode="decimal"
              placeholder="No minimum"
              onChange={(event) => setAmountDraft((current) => ({ ...current, minimum: event.target.value }))}
            />
          </label>
          <label>
            <span>Maximum</span>
            <input
              aria-label="Maximum amount"
              type="number"
              step="0.01"
              value={amountDraft.maximum}
              inputMode="decimal"
              placeholder="No maximum"
              onChange={(event) => setAmountDraft((current) => ({ ...current, maximum: event.target.value }))}
            />
          </label>
        </div></>
      ) : options ? (
        <FilterSelect
          ariaLabel={`Filter ${label} value`}
          value={draft}
          options={options}
          onChange={setDraft}
        />
      ) : (
        <input
          ref={inputRef}
          aria-label={`Filter ${label} value`}
          type="text"
          value={draft}
          placeholder="Contains text"
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {suggestions.length > 0 && (
        <div className="bp-filter-suggestions" role="group" aria-label={`${label} suggestions`}>
          {suggestions.map((suggestion) => (
            <button key={suggestion} type="button" className="bp-filter-suggestion" title={suggestion} onClick={() => { setDraft(suggestion); inputRef.current?.focus() }}>
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <div className="bp-column-filter-actions">
        <Button size="md" onClick={() => { onApply(filterKey === 'amount' ? { minimum: '', maximum: '' } : filterKey === 'source' ? 'all_active' : filterKey === 'range' ? 'all' : ''); onClose() }}>Clear</Button>
        <Button size="md" variant="primary" type="submit">Apply</Button>
      </div>
    </form>,
    document.body,
  )
}

function selectedMatchPair(transactions: LedgerRow[]): MatchPair | null {
  if (transactions.length !== 2) return null
  const bank = transactions.find((transaction) => transaction.match_role === 'feed')
  const planned = transactions.find((transaction) => transaction.match_role === 'history')
  if (!bank || !planned || !bank.allowed_actions.includes('find_match') || !planned.allowed_actions.includes('find_match') || bank.account_id !== planned.account_id || bank.amount_cents !== planned.amount_cents) return null
  return { bank, history: planned }
}

export function LedgerRegisterTable({
  accountId,
  accounts,
  usesPlaidWorkflow,
  separateAmountColumns,
  showRunningBalance: showRunningBalancePreference,
  onShowRunningBalanceChange,
  onSeparateAmountColumnsChange,
  balanceAvailable,
  showBankDescription,
  onShowBankDescriptionChange,
  showTransferColumn,
  onShowTransferColumnChange,
  locked = false,
  transactions,
  allCount,
  filteredCount,
  pending,
  payees,
  categories,
  height,
  hasMore,
  loadingOlder,
  editorSession,
  stateCommandsBlocked,
  onDuplicate,
  onMakeRecurring,
  onStartTransferQueue,
  onStartFindTransferQueue,
  writePending,
  aggregatePending,
  commandRecoveryActive,
  pendingRowIds,
  transientBusy,
  onRefreshAfterApply,
  queryReadVersion,
  onReadSelection,
  onBulkStagedChange,
  onSelectionChange,
  scheduleSelected,
  blockedBySchedule,
  selectionSlotRef,
  onLoadOlder,
  onError: onTableError,
  onOpenMatch,
  onFindMatch,
  onOpenLifecycle,
  onOpenTransfer,
  onEditPayee,
  onEditorTransfer,
  onInspectConnections,
  onGoToTransfer,
  lifecyclePickerPending,
  onChooseLifecycleCleared,
  onCancelLifecyclePicker,
  matchResetKey,
  viewKey,
  selectionKey,
  filterViewGeneration,
  filters,
  onFilterChange,
  onRequestWorkspaceAction,
  revealTransactionId,
  revealAccountId,
  onRevealComplete,
  onRevealProgress,
  onCancelReveal,
  onHistoryGuardChange,
  onInspectHistory,
  historyRecoveryOutcome,
  renderFooter,
}: LedgerTableProps) {
  const showRunningBalance = showRunningBalancePreference && balanceAvailable
  const [sorting, setSorting] = useState<SortingState>([])
  const defaultSorting = sorting.length === 0
  const chronologicalSorting = sorting[0]?.id === 'date'
  const balanceDescription = `Balances are calculated by date across full account history, including pending and planned transactions. ${defaultSorting && usesPlaidWorkflow
    ? 'Pending and unmatched manual balances are muted. When status grouping moves an earlier contributing entry below later entries, balances from that entry onward are also muted. An amber line marks the first affected loaded balance. These cues use displayed entries; filters can hide other contributions.'
    : defaultSorting || chronologicalSorting
      ? 'Filters and same-date secondary sorts can prevent adjacent rows from adding up.'
      : 'Balances are muted because rows are sorted by another column rather than Date. The values remain correct.'}`
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
  const resizedColumnIdsRef = useRef(new Set<string>())
  const [gridWidth, setGridWidth] = useState(0)
  const [resizingColumnId, setResizingColumnId] = useState<string | null>(null)
  const {
    editing, editingRef, splitDraft, splitDraftRef, splitHasChanges,
    ordinaryEditorDirty, ordinaryEditorHasWork,
    cancelEditing, beginEditing: beginEditorSession, patchEditing: updateDraft,
    requestExit: requestEditorExit, entryExit, startSplit, changeSplit, saveSplit: saveEditorSplit,
    reloadSplit, unsplitDraft, chooseCategory, choosePayee, chooseTransfer, createQuickPayee, recoverQuickCreate,
    clearQuickCreateError, quickCreatePending, quickCreateRecovery, quickCreateError, quickCreateBlocked,
    editTransactionId, finishEditing: onEditStarted, newEntryReveal, completeNewEntryReveal, navigationRevisionRef,
    update: onUpdate, moveMany: onMoveMany, deleteMany: onDeleteMany,
    exclude: onExclude, restore: onRestore, manualClearance: onManualClearance,
    review: onReview, bulkApply: onBulkApply, toggleClearance: onToggleClearance,
  } = editorSession
  const [splitRecoveryReloading, setSplitRecoveryReloading] = useState(false)
  const [splitRecoveryActive, setSplitRecoveryActive] = useState(false)
  const [expandedSplitIds, setExpandedSplitIds] = useState<Set<number>>(() => new Set())
  const [focusedRowId, setFocusedRowId] = useState<number | null>(null)
  const [payeeEntry, setPayeeEntry] = useState<{ id: number; transaction: LedgerDisplayRow; origin: Element | null; generation: number; request: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ rows: LedgerRow[]; left: number; top: number; focusId: number } | null>(null)
  const [revealedTransactionId, setRevealedTransactionId] = useState<number | null>(null)
  const [openFilter, setOpenFilter] = useState<{ columnId: string; anchor: HTMLElement } | null>(null)
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false)
  const [pendingShortcutSelection, setPendingShortcutSelection] = useState<string | null>(null)
  const appliedRecoveryRef = useRef<string | null>(null)
  const gridShellRef = useRef<HTMLDivElement>(null)
  const filterReturnFocusRef = useRef<{ columnId: string; accountId: AccountScope; generation: number; anchor: HTMLElement } | null>(null)
  const ledgerShortcutBoundaryRef = useRef<HTMLDivElement>(null)
  const initializedViewRef = useRef<string | null>(null)
  const loadingOlderRef = useRef(false)
  const { onScroll: onLedgerScroll, resetToBottom, revealRow } = useLedgerScroll({ shellRef: gridShellRef, viewKey, ready: !pending, navigationRevisionRef })
  const cancelPendingReveals = useCallback(() => {
    completeNewEntryReveal(null)
    onCancelReveal?.()
  }, [completeNewEntryReveal, onCancelReveal])
  const previousSelectionControlsRef = useRef<{ viewKey: string; hasSelection: boolean; canExpand: boolean } | null>(null)
  const entryFocusRef = useRef<{ id: number; target: EntryTarget } | null>(null)
  const newComposerFocusRef = useRef<number | null>(null)
  const keyboardRestoreRef = useRef<EditorFocusTarget | null>(null)
  const selectionHandoffRequestRef = useRef(0)
  const shortcutSelectionActionRef = useRef<() => void>(() => {})
  const filterViewGenerationRef = useRef(filterViewGeneration)
  filterViewGenerationRef.current = filterViewGeneration
  const mountedRef = useRef(true)
  const transferRevealRequestRef = useRef<{ id: number | null; revision: number }>({ id: null, revision: 0 })
  useLayoutEffect(() => {
    transferRevealRequestRef.current = { id: revealTransactionId ?? null, revision: navigationRevisionRef.current }
  }, [navigationRevisionRef, revealAccountId, revealTransactionId])
  const loadOlderAtTop = useCallback(async () => {
    const shell = gridShellRef.current
    if (!shell || shell.scrollTop > LEDGER_ROW_HEIGHT * 2 || !hasMore || loadingOlderRef.current) return
    const requestGeneration = filterViewGeneration
    loadingOlderRef.current = true
    try {
      await onLoadOlder()
    } finally {
      if (filterViewGenerationRef.current === requestGeneration) loadingOlderRef.current = false
    }
  }, [filterViewGeneration, hasMore, onLoadOlder])
  const onError = useCallback((message: string) => {
    if (mountedRef.current && filterViewGenerationRef.current === filterViewGeneration) onTableError(message)
  }, [filterViewGeneration, onTableError])
  const invalidateSelectionHandoff = useCallback(() => {
    selectionHandoffRequestRef.current += 1
    setPendingShortcutSelection(null)
  }, [])
  const restoreGridFocusIfBody = useCallback(() => {
    if (document.activeElement === document.body) gridShellRef.current?.focus({ preventScroll: true })
  }, [])
  const persistedTransactions = useMemo(() => transactions.filter((transaction): transaction is LedgerRow => !('is_draft' in transaction)), [transactions])
  const transactionsRef = useRef(transactions)
  transactionsRef.current = transactions
  const ledgerOrderRef = useRef<number[]>([])
  const selection = useLedgerSelection({
    viewKey: selectionKey,
    loadedRows: persistedTransactions,
    filteredCount,
    readVersion: queryReadVersion,
    readSelection: onReadSelection,
    onError,
  })
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const requestRowAction = useCallback((id: number, action: (row: LedgerRow) => void, permission?: LedgerRow['allowed_actions'][number]) => {
    onRequestWorkspaceAction(() => {
      const row = transactionsRef.current.find((candidate) => candidate.id === id)
      if (!row || 'is_draft' in row || permission && !row.allowed_actions.includes(permission)) { onError('That transaction is no longer available for this action.'); return }
      action(row)
    })
  }, [onError, onRequestWorkspaceAction])
  const {
    canExpand: canExpandSelection,
    cancelRead: cancelSelectionRead,
    clear: clearSelection,
    expand: expandSelection,
    expanded: expandedSelection,
    ids: selectedTransactionIds,
    selectOne,
    phase: selectionPhase,
    retry: retrySelection,
    selectShortcut,
    selectedRows: selectedTransactions,
    selectionReady,
    setFrozen: setSelectionFrozen,
  } = selection
  useEffect(() => {
    if (editing) setContextMenu(null)
  }, [editing])
  useEffect(() => {
    if (editing?.isNew) clearSelection()
  }, [clearSelection, editing?.id, editing?.isNew])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  // The first fitted layout becomes the floor for later manual resizing.
  const resizeMinimumsRef = useRef<{ separateAmountColumns: boolean; showRunningBalance: boolean; showBankDescription: boolean; showTransferColumn: boolean; widths: Record<string, number> } | null>(null)
  const sizingResetPendingRef = useRef(false)
  const resizeRef = useRef<{
    columnId: string
    pointerId: number
    startX: number
    startWidth: number
    minWidth: number
    maxWidth: number
  } | null>(null)

  useLayoutEffect(() => {
    setSorting((current) => {
      const amountColumns = separateAmountColumns ? new Set(['outflow', 'inflow']) : new Set(['amount_cents'])
      const next = current.filter((item) => (showBankDescription || item.id !== 'description') && (showTransferColumn || item.id !== 'transfer') && (!['amount_cents', 'outflow', 'inflow'].includes(item.id) || amountColumns.has(item.id)))
      if (next.length === current.length) return current
      return next
    })
  }, [separateAmountColumns, showBankDescription, showTransferColumn])

  useLayoutEffect(() => {
    sizingResetPendingRef.current = true
    setColumnSizing((current) => Object.fromEntries(Object.entries(current).filter(([id]) => resizedColumnIdsRef.current.has(id))))
  }, [showBankDescription, showTransferColumn])

  useEffect(() => {
    if (!locked) return
    setOpenFilter(null)
    setContextMenu(null)
    clearSelection()
  }, [clearSelection, locked])

  useEffect(() => {
    if (openFilter === null) return
    const shell = gridShellRef.current
    const scrollLeft = shell?.scrollLeft
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target?.closest('.bp-table-filter-area, .bp-column-filter-popover, .bp-filter-select-popover')) setOpenFilter(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (isComposingKey(event)) return
      if (event.key === 'Escape') setOpenFilter(null)
    }
    const closeOnViewportChange = (event: Event) => {
      const target = event.target as Element | null
      if (target?.closest?.('.bp-column-filter-popover, .bp-filter-select-popover')) return
      // The register's own handler distinguishes vertical user scrolling from passive layout.
      if (target === shell && shell?.scrollLeft === scrollLeft) return
      setOpenFilter(null)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    document.addEventListener('scroll', closeOnViewportChange, true)
    window.addEventListener('resize', closeOnViewportChange)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('scroll', closeOnViewportChange, true)
      window.removeEventListener('resize', closeOnViewportChange)
    }
  }, [openFilter])

  useLayoutEffect(() => {
    initializedViewRef.current = null
    loadingOlderRef.current = false
  }, [filterViewGeneration])


  useEffect(() => {
    clearSelection()
  }, [clearSelection, matchResetKey])

  const selectedTotalCents = selectedTransactionIds.size === selectedTransactions.length
    ? selectedTransactions.reduce((total, transaction) => total + transaction.amount_cents, 0)
    : null
  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const focusContextRow = useCallback(() => {
    const focusId = contextMenu?.focusId
    if (focusId !== undefined) {
      gridShellRef.current?.querySelector<HTMLElement>(`[data-ledger-row-id="${focusId}"]`)?.focus({ preventScroll: true })
      revealRow(focusId)
    }
  }, [contextMenu, revealRow])
  const payeeNames = useMemo(() => new Map(payees.map((payee) => [payee.id, payee.name])), [payees])
  const catalogOptions = useMemo<{ payee: FilterChoice[]; category: FilterChoice[] }>(() => ({
    payee: payees.map((payee) => ({ value: String(payee.id), label: payee.name })),
    category: [
      { value: 'none', label: 'No category' },
      { value: 'unassigned', label: 'Unassigned split' },
      ...categories.flatMap((parent) => parent.children.map((child) => ({
        value: String(child.id),
        label: `${parent.name}: ${child.name}${parent.archived || child.archived ? ' (archived)' : ''}`,
        displayLabel: `${child.name}${parent.archived || child.archived ? ' (archived)' : ''}`,
        parent: { id: String(parent.id), label: `${parent.name}${parent.archived ? ' (archived)' : ''}` },
      }))),
    ],
  }), [categories, payees])
  const catalogKeys = useMemo(() => ({
    payee: new Set(catalogOptions.payee.map((choice) => choice.value)),
    category: new Set(catalogOptions.category.map((choice) => choice.value)),
  }), [catalogOptions])
  const openFilterKey = openFilter ? COLUMN_FILTER_KEYS[openFilter.columnId] : undefined
  const filterChoices = useQuery({
    queryKey: ['transactions', 'filter-choices', accountId],
    enabled: accountId !== null && (openFilterKey === 'payee' || openFilterKey === 'category'),
    retry: false,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      appendAccountScope(params, accountId)
      return apiClient.get<LedgerFilterChoices>(`/api/transactions/filter-choices?${params}`, signal)
    },
  })
  const checkboxOptions = useMemo(() => {
    const used = filterChoices.data
    if (!used) return { payee: [], category: [] }
    const payeeKeys = new Set(used.payee_ids.map(String))
    const categoryKeys = new Set(used.category_values)
    return {
      payee: catalogOptions.payee.filter((choice) => payeeKeys.has(choice.value)),
      category: catalogOptions.category.filter((choice) => categoryKeys.has(choice.value)),
    }
  }, [catalogOptions, filterChoices.data])
  const filterLabelsRef = useRef({ payee: new Map<string, string>(), category: new Map<string, string>() })
  for (const kind of ['payee', 'category'] as const) {
    for (const choice of catalogOptions[kind]) filterLabelsRef.current[kind].set(choice.value, choice.label)
  }
  useEffect(() => setOpenFilter(null), [accountId])
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts])
  const selectedSourceAccountIds = useMemo(() => new Set(selectedTransactions.map((transaction) => transaction.account_id)), [selectedTransactions])
  const openTransferAccountIds = useMemo(() => accounts
    .filter((account) => !account.closed && !selectedSourceAccountIds.has(account.id))
    .map((account) => account.id), [accounts, selectedSourceAccountIds])
  const dateTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const displayDateFormatter = useMemo(() => new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: dateTimeZone,
  }), [dateTimeZone])
  const bulk = useBulkApply({
    selectedRows: selectedTransactions,
    selectedCount: selectedTransactionIds.size,
    selectionReady,
    expandedSelection,
    viewKey,
    writePending: writePending || aggregatePending,
    apply: onBulkApply,
    refresh: (reviewed) => onRefreshAfterApply(viewKey, reviewed),
    onCommitted: () => {
      clearSelection()
    },
    onRefreshFailure: () => onError('Changes saved, but the register could not be refreshed.'),
    inspectHistory: onInspectHistory,
  })
  const { discard: discardBulk } = bulk
  const bulkWorkflowActive = bulk.phase !== 'idle' || bulk.outcomeUnknown
  const bulkToolbarVisible = selectedTransactionIds.size > 1 || selectedTransactionIds.size > 0 && (bulk.hasStagedChanges || bulkWorkflowActive || canExpandSelection || selectionPhase !== 'idle')
  const balanceCutoff = useMemo(() => defaultSorting && showRunningBalance && !aggregatePending && !writePending && !bulkWorkflowActive
    ? defaultBalanceCutoff(persistedTransactions)
    : null, [aggregatePending, bulkWorkflowActive, defaultSorting, persistedTransactions, showRunningBalance, writePending])
  const balanceBoundaryId = balanceCutoff?.boundaryId
  useLayoutEffect(() => {
    const current = {
      viewKey,
      hasSelection: bulkToolbarVisible,
      canExpand: canExpandSelection,
    }
    const previous = previousSelectionControlsRef.current
    previousSelectionControlsRef.current = current
    if (!previous || previous.viewKey !== viewKey) return
    if (!(previous.hasSelection && !current.hasSelection) && !(previous.canExpand && !current.canExpand)) return
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return
      gridShellRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [bulkToolbarVisible, canExpandSelection, viewKey])
  useEffect(() => {
    setSelectionFrozen(bulkWorkflowActive || writePending || aggregatePending)
  }, [aggregatePending, bulkWorkflowActive, setSelectionFrozen, writePending])
  useEffect(() => {
    onBulkStagedChange(bulk.hasStagedChanges)
    return () => onBulkStagedChange(false)
  }, [bulk.hasStagedChanges, onBulkStagedChange])
  const hasSelection = selectedTransactionIds.size > 0
  useEffect(() => {
    onSelectionChange(hasSelection)
    return () => onSelectionChange(false)
  }, [hasSelection, onSelectionChange])
  useEffect(() => {
    if (scheduleSelected) clearSelection()
  }, [clearSelection, scheduleSelected])
  const otherHistoryWork = Boolean(splitDraft || contextMenu || openFilter || columnsMenuOpen || !selectionReady || bulk.hasStagedChanges || bulk.phase !== 'idle' || bulk.outcomeUnknown || splitRecoveryReloading || quickCreateBlocked || writePending)
  const historyBlocked = Boolean(editing || otherHistoryWork)
  const ordinaryEditorOnly = Boolean(editing && !editing.isNew && !otherHistoryWork)
  const historyRecoveryOwned = bulk.outcomeUnknown || splitRecoveryActive || quickCreateRecovery
  useLayoutEffect(() => {
    onHistoryGuardChange({ blocked: historyBlocked, recoveryOwned: historyRecoveryOwned, ordinaryEditorOnly })
  }, [historyBlocked, historyRecoveryOwned, ordinaryEditorOnly, onHistoryGuardChange])
  useEffect(() => () => onHistoryGuardChange({ blocked: false, recoveryOwned: false }), [onHistoryGuardChange])

  useLayoutEffect(() => {
    discardBulk()
  }, [discardBulk, filterViewGeneration])
  useEffect(() => {
    if (selectedTransactionIds.size === 0) discardBulk()
  }, [discardBulk, selectedTransactionIds.size])
  const relationshipCommandsBlocked = stateCommandsBlocked || aggregatePending || writePending || bulk.hasStagedChanges || bulkWorkflowActive
  const openRowMatch = useCallback((transaction: LedgerRow) => requestRowAction(transaction.id, (current) => {
    const mode = matchReviewMode(current)
    if (mode) onOpenMatch(mode, current, current)
    else onError('That transaction no longer has a match to review.')
  }), [onError, onOpenMatch, requestRowAction])
  const inspectRowConnections = useCallback((transaction: LedgerRow) => requestRowAction(transaction.id, (current) => {
    clearSelection()
    onInspectConnections(current)
  }, 'inspect_connections'), [clearSelection, onInspectConnections, requestRowAction])
  const openRowLifecycle = useCallback((transaction: LedgerRow) => requestRowAction(transaction.id, (current) => {
    clearSelection()
    onOpenLifecycle(current)
  }, 'pending_lifecycle'), [clearSelection, onOpenLifecycle, requestRowAction])
  const { mutateAsync: unlinkTransfer } = useUnlinkTransfer()
  const unlinkFromBadge = useCallback(async (context: TransactionConnectionsContext) => {
    if (relationshipCommandsBlocked || !context.transfer) throw new Error('Finish the active ledger work before unlinking.')
    try {
      await unlinkTransfer({ id: context.transfer.action.id, context_token: context.transfer.action.context_token })
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.status >= 500 || caught.code === 'unknown_error') {
        await onInspectHistory()
        await onRefreshAfterApply(viewKey, false)
        throw new Error('The unlink outcome was inspected. Check the refreshed transaction before another action.')
      }
      throw caught
    }
    await onRefreshAfterApply(viewKey, false)
  }, [onInspectHistory, onRefreshAfterApply, relationshipCommandsBlocked, unlinkTransfer, viewKey])

  const columns = useMemo<ColumnDef<LedgerDisplayRow>[]>(
    () => ([
      ...(isCombinedScope(accountId) ? [{
        id: 'account',
        accessorFn: (transaction: LedgerDisplayRow) => accountById.get(transaction.account_id)?.name ?? `Account ${transaction.account_id}`,
        header: 'Account',
        cell: ({ row, getValue }: CellContext<LedgerDisplayRow, unknown>) => {
          const account = accountById.get(row.original.account_id)
          const needsInitialization = account?.plaid_connection && account.starting_balance_initialized_at === null
          return <span title={needsInitialization ? 'Needs initialization' : undefined}>{getValue<string>()}{needsInitialization ? ' · Needs initialization' : ''}</span>
        },
        size: 150,
        minSize: FLEX_COLUMN_LAYOUT.account.minWidth,
      }] : []),
      {
        id: 'source',
        accessorFn: transactionSource,
        header: () => <span className="bp-visually-hidden">Source</span>,
        cell: ({ row }) => (
          <span className="bp-source-cell">
            <LedgerSourceIcon source={transactionSource(row.original)} excluded={!('is_draft' in row.original) && row.original.excluded} />
            {!('is_draft' in row.original) && row.original.editable_fields.includes('flag') && <TransactionFlagPicker
              value={row.original.flag}
              disabled={stateCommandsBlocked || writePending || bulk.hasStagedChanges || bulkWorkflowActive}
              saving={pendingRowIds.has(row.original.id)}
              onSavingAttempt={() => onError('This transaction is still saving.')}
              onRequestOpen={(open) => requestRowAction(row.original.id, (current) => { if (current.editable_fields.includes('flag')) open(); else onError('This transaction flag is no longer editable.') })}
              onChange={(flag) => requestRowAction(row.original.id, (current) => { if (current.editable_fields.includes('flag')) void onUpdate(current.id, { flag, expected_edit_token: current.edit_token }).catch((error) => onError(error instanceof ApiError ? error.message : 'Transaction flag could not be saved.')) })}
            />}
          </span>
        ),
        size: 52,
        minSize: 52,
        maxSize: 52,
        enableResizing: false,
      },
      {
        id: 'date',
        accessorFn: (transaction) => transaction.date,
        sortingFn: (left, right) => left.original.date.localeCompare(right.original.date) || chronologyRank(left.original) - chronologyRank(right.original) || (sorting.length === 1 ? left.original.id - right.original.id : 0),
        header: 'Date',
        cell: ({ getValue }) => displayDate(getValue<string>(), displayDateFormatter),
        size: 86,
        minSize: 86,
        maxSize: 86,
        enableResizing: false,
      },
      {
        id: 'payee',
        accessorFn: (transaction) => payeeNames.get(transaction.payee_id ?? -1) ?? transaction.payee_name ?? '',
        header: 'Payee',
        cell: ({ row, getValue }) => {
          const bankDescription = row.original.source === 'plaid' && !('is_draft' in row.original) ? row.original.rule_description ?? '' : ''
          const transfer = !('is_draft' in row.original) ? row.original.transfer : null
          const title = !showTransferColumn && transfer?.attention_reasons.length ? transfer.attention_reasons.join(' · ') : bankDescription ? `Bank description: ${bankDescription}` : undefined
          const payee = row.original.payee_name ?? getValue<string>()
          const payeeLabel = Array.from(payee).slice(0, 35).join('')
          return (
            <span className="bp-payee-cell" title={title}>
              <span>{payeeLabel || emptyCell}{!showTransferColumn && transfer?.state === 'attention' ? ' ⓘ' : ''}</span>
              {!showTransferColumn && transfer && !('is_draft' in row.original) && <TransferBadge onRequestOpen={(open) => requestRowAction(row.original.id, (current) => { if (current.transfer) open(); else onError('That transfer is no longer assigned.') })} row={row.original} blocked={relationshipCommandsBlocked} onJump={() => onGoToTransfer(row.original as LedgerRow)} onUnlink={unlinkFromBadge} />}
            </span>
          )
        },
        size: 144,
        minSize: FLEX_COLUMN_LAYOUT.payee.minWidth,
      },
      {
        id: 'transfer',
        accessorFn: (transaction) => !('is_draft' in transaction) ? transaction.transfer?.account_name ?? '' : '',
        header: 'Transfer',
        cell: ({ row }) => !('is_draft' in row.original) && row.original.transfer
          ? <TransferBadge cell onRequestOpen={(open) => requestRowAction(row.original.id, (current) => { if (current.transfer) open(); else onError('That transfer is no longer assigned.') })} row={row.original} blocked={relationshipCommandsBlocked} onJump={() => onGoToTransfer(row.original as LedgerRow)} onUnlink={unlinkFromBadge} />
          : emptyCell,
        size: 170,
        minSize: FLEX_COLUMN_LAYOUT.transfer.minWidth,
      },
      {
        id: 'description',
        accessorFn: (transaction) => transaction.source === 'plaid' && !('is_draft' in transaction) ? transaction.rule_description ?? '' : '',
        header: 'Bank description',
        cell: ({ getValue }) => getValue<string>() || null,
        size: 240,
        minSize: FLEX_COLUMN_LAYOUT.description.minWidth,
      },
      {
        id: 'category',
        accessorFn: (transaction) => transaction.category_name
          ? transaction.subcategory_name
            ? `${transaction.category_name}: ${transaction.subcategory_name}`
            : transaction.category_name
          : '',
        header: 'Category',
        cell: ({ getValue }) => getValue<string>() || emptyCell,
        size: 170,
        minSize: FLEX_COLUMN_LAYOUT.category.minWidth,
      },
      {
        accessorKey: 'memo',
        header: 'Memo',
        cell: ({ getValue }) => getValue<string>() || emptyCell,
        size: 190,
        minSize: FLEX_COLUMN_LAYOUT.memo.minWidth,
      },
      ...(separateAmountColumns ? [{
        id: 'outflow',
        accessorFn: (transaction: LedgerDisplayRow) => transaction.amount_cents < 0 ? Math.abs(transaction.amount_cents) : undefined,
        header: 'Outflow',
        cell: ({ row, getValue }: CellContext<LedgerDisplayRow, unknown>) => (getValue() as number | undefined) === undefined ? null : (
          <span className="bp-amount is-negative">{displayAmount(row.original.amount_cents, false)}</span>
        ),
        sortUndefined: 'last' as const,
        size: 94,
        minSize: 94,
        maxSize: 94,
        enableResizing: false,
      }, {
        id: 'inflow',
        accessorFn: (transaction: LedgerDisplayRow) => transaction.amount_cents >= 0 ? transaction.amount_cents : undefined,
        header: 'Inflow',
        cell: ({ row, getValue }: CellContext<LedgerDisplayRow, unknown>) => (getValue() as number | undefined) === undefined ? null : (
          <span className="bp-amount is-positive">{displayAmount(row.original.amount_cents, false)}</span>
        ),
        sortUndefined: 'last' as const,
        size: 94,
        minSize: 94,
        maxSize: 94,
        enableResizing: false,
      }] : [{
        accessorKey: 'amount_cents' as const,
        header: 'Amount',
        cell: ({ row, getValue }: CellContext<LedgerDisplayRow, unknown>) => (
          <span className={`bp-amount ${row.original.amount_cents < 0 ? 'is-negative' : 'is-positive'}`}>
            {displayAmount(getValue() as number)}
          </span>
        ),
        size: 94,
        minSize: 94,
        maxSize: 94,
        enableResizing: false,
      }]),
      ...(showRunningBalance ? [{
        id: 'running_balance_cents',
        accessorFn: (transaction: LedgerDisplayRow) => 'is_draft' in transaction ? null : transaction.running_balance_cents,
        header: 'Balance',
        cell: ({ row, getValue }: CellContext<LedgerDisplayRow, unknown>) => {
          const cents = getValue() as number | null
          if ('is_draft' in row.original || cents === null || aggregatePending || writePending || bulkWorkflowActive) return null
          const afterCutoff = balanceCutoff !== null && compareChronology(row.original, balanceCutoff) >= 0
          const boundary = row.original.id === balanceBoundaryId
          const grouped = ledgerDisplayGroup(row.original) > 0
          const mutedReason = defaultSorting
            ? afterCutoff
              ? 'Calculated by date. Status grouping moves earlier entries below later ones. Balances from the earliest displaced entry onward are muted. Sort by Date to follow the balance sequence.'
              : grouped ? 'Calculated by date. This transaction is grouped by status, so its balance may not follow the displayed order.' : null
            : chronologicalSorting ? null : 'Calculated by date. Rows are sorted by another column, so this balance may not follow the displayed order.'
          const explanation = boundary ? `Date sequence changes here. ${mutedReason}` : mutedReason
          return <span className={`bp-amount ${cents < 0 ? 'is-negative' : 'is-positive'}${mutedReason ? ' is-muted' : ''}${boundary ? ' is-balance-boundary' : ''}`} title={explanation ? `${money(cents, true)} — ${explanation}` : money(cents, true)} role={boundary ? 'note' : undefined} tabIndex={boundary ? 0 : undefined} aria-label={boundary ? `Balance ${money(cents, true)}. Date sequence changes here.` : undefined} aria-description={boundary ? mutedReason ?? undefined : undefined}>
            {displayAmount(cents)}
            {defaultSorting && grouped && mutedReason && !boundary && <span className="bp-visually-hidden"> {mutedReason}</span>}
          </span>
        },
        size: 94,
        minSize: 94,
        maxSize: 94,
        enableResizing: false,
        enableSorting: false,
      }] : []),
      {
        id: 'status',
        accessorFn: statusLabel,
        header: 'Status',
        cell: ({ row }: CellContext<LedgerDisplayRow, unknown>) => {
          const transaction = row.original
          const pinned = isPinnedTransaction(transaction)
          return transaction.missing_pending
            ? <span className="bp-status bp-status-pending bp-status-missing" tabIndex={0} title={MISSING_PENDING_TOOLTIP} aria-label={MISSING_PENDING_TOOLTIP}>{statusLabel(transaction)}</span>
            : <span className={`bp-status bp-status-${pinned ? transaction.status === 'cleared' ? 'cleared' : 'unmatched' : transaction.manually_cleared ? 'cleared' : transaction.status}`}>{pinned ? <UnmatchedStatus cleared={transaction.status === 'cleared'} /> : statusDisplay(transaction)}</span>
        },
        size: 85,
        minSize: 85,
        maxSize: 85,
        enableResizing: false,
      },
      {
        id: 'actions',
        header: () => <span className="bp-visually-hidden">Actions</span>,
        cell: ({ row }: CellContext<LedgerDisplayRow, unknown>) => (
          <span className="bp-row-actions">
            {!('is_draft' in row.original) && <>
              <MatchButton transaction={row.original} disabled={relationshipCommandsBlocked} onOpen={openRowMatch} onInspectConnections={inspectRowConnections} onResolveLifecycle={openRowLifecycle} />
              <RowStateButton
                transaction={row.original}
                disabled={stateCommandsBlocked || writePending || bulk.hasStagedChanges || bulkWorkflowActive}
                saving={pendingRowIds.has(row.original.id)}
                onSavingAttempt={() => onError('This transaction is still saving.')}
                onRequestAction={(action) => requestRowAction(row.original.id, action)}
                onReview={onReview}
                onClearance={onToggleClearance}
                onError={onError}
              />
            </>}
          </span>
        ),
        size: 50,
        minSize: 50,
        maxSize: 50,
        enableResizing: false,
        enableSorting: false,
      },
    ] satisfies ColumnDef<LedgerDisplayRow>[]).filter((column) => (showBankDescription || column.id !== 'description') && (showTransferColumn || column.id !== 'transfer')),
    [requestRowAction, payeeNames, accountById, accountId, aggregatePending, balanceBoundaryId, balanceCutoff, bulk.hasStagedChanges, bulkWorkflowActive, chronologicalSorting, defaultSorting, displayDateFormatter, onError, openRowLifecycle, openRowMatch, inspectRowConnections, relationshipCommandsBlocked, onReview, onToggleClearance, onUpdate, onGoToTransfer, unlinkFromBadge, pendingRowIds, separateAmountColumns, showBankDescription, showRunningBalance, showTransferColumn, sorting, stateCommandsBlocked, writePending],
  )
  const table = useReactTable({
    data: transactions,
    columns,
    state: { sorting, columnSizing },
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (transaction) => String(transaction.id),
    enableMultiSort: true,
    enableSortingRemoval: true,
    isMultiSortEvent: (event) => Boolean((event as { shiftKey?: boolean }).shiftKey),
    maxMultiSortColCount: 3,
    columnResizeMode: 'onChange',
    defaultColumn: {
      minSize: 72,
      maxSize: 520,
      sortDescFirst: false,
    },
  })
  const selectedTable = useReactTable({
    data: selectedTransactions,
    columns,
    state: { sorting, columnSizing },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (transaction) => String(transaction.id),
  })
  const sortedRows = table.getRowModel().rows
  const draftRow = sortedRows.find((row) => 'is_draft' in row.original) ?? null
  const freshTransferDraft = draftRow !== null && 'is_draft' in draftRow.original && draftRow.original.entryOrigin === 'transfer'
  const persistedRows = useMemo(() => sortedRows.filter((row) => !('is_draft' in row.original)) as Array<(typeof sortedRows)[number] & { original: LedgerRow }>, [sortedRows])
  const ledgerRows = useMemo(() => defaultSorting ? [...persistedRows].sort((left, right) => compareDefaultLedgerRows(left.original, right.original)) : persistedRows, [defaultSorting, persistedRows])
  ledgerOrderRef.current = ledgerRows.map((row) => row.original.id)
  const selectedPair = usesPlaidWorkflow ? selectedMatchPair(selectedTransactions) : null
  const startTransferQueue = () => {
    const selectedLedgerRows = selectedTable.getRowModel().rows
    const ordered = defaultSorting ? [...selectedLedgerRows].sort((left, right) => compareDefaultLedgerRows(left.original, right.original)) : selectedLedgerRows
    const entries = ordered.map((row) => ({ id: row.original.id, edit_token: row.original.edit_token }))
    const start = bulk.startTransferQueue(entries)
    if (!start) return
    gridShellRef.current?.querySelector<HTMLElement>(`[data-ledger-row-id="${entries[0].id}"]`)?.focus({ preventScroll: true })
    onStartTransferQueue(start)
    clearSelection()
  }

  const openContextMenu = useCallback((transaction: LedgerRow, left: number, top: number) => {
    invalidateSelectionHandoff()
    requestRowAction(transaction.id, (current) => {
      if (editingRef.current || splitDraftRef.current) { onError('Save or cancel the current transaction first'); return }
      const currentSelection = selectionRef.current
      if (!currentSelection.selectionReady || currentSelection.phase !== 'idle') { onError('Wait for the selected transactions to finish refreshing.'); return }
      const selected = currentSelection.ids.has(current.id)
      if (!selected && bulk.hasStagedChanges) { onError(STAGED_CHANGES_NOTICE); return }
      if (!selected) currentSelection.selectOne(current.id)
      setFocusedRowId(current.id)
      setContextMenu({ rows: selected ? currentSelection.selectedRows : [current], left, top, focusId: current.id })
    })
  }, [bulk.hasStagedChanges, editingRef, invalidateSelectionHandoff, onError, requestRowAction, splitDraftRef])

  const moveRovingFocus = useCallback((from: number, direction: 1 | -1) => {
    const ids = ledgerRows.map((row) => row.original.id)
    const index = ids.indexOf(from)
    const next = ids[index + direction]
    if (next === undefined) { if (direction < 0) void loadOlderAtTop(); return }
    setFocusedRowId(next)
    requestAnimationFrame(() => {
      gridShellRef.current?.querySelector<HTMLElement>(`[data-ledger-row-id="${next}"]`)?.focus({ preventScroll: true })
      revealRow(next, 'keyboard')
      cancelPendingReveals()
      void loadOlderAtTop()
    })
  }, [cancelPendingReveals, ledgerRows, loadOlderAtTop, revealRow])

  const selectRow = (
    event: ReactMouseEvent<HTMLTableRowElement> | ReactKeyboardEvent<HTMLTableRowElement>,
    transaction: LedgerDisplayRow,
    keyboardEntry = false,
  ) => {
    if (writePending) return
    if (!('is_draft' in transaction) && pendingRowIds.has(transaction.id)) { onError('This transaction is still saving.'); return }
    const selectedAlone = selectedTransactionIds.size === 1 && selectedTransactionIds.has(transaction.id)
    const entryTarget = keyboardEntry ? 'keyboard' : clickedLedgerCell(event.target)
    if (splitDraftRef.current && transaction.id !== splitDraftRef.current.rowId) {
      onRequestWorkspaceAction(() => {
        if (!cancelEditing()) return
        if (!keyboardEntry && !selectedAlone) { selectOne(transaction.id); return }
        beginEditing(transaction, entryTarget)
      })
      return
    }
    if (lifecyclePickerPending) {
      if (!('is_draft' in transaction) && transaction.source === 'plaid' && (transaction.status === 'cleared' || transaction.status === 'reconciled') && transaction.id !== lifecyclePickerPending.id) {
        onChooseLifecycleCleared(transaction)
      }
      return
    }
    const gesture = selectionGesture(event)
    if ('is_draft' in transaction && gesture !== 'one') return
    const interactive = isRowControl(event.target)
    if (gesture === 'toggle' && !interactive) {
      event.preventDefault()
      if (bulk.phase !== 'idle') return
      applySelection(() => {
        if (ledgerOrderRef.current.includes(transaction.id)) selectionRef.current.toggle(transaction.id, ledgerOrderRef.current)
        else onError('That transaction is no longer visible.')
      })
      return
    }
    if (gesture === 'range' && !interactive) {
      event.preventDefault()
      if (bulk.phase !== 'idle') return
      applySelection(() => {
        if (ledgerOrderRef.current.includes(transaction.id)) selectionRef.current.extend(transaction.id, ledgerOrderRef.current)
        else onError('That transaction is no longer visible.')
      })
      return
    }
    if (interactive) return
    if (bulk.hasStagedChanges) {
      onError(STAGED_CHANGES_NOTICE)
      return
    }
    if (bulkWorkflowActive) { onError('Wait for the current update to finish.'); return }
    if (editingRef.current?.id === transaction.id) return
    if (!keyboardEntry && !('is_draft' in transaction) && (!selectedAlone || transaction.editable_fields.length === 0)) {
      applySelection(() => {
        if (!transactionsRef.current.some((row) => row.id === transaction.id)) { onError('That transaction is no longer visible.'); return }
        selectionRef.current.selectOne(transaction.id)
        if (document.activeElement === document.body || document.activeElement === gridShellRef.current) gridShellRef.current?.querySelector<HTMLElement>(`[data-ledger-row-id="${transaction.id}"]`)?.focus({ preventScroll: true })
      })
      return
    }
    beginEditing(transaction, entryTarget)
  }

  useLayoutEffect(() => {
    const shell = gridShellRef.current
    if (!shell) return
    const updateWidth = () => {
      setGridWidth(shell.clientWidth)
      shell.parentElement?.style.setProperty('--bp-grid-gutter', `${shell.offsetWidth - shell.clientWidth - shell.clientLeft * 2}px`)
    }
    updateWidth()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => window.removeEventListener('resize', updateWidth)
    }
    const observer = new ResizeObserver(updateWidth)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [height, pending, transactions.length])

  useEffect(() => {
    const cancel = (event: Event) => {
      const request = filterReturnFocusRef.current
      if (!request || event.type === 'focusin' && (event.target === request.anchor || event.target === document.body)) return
      filterReturnFocusRef.current = null
    }
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('keydown', cancel, true)
    document.addEventListener('focusin', cancel, true)
    window.addEventListener('blur', cancel)
    return () => {
      document.removeEventListener('pointerdown', cancel, true)
      document.removeEventListener('keydown', cancel, true)
      document.removeEventListener('focusin', cancel, true)
      window.removeEventListener('blur', cancel)
    }
  }, [])
  useLayoutEffect(() => {
    const request = filterReturnFocusRef.current
    if (!request || pending) return
    if (request.accountId !== accountId || request.generation < filterViewGeneration) { filterReturnFocusRef.current = null; return }
    if (request.generation !== filterViewGeneration) return
    filterReturnFocusRef.current = null
    if ((document.activeElement === document.body || document.activeElement === request.anchor) && !document.querySelector('.bp-modal-overlay')) {
      gridShellRef.current?.querySelector<HTMLButtonElement>(`th[data-column="${request.columnId}"] .bp-table-filter`)?.focus({ preventScroll: true })
    }
  }, [accountId, filterViewGeneration, pending])

  useLayoutEffect(() => {
    const shell = gridShellRef.current
    if (!shell || pending || initializedViewRef.current === viewKey) return
    if (locked) return
    const active = document.activeElement
    const accountNavigationFocused = active instanceof Element && Boolean(active.closest('nav[aria-label="Accounts"]'))
    if (!editing && !splitDraft && !draftRow && !openFilter && !contextMenu && (active === document.body || accountNavigationFocused)) {
      shell.focus({ preventScroll: true })
    }
    initializedViewRef.current = viewKey
  }, [contextMenu, draftRow, editing, locked, openFilter, pending, splitDraft, transactions.length, viewKey])

  useEffect(() => {
    const followingEntry = revealTransactionId == null && newEntryReveal !== null
    const transferRequest = transferRevealRequestRef.current
    const transferRequestCurrent = () => transferRequest === transferRevealRequestRef.current && transferRequest.revision === navigationRevisionRef.current
    const targetId = followingEntry ? newEntryReveal.id : revealTransactionId
    if (targetId == null || pending) return
    if (followingEntry) {
      if (newEntryReveal.viewKey !== viewKey || newEntryReveal.navigationRevision !== navigationRevisionRef.current || stateCommandsBlocked || editing && editing.id !== newEntryReveal.draftId || draftRow && draftRow.original.id !== newEntryReveal.draftId) {
        completeNewEntryReveal(null)
        return
      }
      if (draftRow || editing || splitDraft) return
    } else {
      if (!transferRequestCurrent()) { onCancelReveal?.(); return }
      if (!accountInScope(accountById.get(revealAccountId ?? -1), accountId)) return
    }
    const found = transactions.some((row) => row.id === targetId)
    if (found) {
      const frame = requestAnimationFrame(() => {
        if (!followingEntry && !transferRequestCurrent()) return
        if (followingEntry && newEntryReveal.navigationRevision !== navigationRevisionRef.current) {
          completeNewEntryReveal(null)
          return
        }
        if (!revealRow(targetId, followingEntry ? 'saved' : 'center')) {
          if (followingEntry) completeNewEntryReveal(null)
          else onRevealComplete?.(false)
          return
        }
        setRevealedTransactionId(targetId)
        if (followingEntry) completeNewEntryReveal(true)
        else onRevealComplete?.(true)
      })
      return () => cancelAnimationFrame(frame)
    }
    if (followingEntry) {
      completeNewEntryReveal(false, hasMore)
      return
    }
    if (loadingOlder || loadingOlderRef.current) return
    if (!hasMore) {
      onRevealComplete?.(false)
      return
    }
    const requestGeneration = filterViewGeneration
    loadingOlderRef.current = true
    void onLoadOlder().then((progressed) => {
      if (filterViewGenerationRef.current !== requestGeneration || !transferRequestCurrent()) return
      if (!progressed) {
        onRevealComplete?.(false)
        return
      }
      requestAnimationFrame(() => {
        if (filterViewGenerationRef.current !== requestGeneration || !transferRequestCurrent()) return
        onRevealProgress?.()
      })
    }).finally(() => {
      if (filterViewGenerationRef.current === requestGeneration) loadingOlderRef.current = false
    })
  }, [accountById, accountId, completeNewEntryReveal, draftRow, editing, navigationRevisionRef, filterViewGeneration, hasMore, loadingOlder, newEntryReveal, onCancelReveal, onLoadOlder, onRevealComplete, onRevealProgress, pending, revealAccountId, revealTransactionId, revealRow, splitDraft, stateCommandsBlocked, transactions, viewKey])

  useEffect(() => {
    setRevealedTransactionId(null)
  }, [viewKey])

  useEffect(() => {
    if (revealedTransactionId === null) return
    const timer = window.setTimeout(() => setRevealedTransactionId(null), 2000)
    return () => window.clearTimeout(timer)
  }, [revealedTransactionId])

  const visibleColumns = table.getVisibleLeafColumns()
  const flexColumnIds = visibleColumns
    .map((column) => column.id)
    .filter((id) => id in FLEX_COLUMN_LAYOUT)
  const automaticFlexIds = flexColumnIds.filter((id) => columnSizing[id] === undefined)
  const fillColumnIds = automaticFlexIds.length > 0 ? automaticFlexIds : flexColumnIds
  const fillColumnIdSet = new Set(fillColumnIds)
  const fixedWidth = visibleColumns.reduce(
    (total, column) => total + (fillColumnIdSet.has(column.id) ? 0 : column.getSize()),
    0,
  )
  const fillMinimums = Object.fromEntries(fillColumnIds.map((id) => [
    id,
    columnSizing[id] ?? FLEX_COLUMN_LAYOUT[id].minWidth,
  ]))
  const minimumFillWidth = fillColumnIds.reduce((total, id) => total + fillMinimums[id], 0)
  const tableWidth = Math.max(gridWidth, fixedWidth + minimumFillWidth)
  const extraFillWidth = tableWidth - fixedWidth - minimumFillWidth
  const totalFillWeight = fillColumnIds.reduce(
    (total, id) => total + FLEX_COLUMN_LAYOUT[id].weight,
    0,
  )
  let allocatedFillWidth = 0
  const fillWidths = Object.fromEntries(fillColumnIds.map((id, index) => {
    const width = index === fillColumnIds.length - 1
      ? tableWidth - fixedWidth - allocatedFillWidth
      : fillMinimums[id] + extraFillWidth * (FLEX_COLUMN_LAYOUT[id].weight / totalFillWeight)
    allocatedFillWidth += width
    return [id, width]
  }))
  const effectiveWidths = Object.fromEntries(
    visibleColumns.map((column) => [
      column.id,
      fillWidths[column.id] ?? column.getSize(),
    ]),
  )

  useLayoutEffect(() => {
    // The visibility reset above re-renders with refitted peers; capture minimums from that render, not this one.
    if (sizingResetPendingRef.current) {
      sizingResetPendingRef.current = false
      return
    }
    if (gridWidth === 0 || (resizeMinimumsRef.current?.separateAmountColumns === separateAmountColumns && resizeMinimumsRef.current.showRunningBalance === showRunningBalance && resizeMinimumsRef.current.showBankDescription === showBankDescription && resizeMinimumsRef.current.showTransferColumn === showTransferColumn)) return
    resizeMinimumsRef.current = {
      separateAmountColumns,
      showRunningBalance,
      showBankDescription,
      showTransferColumn,
      widths: Object.fromEntries(flexColumnIds.map((id) => [id, effectiveWidths[id]])),
    }
  }, [effectiveWidths, flexColumnIds, gridWidth, separateAmountColumns, showBankDescription, showRunningBalance, showTransferColumn])

  const startColumnResize = (
    event: ReactPointerEvent<HTMLSpanElement>,
    columnId: string,
    minWidth: number,
    maxWidth: number,
  ) => {
    if (event.button !== 0) return
    const headerCell = event.currentTarget.parentElement
    if (!headerCell) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const currentFlexWidths = Object.fromEntries(
      flexColumnIds.map((id) => [id, effectiveWidths[id]]),
    )
    if (resizeMinimumsRef.current?.separateAmountColumns !== separateAmountColumns || resizeMinimumsRef.current?.showRunningBalance !== showRunningBalance || resizeMinimumsRef.current?.showBankDescription !== showBankDescription || resizeMinimumsRef.current?.showTransferColumn !== showTransferColumn) resizeMinimumsRef.current = { separateAmountColumns, showRunningBalance, showBankDescription, showTransferColumn, widths: currentFlexWidths }
    // Freeze peers at their displayed widths so this drag changes only its target.
    resizedColumnIdsRef.current.add(columnId)
    setColumnSizing((current) => ({ ...current, ...currentFlexWidths }))
    resizeRef.current = {
      columnId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: headerCell.getBoundingClientRect().width,
      minWidth: resizeMinimumsRef.current?.widths[columnId] ?? minWidth,
      maxWidth,
    }
    setResizingColumnId(columnId)
  }

  const moveColumnResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const nextWidth = Math.min(
      resize.maxWidth,
      Math.max(resize.minWidth, resize.startWidth + event.clientX - resize.startX),
    )
    setColumnSizing((current) => ({ ...current, [resize.columnId]: nextWidth }))
  }

  const endColumnResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    setResizingColumnId(null)
  }

  const resetColumnSize = (columnId: string) => {
    resizedColumnIdsRef.current.delete(columnId)
    setColumnSizing((current) => {
      const next = { ...current }
      delete next[columnId]
      return next
    })
  }

  useEffect(() => {
    if (historyRecoveryOutcome?.status !== 'committed' || historyRecoveryOutcome.request_id === appliedRecoveryRef.current) return
    appliedRecoveryRef.current = historyRecoveryOutcome.request_id
    if (editingRef.current && !quickCreateRecovery) cancelEditing()
  }, [cancelEditing, editingRef, historyRecoveryOutcome, quickCreateRecovery])

  const commitEditing = useCallback(async (reason: 'save' | 'leave' = 'save') => {
    const id = editingRef.current?.id
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    try {
      return await requestEditorExit(reason, onEditorTransfer)
    } finally {
      if (id !== undefined && keyboardRestoreRef.current?.id === id && editingRef.current?.id === id) {
        requestAnimationFrame(() => {
          if (editingRef.current?.id === id && document.activeElement === document.body) focusEntryField(String(id), undefined, previous)
        })
        keyboardRestoreRef.current = null
      }
    }
  }, [editingRef, onEditorTransfer, requestEditorExit])
  const continueSelectionAfterCommit = useCallback((action: () => void, afterCommit = action) => {
    const request = ++selectionHandoffRequestRef.current
    if (quickCreateBlocked) return
    const generation = filterViewGeneration
    const continuation = editingRef.current ? afterCommit : action
    onRequestWorkspaceAction(() => {
      if (selectionHandoffRequestRef.current !== request || !mountedRef.current || filterViewGenerationRef.current !== generation || editingRef.current) return
      continuation()
    })
  }, [editingRef, filterViewGeneration, onRequestWorkspaceAction, quickCreateBlocked])
  const changeColumns = (change: LedgerColumnsChange) => {
    if (change.kind === 'separateAmounts' && change.enabled === separateAmountColumns) return
    continueSelectionAfterCommit(() => {
      if (change.kind === 'transfer') onShowTransferColumnChange(change.enabled)
      else if (change.kind === 'description') {
        setOpenFilter((current) => current?.columnId === 'description' ? null : current)
        onShowBankDescriptionChange(change.enabled)
      } else if (change.kind === 'balance') onShowRunningBalanceChange(change.enabled)
      else onSeparateAmountColumnsChange(change.enabled)
    })
  }

  const focusAfterEditor = useCallback((restore: EditorFocusTarget) => {
    if (restore.isNew) {
      const target = document.querySelector<HTMLButtonElement>(restore.entryOrigin === 'transfer' ? '[data-new-transfer-control]' : '[data-new-transaction-control]')
      if (target && !target.disabled) {
        target.focus({ preventScroll: true })
        return
      }
    } else {
      const row = gridShellRef.current?.querySelector<HTMLElement>(`[data-ledger-row-id="${restore.id}"]`)
      if (row) {
        setFocusedRowId(restore.id)
        row.focus({ preventScroll: true })
        revealRow(restore.id)
        return
      }
    }
    setFocusedRowId(null)
    gridShellRef.current?.focus({ preventScroll: true })
  }, [revealRow])
  const editPayee = useCallback((id: number, transaction: LedgerDisplayRow) => {
    if (editingRef.current?.isNew || splitDraftRef.current) { onError('Save or cancel the current transaction first'); return }
    const origin = document.activeElement
    const generation = filterViewGeneration
    continueSelectionAfterCommit(() => {
      setPayeeEntry({ id, transaction, origin, generation, request: selectionHandoffRequestRef.current })
    })
  }, [continueSelectionAfterCommit, editingRef, filterViewGeneration, onError, splitDraftRef])
  useEffect(() => {
    if (!payeeEntry) return
    const obsolete = () => !mountedRef.current || editingRef.current || filterViewGenerationRef.current !== payeeEntry.generation || selectionHandoffRequestRef.current !== payeeEntry.request
    if (obsolete() || commandRecoveryActive) { setPayeeEntry(null); return }
    if (aggregatePending) return
    const frame = requestAnimationFrame(() => {
      setPayeeEntry(null)
      if (obsolete()) return
      const active = document.activeElement
      if (active !== document.body && active !== payeeEntry.origin && active !== gridShellRef.current) return
      const transaction = payeeEntry.transaction
      focusAfterEditor({ id: transaction.id, isNew: 'is_draft' in transaction, entryOrigin: 'is_draft' in transaction ? transaction.entryOrigin : undefined })
      onEditPayee(payeeEntry.id)
    })
    return () => cancelAnimationFrame(frame)
  }, [aggregatePending, commandRecoveryActive, editingRef, filterViewGeneration, focusAfterEditor, onEditPayee, payeeEntry])
  const applySelection = useCallback((action: () => void) => {
    setPendingShortcutSelection(null)
    continueSelectionAfterCommit(() => { action(); restoreGridFocusIfBody() })
  }, [continueSelectionAfterCommit, restoreGridFocusIfBody])
  const queueShortcutSelection = useCallback(() => setPendingShortcutSelection(viewKey), [viewKey])
  const beginEditing = useCallback((transaction: LedgerDisplayRow, entryTarget?: EntryTarget) => {
    const request = ++selectionHandoffRequestRef.current
    if (quickCreateBlocked || editingRef.current?.id === transaction.id) return
    const generation = filterViewGeneration
    onRequestWorkspaceAction(() => {
      if (selectionHandoffRequestRef.current !== request || !mountedRef.current || filterViewGenerationRef.current !== generation || editingRef.current) return
      const current = transactionsRef.current.find((row) => row.id === transaction.id)
      if (!current || !('is_draft' in current) && current.editable_fields.length === 0) { onError('That transaction is no longer available for editing.'); return }
      selectionRef.current.clear()
      selectionRef.current.activate(current.id)
      if (beginEditorSession(current) && entryTarget) entryFocusRef.current = { id: current.id, target: entryTarget }
    })
  }, [beginEditorSession, editingRef, filterViewGeneration, onError, onRequestWorkspaceAction, quickCreateBlocked])

  const saveSplit = useCallback(async (...args: Parameters<typeof saveEditorSplit>) => {
    const generation = filterViewGeneration
    const saved = await saveEditorSplit(...args)
    if (saved && mountedRef.current && filterViewGenerationRef.current === generation) setExpandedSplitIds((ids) => new Set(ids).add(saved.id))
  }, [filterViewGeneration, saveEditorSplit])

  useEffect(() => {
    if (editTransactionId === null) return
    const transaction = transactions.find((candidate) => candidate.id === editTransactionId)
    if (!transaction) return
    if ('is_draft' in transaction && editingRef.current?.id === transaction.id) {
      if (transaction.entryOrigin !== 'transfer') requestAnimationFrame(() => {
        if (editingRef.current?.id !== transaction.id) return
        document.querySelector<HTMLButtonElement>(`[data-ledger-edit-session="${transaction.id}"] [data-ledger-date-trigger]:not(:disabled)`)?.focus({ preventScroll: true })
      })
      onEditStarted()
      return
    }
    beginEditing(transaction)
    onEditStarted()
  }, [beginEditing, editTransactionId, editingRef, onEditStarted, transactions])

  useLayoutEffect(() => {
    if (!editing) return
    if (editing.isNew) {
      if (newComposerFocusRef.current === editing.id) return
      newComposerFocusRef.current = editing.id
      requestAnimationFrame(() => {
        if (editingRef.current?.id !== editing.id || !editingRef.current.isNew) return
        const session = document.querySelector<HTMLElement>(`[data-ledger-edit-session="${editing.id}"]`)
        if (!freshTransferDraft) session?.querySelector<HTMLButtonElement>('[data-ledger-date-trigger]:not(:disabled)')?.focus({ preventScroll: true })
      })
      return
    }
    const entry = entryFocusRef.current
    if (entry?.id !== editing.id) return
    entryFocusRef.current = null
    requestAnimationFrame(() => {
      if (editingRef.current?.id !== editing.id) return
      if (entry.target !== 'keyboard') {
        const { column, line } = entry.target
        if (enterLedgerCell(document.querySelector(line === undefined ? `tr[data-ledger-edit-session="${editing.id}"]` : `tr[data-ledger-edit-session="split-${editing.id}"][data-split-line="${line}"]`), column)) return
      }
      const session = document.querySelector<HTMLElement>(`[data-ledger-edit-session="${editing.id}"]`)
      const date = session?.querySelector<HTMLButtonElement>('[data-ledger-date-trigger]:not(:disabled)')
      const fallback = session?.querySelector<HTMLElement>('td.has-cell-editor button:not(:disabled), td.has-cell-editor input:not(:disabled), td.has-cell-editor select:not(:disabled), td.has-cell-editor textarea:not(:disabled)')
      ;(date ?? fallback)?.focus({ preventScroll: true })
      revealRow(editing.id)
    })
  }, [editing, editingRef, freshTransferDraft, revealRow])

  useEffect(() => {
    const restore = keyboardRestoreRef.current
    if (!restore || editing?.id === restore.id) return
    keyboardRestoreRef.current = null
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active !== document.body) return
      focusAfterEditor(restore)
    })
  }, [editing, focusAfterEditor])

  useEffect(() => {
    if (focusedRowId === null || persistedTransactions.some((row) => row.id === focusedRowId) || editing || splitDraft || writePending) return
    const frame = requestAnimationFrame(() => {
      if (editingRef.current || splitDraftRef.current || document.querySelector('.bp-modal-overlay')) return
      setFocusedRowId(null)
      restoreGridFocusIfBody()
    })
    return () => cancelAnimationFrame(frame)
  })
  const ordinaryEditorBlocked = locked || aggregatePending || writePending || quickCreateBlocked || commandRecoveryActive
  const cancelCurrentEntry = () => { if (!ordinaryEditorBlocked) void requestEditorExit('cancel', onEditorTransfer) }
  useCleanEditorDismiss(editing && !splitDraft && !ordinaryEditorHasWork && !ordinaryEditorBlocked ? String(editing.id) : null, cancelEditing, editing?.isNew ? '[data-new-transaction-control], [data-new-transfer-control]' : undefined)
  useEditorClickAway(editing && !splitDraft && ordinaryEditorHasWork && !ordinaryEditorBlocked ? String(editing.id) : null, editing && !editing.isNew ? () => onRequestWorkspaceAction(() => {}) : undefined)

  const renderLedgerRow = (row: (typeof sortedRows)[number]) => {
    const isEditing = editing?.id === row.original.id
    const isSplitEditing = isEditing && splitDraft?.rowId === row.original.id
    const persistedSplit = !('is_draft' in row.original) && row.original.allocations.length > 0
    const expandedSplit = persistedSplit && (expandedSplitIds.has(row.original.id) || filters.memo.trim() !== '' || hasValueSelection(filters.category))
    const originalUnassigned = !('is_draft' in row.original)
      ? row.original.allocations.find((allocation) => allocation.unassigned && allocation.amount_cents !== 0)
      : undefined
    const draftUnassigned = splitDraft?.allocations.find((allocation) => {
      const amount = parseLedgerAmount(allocation.amount)
      return allocation.unassigned && amount !== null && amount !== 0
    })
    const splitWarningAmount = draftUnassigned
      ? parseLedgerAmount(draftUnassigned.amount)
      : originalUnassigned?.amount_cents
    const sessionId = String(row.original.id)
    const source = transactionSource(row.original)
    const editableFields = row.original.editable_fields
    const rowClasses = [
      row.original.approved === false ? 'needs-review' : '',
      row.original.missing_pending ? 'pending-disappeared' : '',
      lifecyclePickerPending && row.original.id !== lifecyclePickerPending.id && !(row.original.source === 'plaid' && (row.original.status === 'cleared' || row.original.status === 'reconciled')) ? 'is-lifecycle-ineligible' : '',
      lifecyclePickerPending && row.original.id !== lifecyclePickerPending.id && row.original.source === 'plaid' && (row.original.status === 'cleared' || row.original.status === 'reconciled') ? 'is-lifecycle-eligible' : '',
      lifecyclePickerPending?.id === row.original.id ? 'is-lifecycle-anchor' : '',
      isEditing ? 'is-editing' : '',
      selectedTransactionIds.has(row.original.id) ? 'is-selected' : '',
      revealedTransactionId === row.original.id ? 'is-revealed' : '',
    ].filter(Boolean).join(' ')
    return (
      <Fragment key={row.id}>
      <tr
        key={row.id}
        className={rowClasses || undefined}
        aria-selected={selectedTransactionIds.has(row.original.id)}
        tabIndex={!('is_draft' in row.original) ? (focusedRowId === row.original.id || (focusedRowId === null && ledgerRows[0]?.original.id === row.original.id) ? 0 : -1) : isSplitEditing ? -1 : undefined}
        aria-busy={isEditing && (pendingRowIds.has(row.original.id) || writePending || splitRecoveryReloading || quickCreateBlocked)}
        data-ledger-row-id={row.original.id}
        inert={isEditing && (pendingRowIds.has(row.original.id) || writePending || splitRecoveryReloading || quickCreateBlocked)}
        aria-disabled={lifecyclePickerPending?.id === row.original.id || undefined}
        data-ledger-edit-session={isEditing ? sessionId : undefined}
        onMouseDown={(event) => {
          if (selectionGesture(event) !== 'one' && !isRowControl(event.target)) {
            event.preventDefault()
            if (!editingRef.current && !splitDraftRef.current) event.currentTarget.focus({ preventScroll: true })
          }
        }}
        onClick={(event) => selectRow(event, row.original)}
        onFocus={() => { if (!('is_draft' in row.original)) setFocusedRowId(row.original.id) }}
        onContextMenu={(event) => {
          const target = event.target as Element
          if (!event.currentTarget.contains(target) || 'is_draft' in row.original) return
          if (isEditing) return
          if (target.closest('input, textarea, select, [contenteditable]')) return
          event.preventDefault()
          openContextMenu(row.original, event.clientX, event.clientY)
        }}
        onClickCapture={(event) => {
          if (quickCreateBlocked) {
            if ((event.target as Element).closest(`.bp-picker-popover[data-ledger-edit-session="${sessionId}"]`)) return
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (lifecyclePickerPending?.id !== row.original.id) return
          event.preventDefault()
          event.stopPropagation()
        }}
        onKeyDownCapture={(event) => {
          if (quickCreateBlocked) {
            if ((event.target as Element).closest(`.bp-picker-popover[data-ledger-edit-session="${sessionId}"]`)) return
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (lifecyclePickerPending?.id === row.original.id) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (isComposingKey(event.nativeEvent)) return
          if (isEditing && event.key === 'Enter' && event.repeat) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (isSplitEditing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            event.stopPropagation()
            document.querySelector<HTMLButtonElement>(`[data-split-save="${row.original.id}"]`)?.click()
            return
          }
          const target = event.target as Element
          if (isEditing && target instanceof HTMLInputElement && target.classList.contains('bp-cell-input') && (event.key === 'Enter' || event.key === 'Escape')) {
            keyboardRestoreRef.current = { id: row.original.id, isNew: 'is_draft' in row.original, entryOrigin: 'is_draft' in row.original ? row.original.entryOrigin : undefined }
          }
        }}
        onKeyDown={(event) => {
          if (isComposingKey(event.nativeEvent)) return
          if (isEditing && editing && !isSplitEditing && event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyT' && editableFields.includes('transfer_account_id')) {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.querySelector<HTMLButtonElement>('button[data-transfer-picker]')?.click()
            return
          }
          if (isEditing && editing && !isSplitEditing && event.key === 'Escape' && !event.defaultPrevented && !(event.target as Element).closest('.bp-picker-popover, .bp-modal-overlay')) {
            event.preventDefault()
            event.stopPropagation()
            keyboardRestoreRef.current = { id: row.original.id, isNew: editing.isNew, entryOrigin: 'is_draft' in row.original ? row.original.entryOrigin : undefined }
            cancelCurrentEntry()
            return
          }
          if ('is_draft' in row.original || isEditing) return
          const keyAction = rowKeyAction(event)
          if (keyAction === 'next' || keyAction === 'previous') {
            event.preventDefault()
            moveRovingFocus(row.original.id, keyAction === 'next' ? 1 : -1)
            return
          }
          if (keyAction === 'menu') {
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            openContextMenu(row.original, rect.left + Math.min(24, rect.width / 2), rect.top + Math.min(24, rect.height / 2))
            return
          }
          if (keyAction === 'edit') {
            if (event.target !== event.currentTarget) return
            if (event.key === 'F2' && lifecyclePickerPending) return
            event.preventDefault()
            selectRow(event, row.original, true)
          }
        }}
      >
        {row.getVisibleCells().map((cell) => {
          let content = <DisplayCell cell={cell} render={cell.column.columnDef.cell} />
          let hasEditor = false
          if (isEditing && editing) {
            if (cell.column.id === 'actions' && !isSplitEditing) {
              const restoreKeyboardFocus = (keyboard: boolean) => {
                if (keyboard) keyboardRestoreRef.current = { id: row.original.id, isNew: editing.isNew, entryOrigin: 'is_draft' in row.original ? row.original.entryOrigin : undefined }
              }
              content = <LedgerEditorActions noun="transaction" isNew={editing.isNew} disabled={ordinaryEditorBlocked} unchanged={!ordinaryEditorDirty} onSave={(keyboard) => { restoreKeyboardFocus(keyboard); void commitEditing() }} onCancel={(keyboard) => { restoreKeyboardFocus(keyboard); cancelCurrentEntry() }} />
            } else if (cell.column.id === 'source' && editableFields.includes('flag')) {
              hasEditor = true
              content = <span className="bp-source-cell"><LedgerSourceIcon source={source} /><TransactionFlagPicker value={editing.draft.flag} sessionId={sessionId} onChange={(flag) => updateDraft({ flag })} /></span>
            } else if (cell.column.id === 'date' && editableFields.includes('date')) {
              hasEditor = true
              content = (
                <LedgerDatePicker
                  onAdvance={focusNextLedgerCell}
                  sessionId={sessionId}
                  showDropdownIcon
                  value={editing.draft.date}
                  onChange={(date) => updateDraft({ date })}
                />
              )
            } else if (cell.column.id === 'payee' && editableFields.includes('payee_id')) {
              hasEditor = true
              content = (
                <span className="bp-payee-cell"><LedgerOptionPicker
                  onAdvance={focusNextLedgerCell}
                  ariaLabel="Transaction payee"
                  sessionId={sessionId}
                  value={editing.draft.payeeId ?? null}
                  options={ledgerPayeeOptions(payees, editing.draft.payeeId)}
                  emptyLabel="Choose payee"
                  allowEmpty={false}
                  fallbackLabel={row.original.payee_name}
                  onChange={choosePayee}
                  onEditPayee={(id) => editPayee(id, row.original)}
                  onCreatePayee={createQuickPayee}
                  createPending={quickCreatePending}
                  createError={quickCreateError}
                  createRecovery={quickCreateRecovery}
                  onRecoverCreate={() => recoverQuickCreate(onInspectHistory)}
                  onCreateQueryChange={clearQuickCreateError}
                />{editableFields.includes('transfer_account_id') ? <LedgerTransferPicker ariaLabel="Transaction transfer" sessionId={sessionId} accounts={accounts} sourceAccountId={row.original.account_id} value={editing.draft.transferAccountId} onChange={chooseTransfer} autoOpen={'is_draft' in row.original && row.original.transferShortcutActive} tabIndex={'is_draft' in row.original && row.original.entryOrigin === 'transaction' ? -1 : undefined} onAdvance={() => focusEntryField(sessionId, 'payee')} /> : !('is_draft' in row.original) && row.original.transfer && <span className="bp-cell-picker bp-transfer-picker is-assigned" data-transfer-indicator role="img" aria-label={`Transfer: ${row.original.transfer.account_name}. Unlink before changing target.`} title={`Transfer: ${row.original.transfer.account_name}. Unlink before changing target.`}><ArrowRightLeft aria-hidden="true" /></span>}</span>
              )
            } else if (cell.column.id === 'transfer') {
              const target = accounts.find((account) => account.id === editing.draft.transferAccountId)
              content = target ? <TransferTarget amountCents={parseLedgerAmount(editing.draft.amount) ?? 0} accountName={target.name} /> : emptyCell
            } else if (cell.column.id === 'category' && editableFields.includes('category_id')) {
              hasEditor = true
              content = isSplitEditing
                ? <span className={`bp-split-parent-label${splitWarningAmount !== undefined ? ' has-unassigned-warning' : ''}`}>Split ({splitDraft.allocations.length}){splitWarningAmount !== undefined && ` · ${formatCents(splitWarningAmount ?? 0, { symbol: true })} unassigned`}</span>
                : <LedgerCategoryPicker onAdvance={focusNextLedgerCell} ariaLabel="Transaction category" sessionId={sessionId} value={editing.draft.categoryId} categories={categories} onChange={(categoryId) => chooseCategory(categoryId)} onSplit={editing.draft.transferAccountId !== null ? undefined : () => startSplit(row.original)} />
            } else if (cell.column.id === 'memo' && editableFields.includes('memo')) {
              hasEditor = true
              content = (
                <LedgerMemoInput
                  value={editing.draft.memo}
                  onChange={(memo) => updateDraft({ memo })}
                  onCommit={() => void commitEditing()}
                  onCancel={cancelCurrentEntry}
                />
              )
            } else if (['amount_cents', 'outflow', 'inflow'].includes(cell.column.id) && editableFields.includes('amount_cents')) {
              hasEditor = true
              content = cell.column.id === 'amount_cents' ? (
                <LedgerAmountInput
                  value={editing.draft.amount}
                  onChange={(amount) => updateDraft({ amount })}
                  onCommit={() => void commitEditing()}
                  onCancel={cancelCurrentEntry}
                />
              ) : <LedgerDirectionalAmountInput
                aria-label={`Transaction ${cell.column.id}`}
                value={editing.draft.amount}
                direction={cell.column.id === 'outflow' ? 'outflow' : 'inflow'}
                onChange={(amount) => updateDraft({ amount })}
                onKeyDown={(event) => {
                  if (isComposingKey(event.nativeEvent)) return
                  if (event.key === 'Enter') { event.preventDefault(); void commitEditing() }
                  else if (event.key === 'Escape') { event.preventDefault(); cancelCurrentEntry() }
                }}
              />
            }
          } else if (cell.column.id === 'category' && persistedSplit) {
            content = <button className="bp-split-parent-toggle" type="button" aria-expanded={expandedSplit} onClick={(event) => {
              event.stopPropagation()
              requestRowAction(row.original.id, (currentRow) => {
                if (!currentRow.allocations.length) { onError('That transaction is no longer split.'); return }
                setExpandedSplitIds((current) => {
                  const next = new Set(current)
                  if (next.has(currentRow.id)) next.delete(currentRow.id)
                  else next.add(currentRow.id)
                  return next
                })
              })
            }}><span className={`bp-split-parent-label${row.original.allocations.some((allocation) => allocation.unassigned && allocation.amount_cents !== 0) ? ' has-unassigned-warning' : ''}`}>{expandedSplit ? '▾' : '▸'} Split ({row.original.allocations.length}){row.original.allocations.some((allocation) => allocation.unassigned && allocation.amount_cents !== 0) && ` · ${formatCents(row.original.allocations.find((allocation) => allocation.unassigned && allocation.amount_cents !== 0)!.amount_cents, { symbol: true })} unassigned`}</span></button>
          }
          return (
            <td className={hasEditor ? 'has-cell-editor' : undefined} data-column={cell.column.id} key={cell.id} style={{ width: effectiveWidths[cell.column.id] }}>
              {content}
            </td>
          )
        })}
      </tr>
      {expandedSplit && !isSplitEditing && row.original.allocations.map((allocation, allocationIndex) => {
        const categoryIndex = row.getVisibleCells().findIndex((cell) => cell.column.id === 'category')
        const categoryMatches = hasValueSelection(filters.category) && valueSelected(filters.category, allocationCategoryKey(allocation))
        const memoMatches = filters.memo.trim() !== '' && allocation.memo.toLowerCase().includes(filters.memo.trim().toLowerCase())
        return <tr className={`bp-split-allocation${allocation.unassigned ? ' is-unassigned' : ''}${categoryMatches || memoMatches ? ' is-filter-match' : ''}`} key={`allocation-${allocation.id}`} data-split-line={allocationIndex} onClick={(event) => selectRow(event, row.original)}><td colSpan={Math.max(0, categoryIndex)} /><td className="bp-split-category" data-column="category"><div className="bp-split-line"><span className="bp-split-connector">{allocationIndex === row.original.allocations.length - 1 ? '└' : '├'}</span><span title={allocation.unassigned ? 'Added after a bank amount change.' : undefined}>{allocation.unassigned ? 'Unassigned split ⓘ' : allocation.category_name ? allocation.subcategory_name ? `${allocation.category_name}: ${allocation.subcategory_name}` : allocation.category_name : 'No category'}</span></div></td><td data-column="memo">{allocation.memo || emptyCell}</td>{separateAmountColumns ? <><td data-column="outflow"><span className="bp-amount is-negative">{allocation.amount_cents < 0 ? money(Math.abs(allocation.amount_cents)) : null}</span></td><td data-column="inflow"><span className="bp-amount is-positive">{allocation.amount_cents >= 0 ? money(Math.abs(allocation.amount_cents)) : null}</span></td></> : <td data-column="amount_cents"><span className="bp-amount">{money(allocation.amount_cents, true)}</span></td>}<td colSpan={Math.max(1, row.getVisibleCells().length - categoryIndex - (separateAmountColumns ? 4 : 3))} /></tr>
      })}
      {isSplitEditing && splitDraft && <LedgerSplitEditor
        key={splitDraft.originalToken}
        draft={splitDraft}
        hasChanges={splitHasChanges}
        categories={categories}
        columnCount={row.getVisibleCells().length}
        categoryColumnIndex={row.getVisibleCells().findIndex((cell) => cell.column.id === 'category')}
        separateAmountColumns={separateAmountColumns}
        disabled={writePending || aggregatePending || splitRecoveryReloading}
        recoveryDisabled={writePending || splitRecoveryReloading}
        onChange={changeSplit}
        onCancel={cancelEditing}
        onSave={saveSplit}
        onRefreshUnknown={async () => {
          await onInspectHistory()
          if ('is_draft' in row.original) {
            await onRefreshAfterApply(viewKey, false)
            return null
          }
          return apiClient.get<LedgerRow>(`/api/transactions/${row.original.id}`)
        }}
        onReloadSaved={async (current) => {
          const session = splitDraftRef.current
          if (!current.allocations.length) {
            const refreshed = await onRefreshAfterApply(viewKey, false)
            if (!refreshed) throw new Error('Saved transaction could not be refreshed.')
          }
          if (splitDraftRef.current === session) reloadSplit(current)
        }}
        onDiscardUncertain={cancelEditing}
        onUnsplitDraft={unsplitDraft}
        onRecoveryReloadingChange={setSplitRecoveryReloading}
        onRecoveryStateChange={setSplitRecoveryActive}
      />}
      </Fragment>
    )
  }

  const shortcutUnavailable = locked || splitRecoveryReloading || quickCreateBlocked || Boolean(splitDraft) || Boolean(draftRow) || openFilter !== null || contextMenu !== null || bulkWorkflowActive || selectionPhase !== 'idle'
  const shortcutBusy = pending || transientBusy || aggregatePending || writePending
  const shortcutInputOwner = useCallback((target: EventTarget | null) => (
    nativeLedgerShortcutOwner(target) || (target !== document.body && (!(target instanceof Node) || !ledgerShortcutBoundaryRef.current?.contains(target)))
  ), [])

  shortcutSelectionActionRef.current = () => {
    if (shortcutInputOwner(document.activeElement) || shortcutUnavailable || shortcutBusy || editingRef.current || splitDraftRef.current || persistedTransactions.length === 0) return
    selectShortcut()
    restoreGridFocusIfBody()
  }

  useEffect(() => {
    if (pendingShortcutSelection === null) return
    if (pendingShortcutSelection !== viewKey || editingRef.current || shortcutInputOwner(document.activeElement) || shortcutUnavailable || splitDraftRef.current) {
      setPendingShortcutSelection(null)
      return
    }
    if (shortcutBusy) return
    setPendingShortcutSelection(null)
    shortcutSelectionActionRef.current()
  }, [editing, editingRef, pendingShortcutSelection, shortcutBusy, shortcutInputOwner, shortcutUnavailable, splitDraftRef, viewKey])

  if (pending) return <div className="bp-state">Loading transactions…</div>

  return (
    <div ref={ledgerShortcutBoundaryRef} onKeyDownCapture={(event) => {
      if (isComposingKey(event.nativeEvent)) return
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
      if (event.defaultPrevented || event.repeat || event.altKey || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 'a') return
      if (shortcutInputOwner(event.target) || shortcutUnavailable || shortcutBusy || splitDraftRef.current) return
      event.preventDefault()
      continueSelectionAfterCommit(() => shortcutSelectionActionRef.current(), queueShortcutSelection)
    }} onKeyDown={(event) => {
      if (!splitDraft || event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event.nativeEvent)) return
      const target = event.target as Element
      if (target.closest('.bp-picker-popover, .bp-modal-overlay') || !target.closest(`[data-ledger-edit-session="${splitDraft.rowId}"], [data-ledger-edit-session="split-${splitDraft.rowId}"]`)) return
      event.preventDefault()
      event.stopPropagation()
      if (writePending || aggregatePending || splitRecoveryReloading || quickCreateBlocked) return
      keyboardRestoreRef.current = { id: splitDraft.rowId, isNew: Boolean(editing?.isNew), entryOrigin: draftRow && 'is_draft' in draftRow.original ? draftRow.original.entryOrigin : undefined }
      cancelEditing()
    }}>
      <div className="bp-selection-slot" ref={selectionSlotRef}>
        {revealTransactionId !== null && (accountInScope(accountById.get(revealAccountId ?? -1), accountId)) && <div className="bp-bulk-toolbar" role="status"><strong>Finding linked transfer in account history…</strong><Button size="md" onClick={onCancelReveal}>Cancel</Button></div>}
        {lifecyclePickerPending ? <div className="bp-bulk-toolbar"><strong>Choose the cleared transaction for {lifecyclePickerPending.description || 'this pending transaction'}</strong><Button size="md" onClick={onCancelLifecyclePicker}>Cancel</Button></div> : bulkToolbarVisible && <LedgerBulkToolbar
          bulk={bulk}
          payees={payees}
          accounts={accounts}
          categories={categories}
          accountId={accountId}
          openTransferAccountIds={openTransferAccountIds}
          selectedCount={selectedTransactionIds.size}
          canMatch={selectedPair !== null}
          onMatch={() => { if (selectedPair) onOpenMatch('manual', selectedPair.bank, selectedPair.history) }}
          onStartTransferQueue={startTransferQueue}
          usesPlaidWorkflow={usesPlaidWorkflow}
          canExpandSelection={canExpandSelection}
          matchingCount={filteredCount}
          selectionPhase={selectionPhase}
          onExpandSelection={() => { void expandSelection() }}
          onRetrySelection={retrySelection}
          onClose={() => {
            bulk.cancel()
            if (cancelSelectionRead()) return
            clearSelection()
          }}
        />}
      </div>
      <div className="bp-grid-frame" style={{ height }} inert={blockedBySchedule} onMouseDownCapture={(event) => {
        const target = event.target as Element
        if (event.button === 0 && gridShellRef.current?.contains(target) && !editingRef.current && !splitDraftRef.current && !target.closest('button, input, select, textarea, [contenteditable], [data-ledger-row-id]')) {
          gridShellRef.current.focus({ preventScroll: true })
        }
        const current = editingRef.current
        if (!current || (event.button !== 2 && !(event.button === 0 && event.ctrlKey))) return
        if (target.closest('input, textarea, select, [contenteditable]') && target.closest(`[data-ledger-edit-session="${current.id}"], [data-ledger-edit-session="split-${current.id}"]`)) return
        event.preventDefault()
      }} onClickCapture={(event) => {
        const current = editingRef.current
        if (!current || !current.isNew && !splitDraftRef.current || !event.ctrlKey || event.button !== 0) return
        const target = event.target as Element
        if (target.closest('input, textarea, select, [contenteditable]') && target.closest(`[data-ledger-edit-session="${current.id}"], [data-ledger-edit-session="split-${current.id}"]`)) return
        event.preventDefault()
        event.stopPropagation()
        if (!target.closest(`[data-ledger-edit-session="${current.id}"], [data-ledger-edit-session="split-${current.id}"]`)) onError('Save or cancel the current transaction first')
      }}>
      <div className="bp-grid-corner">
        <LedgerColumnsMenu
          open={columnsMenuOpen}
          onOpenChange={setColumnsMenuOpen}
          showTransferColumn={showTransferColumn}
          showBankDescription={showBankDescription}
          showRunningBalance={showRunningBalancePreference}
          separateAmountColumns={separateAmountColumns}
          balanceAvailable={balanceAvailable}
          descriptionFilterHidden={!showBankDescription && hasLedgerFilter(filters, 'description')}
          onChange={changeColumns}
        />
      </div>
      <div
        className="bp-grid-shell"
        ref={gridShellRef}
        tabIndex={-1}
        onScroll={() => {
          if (!onLedgerScroll()) return
          setOpenFilter(null)
          cancelPendingReveals()
          void loadOlderAtTop()
        }}
      >
        {loadingOlder && <div className="bp-ledger-loading" role="status">Loading older transactions…</div>}
        <table
          className="bp-table"
          data-busy={transientBusy && !bulk.hasStagedChanges && bulk.phase === 'idle' && !bulk.outcomeUnknown || undefined}
          aria-label="Transactions"
          style={{ width: tableWidth }}
        >
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const direction = header.column.getIsSorted()
                const sortOrder = sorting.findIndex((item) => item.id === header.column.id) + 1
                const filterKey = COLUMN_FILTER_KEYS[header.column.id]
                const filterLabel = COLUMN_FILTER_LABELS[header.column.id]
                const filterOpen = openFilter?.columnId === header.column.id
                const filterApplied = filterKey ? hasLedgerFilter(filters, filterKey) : false
                const filterSummary = filterKey === 'payee' || filterKey === 'category'
                  ? selectionSummary(filters[filterKey], filterLabelsRef.current[filterKey], filterKey === 'payee' ? 'payees' : 'categories')
                  : filterKey === 'status' ? statusSummary(filters.status) : null
                return (
                  <th key={header.id} data-column={header.column.id} aria-description={header.column.id === 'running_balance_cents' ? balanceDescription : undefined} className={filterOpen ? 'is-filter-open' : undefined} style={{ width: effectiveWidths[header.column.id] }}>
                    <div className="bp-table-header-controls">
                      {header.column.id === 'actions' ? (
                        <span className="bp-actions-header">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {!defaultSorting && <Button
                            className="bp-sort-reset"
                            size="sm"
                            variant="quiet"
                            iconOnly
                            aria-label="Return to default sort"
                            title="Return to default sort"
                            onClick={(event) => {
                              const button = event.currentTarget
                              onRequestWorkspaceAction(() => {
                                resetToBottom()
                                cancelPendingReveals()
                                if (document.activeElement === button) gridShellRef.current?.querySelector<HTMLElement>('th[data-column="date"] button')?.focus({ preventScroll: true })
                                setSorting([])
                              })
                            }}
                          ><ListSortAscending aria-hidden="true" /><RotateCcw aria-hidden="true" /></Button>}
                        </span>
                      ) : header.column.id === 'running_balance_cents' ? (
                        <span className="bp-table-sort" role="note" tabIndex={0} title={balanceDescription} aria-label="Balance" aria-description={balanceDescription}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <Info className="bp-balance-info" aria-hidden="true" />
                        </span>
                      ) : (
                        <button
                          className="bp-table-sort"
                          type="button"
                          onClick={(event) => {
                            if (!header.column.getCanSort()) return
                            onRequestWorkspaceAction(() => {
                              resetToBottom()
                              cancelPendingReveals()
                              header.column.getToggleSortingHandler()?.(event)
                            })
                          }}
                          title="Click to sort; Shift-click to add up to three columns"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {defaultSorting && header.column.id === (usesPlaidWorkflow ? 'status' : 'date') && (
                            <span className="bp-sort-indicator" title={usesPlaidWorkflow ? 'Default sort: status groups, then Date ascending' : 'Default sort: Date ascending'} aria-label={usesPlaidWorkflow ? 'Default sort: status groups, then Date ascending' : 'Default sort: Date ascending'}>
                              <ListOrdered aria-hidden="true" />
                            </span>
                          )}
                          {direction && (
                            <span className="bp-sort-indicator" aria-label={`${direction === 'asc' ? 'ascending' : 'descending'}, priority ${sortOrder}`}>
                              {direction === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
                              {sorting.length > 1 && <sup>{sortOrder}</sup>}
                            </span>
                          )}
                        </button>
                      )}
                      {filterKey && (
                        <div className="bp-table-filter-area">
                          <Button
                            className={`bp-table-filter${filterApplied ? ' is-applied' : ''}`}
                            size="sm"
                            variant="quiet"
                            iconOnly
                            aria-label={filterApplied ? `Edit ${filterLabel} filter` : `Filter ${filterLabel}`}
                            aria-expanded={filterOpen}
                            title={`${filterApplied ? 'Edit' : 'Filter'} ${filterLabel}${filterSummary ? `: ${filterSummary}` : ''}`}
                            onKeyDown={(event) => { if ((isComposingKey(event.nativeEvent) || event.repeat) && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation() } }}
                            onClick={(event) => {
                              const anchor = event.currentTarget
                              onRequestWorkspaceAction(() => setOpenFilter((current) => current?.columnId === header.column.id
                                ? null
                                : { columnId: header.column.id, anchor }))
                            }}
                          >
                            {filterApplied ? <FunnelX aria-hidden="true" /> : <Funnel aria-hidden="true" />}
                          </Button>
                          {filterOpen && (filterKey === 'payee' || filterKey === 'category' || filterKey === 'status' ? (
                            <LedgerCheckboxFilter
                              key={filterKey}
                              kind={filterKey}
                              value={filters[filterKey]}
                              options={filterKey === 'status' ? [] : checkboxOptions[filterKey]}
                              catalog={filterKey === 'status' ? undefined : catalogKeys[filterKey]}
                              loadState={filterKey === 'status' ? 'ready' : filterChoices.isError ? 'error' : filterChoices.data && !filterChoices.isFetching ? 'ready' : 'loading'}
                              labels={filterKey === 'status' ? new Map() : filterLabelsRef.current[filterKey]}
                              anchor={openFilter.anchor}
                              onApply={(value) => {
                                if (JSON.stringify(value) !== JSON.stringify(filters[filterKey])) filterReturnFocusRef.current = { columnId: header.column.id, accountId, generation: filterViewGeneration + 1, anchor: openFilter.anchor }
                                onFilterChange(filterKey, value)
                              }}
                              onClose={() => setOpenFilter(null)}
                            />
                          ) : (
                            <ColumnFilterPopover
                              accountId={accountId}
                              filterKey={filterKey}
                              label={filterLabel}
                              value={filters[filterKey]}
                              anchor={openFilter.anchor}
                              onApply={(value) => onFilterChange(filterKey, value)}
                              onClose={() => setOpenFilter(null)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                    {header.column.getCanResize() && (
                      <span
                        className={`bp-column-resizer${resizingColumnId === header.column.id ? ' is-resizing' : ''}`}
                        role="separator"
                        aria-label={`Resize ${header.column.id} column`}
                        aria-orientation="vertical"
                        onDoubleClick={() => resetColumnSize(header.column.id)}
                        onPointerDown={(event) => startColumnResize(
                          event,
                          header.column.id,
                          header.column.columnDef.minSize ?? 72,
                          header.column.columnDef.maxSize ?? 520,
                        )}
                        onPointerMove={moveColumnResize}
                        onPointerUp={endColumnResize}
                        onPointerCancel={endColumnResize}
                      />
                    )}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>{ledgerRows.map((row) => renderLedgerRow(row))}</tbody>
        </table>
        {ledgerRows.length === 0 && draftRow === null && (
          <div className="bp-grid-empty-results" role="status">
            {allCount === 0
              ? <><strong>No transactions yet</strong><span>Add a transaction to get started.</span></>
              : <strong>No transactions match these filters.</strong>}
          </div>
        )}
      </div>
        {draftRow && (
          <div className="bp-new-transaction-composer">
            <table className="bp-table" aria-label="New transaction" style={{ width: tableWidth }}>
              <tbody>{renderLedgerRow(draftRow)}</tbody>
            </table>
          </div>
        )}
      </div>
      {renderFooter({ count: selectedTransactionIds.size, totalCents: selectedTotalCents })}
      {entryExit.dialog && <NewEntryExitDialog noun="transaction" issues={entryExit.dialog.issues} onContinue={entryExit.continueEditing} onDiscard={entryExit.discard} />}
      {contextMenu && !editing && <LedgerContextMenu
        rows={contextMenu.rows}
        accounts={accounts}
        accountId={accountId}
        anchor={{ left: contextMenu.left, top: contextMenu.top }}
        changes={bulk.changes}
        expandedSelection={expandedSelection}
        onDismiss={closeContextMenu}
        onFocusRow={focusContextRow}
        onDuplicate={(source) => { onDuplicate(source); clearSelection() }}
        onMakeRecurring={(source) => { onMakeRecurring(source); clearSelection() }}
        onStage={(field, value) => bulk.stage(field, value as never)}
        onMove={onMoveMany}
        onDelete={onDeleteMany}
        onExclude={onExclude}
        onRestore={() => onRestore(contextMenu.rows.map((row) => ({ id: row.id, edit_token: row.edit_token })))}
        onClearance={onToggleClearance}
        onReview={onReview}
        onManualClearance={onManualClearance}
        stateCommandsBlocked={stateCommandsBlocked || Boolean(splitDraft || draftRow) || bulk.frozen || bulk.outcomeUnknown || bulk.transferMode || !bulk.selectionReady}
        relationshipCommandsBlocked={relationshipCommandsBlocked}
        onOpenMatch={openRowMatch}
        onResolveLifecycle={openRowLifecycle}
        onFindMatch={onFindMatch}
        onMatchPair={(rows) => {
          const pair = selectedMatchPair(rows)
          if (pair) onOpenMatch('manual', pair.bank, pair.history)
        }}
        onFindTransfer={(rows) => {
          if (rows.length === 1) onOpenTransfer(rows[0])
          else onStartFindTransferQueue(rows.map((row) => ({ id: row.id, edit_token: row.edit_token })))
        }}
        onInspectConnections={inspectRowConnections}
        onGoToTransfer={onGoToTransfer}
        onError={onError}
      />}
    </div>
  )
}

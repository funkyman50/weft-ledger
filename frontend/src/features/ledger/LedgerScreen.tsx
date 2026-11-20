import { accountInScope, isCombinedScope, scopeGroupName, type AccountScope } from '../../lib/accountScope'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { FocusEvent, PointerEvent, ReactNode } from 'react'
import { Download, Pencil, Redo, TriangleAlert, Undo, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  invalidateAccountAndTransactionQueries,
  useAccounts,
  useCategories,
  usePayees,
  usePlaidStatus,
  useScheduledTransactions,
} from '../../api/hooks'
import type { PayeeDefaultCategorySuggestion, PlaidStatus, Account } from '../../api/types'
import type { LedgerRow, TransactionConnectionsContext, ScheduleDefinition, ScheduleLookAhead } from '../../api/types'
import { ApiError, apiClient } from '../../api/client'
import { Button } from '../../components/Button'
import { DialogHeader } from '../../components/DialogHeader'
import { deferDialog } from '../../components/DeferredDialog'
import { FilterSelect } from '../../components/FilterSelect'
import { Modal, ModalCornerProvider, ModalRecoveryNoticeProvider } from '../../components/Modal'
import { money } from '../../lib/money'
import type { MatchDialogMode } from './MatchDialog'
import { PlaidConnectionWorkflow, PlaidSyncAction, RefreshBankDialog } from '../plaid/PlaidConnectionWorkflow'
import { useLedgerPage } from './useLedgerPage'
import { hasActiveLedgerFilters } from './ledgerFilters'
import { resetInitializationIntroCooldown } from '../accounts/initializationOnboardingCooldown'
import { AccountRail, type AccountMenuAction, type ConnectionHealth } from '../accounts/AccountRail'
import type { AccountDialogAction } from '../accounts/AccountDialog'
import { accountBankDifference } from '../accounts/accountBalances'
import { accountTypeLabel } from '../accounts/accountTypes'
import { LedgerRegisterTable } from './LedgerTable'
import { STAGED_CHANGES_NOTICE } from './LedgerBulkControls'
import { useLedgerEditor, type EditorTransferIntent } from './useLedgerEditor'
import { useLedgerCommands } from './useLedgerCommands'
import { useMatchWorkflow } from './useMatchWorkflow'
import { usePendingLifecycleWorkflow } from './usePendingLifecycleWorkflow'
import { useTransferWorkflow } from './useTransferWorkflow'
import { useLedgerWorkspace } from './useLedgerWorkspace'
import { ScheduledPane } from './ScheduledPane'
import { dateLabel } from './transactionDisplay'
import { LoanDifferenceButton } from './LoanDifferenceButton'
import { PayeeDefaultCategorySuggestionDialog } from './PayeeDefaultCategorySuggestionDialog'

const LoanDetailsDialog = deferDialog(() => import('../accounts/LoanDetailsDialog').then((module) => module.LoanDetailsDialog), 'Loan details')
const ResolveDifferenceDialog = deferDialog(() => import('./ResolveDifferenceDialog').then((module) => module.ResolveDifferenceDialog), 'Resolve difference', 'corner')
const AccountDialog = deferDialog(() => import('../accounts/AccountDialog').then((module) => module.AccountDialog), 'Account settings')
const AccountConversionDialog = deferDialog(() => import('../accounts/AccountConversionDialog').then((module) => module.AccountConversionDialog), 'Connect bank account')
const StartingBalanceDialog = deferDialog(() => import('../accounts/StartingBalanceDialog').then((module) => module.StartingBalanceDialog), 'Initialize account')
const CategoryManagerDialog = deferDialog(() => import('../categories/CategoryManagerDialog').then((module) => module.CategoryManagerDialog), 'Categories')
const PayeeManagerDialog = deferDialog(() => import('../payees/PayeeManagerDialog').then((module) => module.PayeeManagerDialog), 'Payees')
const SystemSettingsDialog = deferDialog(() => import('../settings/SystemSettingsDialog').then((module) => module.SystemSettingsDialog), 'System settings')
const ExportDialog = deferDialog(() => import('./ExportDialog').then((module) => module.ExportDialog), 'Export')
const MatchWorkflow = deferDialog(() => import('./MatchWorkflow').then((module) => module.MatchWorkflow), 'Match transaction')
const PendingLifecycleDialog = deferDialog(() => import('./MatchDialog').then((module) => module.PendingLifecycleDialog), 'Resolve pending transaction')
const TransactionConnectionsDialog = deferDialog(() => import('./BankContinuityDialog').then((module) => module.TransactionConnectionsDialog), 'Transaction connections')
const TransferLinkDialog = deferDialog(() => import('./TransferLinkDialog').then((module) => module.TransferLinkDialog), 'Transfer')

const DISMISSED_PLAID_SYNC_KEY = 'weft.dismissedPlaidSync'
const SEPARATE_AMOUNT_COLUMNS_KEY = 'weft.separateAmountColumns'
const SHOW_ACCOUNT_ICONS_KEY = 'weft.showAccountIcons'
const HIGHLIGHT_BANK_DIFFERENCES_KEY = 'weft.highlightBankDifferences'
const COMPACT_MODE_KEY = 'weft.compactMode'
const SHOW_RUNNING_BALANCE_KEY = 'weft.showRunningBalance'
const SHOW_BANK_DESCRIPTION_KEY = 'weft.showBankDescription'
const SHOW_TRANSFER_COLUMN_KEY = 'weft.showTransferColumn'
const SHOW_NEW_TRANSACTION_KEY = 'weft.showNewTransaction'
const REVIEW_AFTER_EDIT_KEY = 'weft.reviewAfterEdit'
const SCHEDULE_PANE_KEY = 'weft.schedulePane'
const NOTICE_MIN_VISIBLE_MS = 5_000
const NOTICE_MAX_VISIBLE_MS = 12_000
const NOTICE_MS_PER_CHARACTER = 70
const SYNC_NOTICE_VISIBLE_MS = 30_000
const NOTICE_FADE_MS = 240

type NoticeTone = 'neutral' | 'warning' | 'error'
type SchedulePanePreference = { visible: boolean; height: number; lookAhead: ScheduleLookAhead; showProjectedBalance: boolean }

function readSchedulePanePreference(accountId: AccountScope | null): SchedulePanePreference {
  const fallback: SchedulePanePreference = { visible: true, height: 200, lookAhead: 'off', showProjectedBalance: false }
  if (accountId === null) return fallback
  try {
    const stored = JSON.parse(localStorage.getItem(`${SCHEDULE_PANE_KEY}.${accountId}`) ?? 'null')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return fallback
    return {
      visible: typeof stored.visible === 'boolean' ? stored.visible : fallback.visible,
      height: typeof stored.height === 'number' && Number.isFinite(stored.height) ? Math.max(120, Math.min(500, stored.height)) : fallback.height,
      lookAhead: ['end_of_month', '4_weeks', '12_weeks'].includes(stored.lookAhead) ? stored.lookAhead : 'off',
      showProjectedBalance: stored.showProjectedBalance === true,
    }
  } catch { return fallback }
}

interface WorkspaceNotice {
  id: number
  message: string
  title?: string
  tone: NoticeTone
  dismissalKey?: string
  lastSync?: string
  persistent?: boolean
}

interface PlaidSyncDismissal {
  lastSync: string
  dismissedKeys: string[]
}

function noticeVisibleMs(notice: WorkspaceNotice): number {
  if (notice.lastSync) return SYNC_NOTICE_VISIBLE_MS
  return Math.min(NOTICE_MAX_VISIBLE_MS, Math.max(NOTICE_MIN_VISIBLE_MS, notice.message.length * NOTICE_MS_PER_CHARACTER))
}

function WorkspaceNoticeFrame({
  title,
  message,
  tone = 'neutral',
  role,
  actions,
  fading = false,
  onPointerEnter,
  onPointerLeave,
  onFocusCapture,
  onBlurCapture,
}: {
  title?: string
  message: string
  tone?: NoticeTone
  role?: 'alert'
  actions?: ReactNode
  fading?: boolean
  onPointerEnter?: (event: PointerEvent<HTMLDivElement>) => void
  onPointerLeave?: (event: PointerEvent<HTMLDivElement>) => void
  onFocusCapture?: (event: FocusEvent<HTMLDivElement>) => void
  onBlurCapture?: (event: FocusEvent<HTMLDivElement>) => void
}) {
  return <div className={`bp-notice bp-notice--${tone}${fading ? ' is-fading' : ''}`} role={role} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onFocusCapture={onFocusCapture} onBlurCapture={onBlurCapture}>
    <div className="bp-notice-copy">
      {title && <strong className="bp-notice-title">{title}</strong>}
      <span>{message}</span>
    </div>
    {actions && <div className="bp-notice-actions">{actions}</div>}
  </div>
}

function WorkspaceNoticeItem({ notice, onDismiss }: { notice: WorkspaceNotice; onDismiss: (id: number, dismissalKey?: string, lastSync?: string) => void }) {
  const [fading, setFading] = useState(false)
  const remainingRef = useRef(0)
  const startedAtRef = useRef(0)
  const fadeTimerRef = useRef<number | null>(null)
  const removeTimerRef = useRef<number | null>(null)
  const pointerInsideRef = useRef(false)
  const focusInsideRef = useRef(false)

  const clearTimers = useCallback(() => {
    if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current)
    if (removeTimerRef.current !== null) window.clearTimeout(removeTimerRef.current)
    fadeTimerRef.current = null
    removeTimerRef.current = null
  }, [])

  const schedule = useCallback(() => {
    if (notice.persistent) return
    const remaining = remainingRef.current
    startedAtRef.current = performance.now()
    if (remaining > NOTICE_FADE_MS) {
      setFading(false)
      fadeTimerRef.current = window.setTimeout(() => setFading(true), remaining - NOTICE_FADE_MS)
    } else {
      setFading(true)
    }
    removeTimerRef.current = window.setTimeout(() => onDismiss(notice.id, notice.dismissalKey, notice.lastSync), remaining)
  }, [notice.dismissalKey, notice.id, notice.lastSync, notice.persistent, onDismiss])

  useEffect(() => {
    remainingRef.current = noticeVisibleMs(notice) + NOTICE_FADE_MS
    pointerInsideRef.current = false
    focusInsideRef.current = false
    setFading(false)
    schedule()
    return () => {
      clearTimers()
    }
  }, [clearTimers, notice, schedule])

  const pause = useCallback(() => {
    if (notice.persistent || fadeTimerRef.current === null && removeTimerRef.current === null) return
    remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - startedAtRef.current))
    clearTimers()
    setFading(false)
  }, [clearTimers, notice.persistent])

  const resume = useCallback(() => {
    if (!pointerInsideRef.current && !focusInsideRef.current) schedule()
  }, [schedule])

  return <WorkspaceNoticeFrame
    title={notice.title}
    message={notice.message}
    tone={notice.tone}
    role={notice.tone === 'error' ? 'alert' : undefined}
    fading={fading}
    onPointerEnter={() => { pointerInsideRef.current = true; pause() }}
    onPointerLeave={() => { pointerInsideRef.current = false; resume() }}
    onFocusCapture={() => { focusInsideRef.current = true; pause() }}
    onBlurCapture={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node)) return
      focusInsideRef.current = false
      resume()
    }}
    actions={<Button size="md" variant="quiet" iconOnly aria-label={notice.title ? `Dismiss ${notice.title}: ${notice.message}` : `Dismiss notice: ${notice.message}`} onClick={() => onDismiss(notice.id, notice.dismissalKey, notice.lastSync)}><X aria-hidden="true" /></Button>}
  />
}

function syncIssueKey(issue: PlaidStatus['errors'][number]): string {
  return JSON.stringify({
    kind: issue.kind,
    accountIds: [...issue.account_ids].sort((left, right) => left - right),
    missingAccountIds: [...issue.missing_account_ids].sort((left, right) => left - right),
  })
}

function syncCompletionNotices(result: PlaidStatus, lastSync: string): Omit<WorkspaceNotice, 'id'>[] {
  const providerIssues = result.errors.filter((issue) => issue.kind !== 'schedule_entry')
  const hasFailures = providerIssues.some((issue) => issue.kind !== 'transaction_warning')
  const counts = `${result.added} added · ${result.matched} matched · ${result.suggested} suggested · ${result.queued} need review`
  const summary: Omit<WorkspaceNotice, 'id'> = {
    title: hasFailures ? 'Sync finished with errors' : providerIssues.length > 0 ? 'Sync complete with notices' : 'Sync complete',
    message: counts,
    tone: hasFailures ? 'warning' : 'neutral',
    dismissalKey: 'summary',
    lastSync,
  }
  const issues = new Map<string, Omit<WorkspaceNotice, 'id'>>()
  for (const issue of providerIssues) {
    const dismissalKey = syncIssueKey(issue)
    if (issues.has(dismissalKey)) continue
    const temporary = issue.kind === 'temporary'
    const warning = issue.kind === 'transaction_warning'
    issues.set(dismissalKey, {
      title: issue.kind === 'rule_evaluation' ? 'Payee rules need attention' : warning ? 'Bank transaction notice' : temporary ? 'Bank refresh failed' : 'Bank connection needs attention',
      message: issue.message,
      tone: warning ? 'warning' : 'error',
      dismissalKey,
      lastSync,
      persistent: true,
    })
  }
  return [summary, ...issues.values()]
}

function readPlaidSyncDismissal(value: string | null): PlaidSyncDismissal | null {
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed === 'object'
      && parsed !== null
      && 'lastSync' in parsed
      && 'dismissedKeys' in parsed
      && typeof parsed.lastSync === 'string'
      && Array.isArray(parsed.dismissedKeys)
      && parsed.dismissedKeys.every((key) => typeof key === 'string')
    ) return { lastSync: parsed.lastSync, dismissedKeys: parsed.dismissedKeys }
  } catch {
    return null
  }
  return null
}

export function LedgerScreen() {
  const queryClient = useQueryClient()
  const [historyRegistered, setHistoryRegistered] = useState(false)
  const { data: accounts, isPending: accountsPending, isError: accountsError } = useAccounts(historyRegistered)
  const { data: payees = [] } = usePayees(historyRegistered)
  const { data: categories = [] } = useCategories(historyRegistered)
  const { data: plaidStatus } = usePlaidStatus()
  const [selectedAccountId, setSelectedAccountId] = useState<AccountScope | null>(null)
  const groupName = scopeGroupName(selectedAccountId)
  const combinedScopeSelected = isCombinedScope(selectedAccountId)
  const scopeAccounts = useMemo(() => (accounts ?? []).filter((account) => accountInScope(account, selectedAccountId)), [accounts, selectedAccountId])
  const bankDifferences = scopeAccounts.flatMap((account) => {
    const difference = accountBankDifference(account)
    return difference === null ? [] : [{ account, difference }]
  })
  const groupMemberKey = groupName === null ? '' : JSON.stringify(scopeAccounts.map((account) => account.id).sort((left, right) => left - right))
  const schedules = useScheduledTransactions(selectedAccountId, historyRegistered, groupMemberKey)
  const [scheduleLoading, setScheduleLoading] = useState(false)
  const [scheduleSeed, setScheduleSeed] = useState<ScheduleDefinition | null>(null)
  const schedulePreferencesRef = useRef<Record<string, SchedulePanePreference>>({})
  const [schedulePreferences, setSchedulePreferences] = useState(schedulePreferencesRef.current)
  const savedSchedulePreference = useMemo(() => readSchedulePanePreference(selectedAccountId), [selectedAccountId])
  const schedulePreference = selectedAccountId === null ? savedSchedulePreference : schedulePreferences[selectedAccountId] ?? savedSchedulePreference
  const { visible: schedulesVisible, height: scheduleHeight, lookAhead: scheduleLookAhead, showProjectedBalance } = schedulePreference
  const consumeScheduleSeed = useCallback(() => setScheduleSeed(null), [])
  const changeSchedulePreference = (changes: Partial<SchedulePanePreference>, persist = true) => {
    if (selectedAccountId === null) return
    const next = { ...(schedulePreferencesRef.current[selectedAccountId] ?? savedSchedulePreference), ...changes }
    schedulePreferencesRef.current = { ...schedulePreferencesRef.current, [selectedAccountId]: next }
    setSchedulePreferences(schedulePreferencesRef.current)
    if (persist) { try { localStorage.setItem(`${SCHEDULE_PANE_KEY}.${selectedAccountId}`, JSON.stringify(next)) } catch { } }
  }
  const resizeSchedules = (height: number, persist = true) => {
    const next = Math.max(120, Math.min(500, window.innerHeight - 420, height))
    changeSchedulePreference({ height: next }, persist)
  }
  const changeScheduleVisibility = (visible: boolean) => changeSchedulePreference({ visible })
  const toggleSchedules = () => {
    requestWorkspaceAction(() => changeScheduleVisibility(!schedulesVisible))
  }
  const observedScheduleRevision = useRef<number | null>(null)

  const [notices, setNotices] = useState<WorkspaceNotice[]>([])
  const [noticeAnnouncement, setNoticeAnnouncement] = useState({ revision: 0, message: '' })
  const noticeRevisionRef = useRef(0)
  const observedPlaidSyncRef = useRef<string | null>(null)
  const dismissedPlaidSyncRef = useRef<PlaidSyncDismissal | null | undefined>(undefined)
  if (dismissedPlaidSyncRef.current === undefined) {
    try {
      dismissedPlaidSyncRef.current = readPlaidSyncDismissal(localStorage.getItem(DISMISSED_PLAID_SYNC_KEY))
    } catch {
      dismissedPlaidSyncRef.current = null
    }
  }
  const [loanDetails, setLoanDetails] = useState<{ account: Account; resolveAfter: boolean } | null>(null)
  const [resolveAccount, setResolveAccount] = useState<Account | null>(null)
  const [accountDialog, setAccountDialog] = useState<{
    mode: 'create' | 'edit'
    accountId?: number
    action?: AccountDialogAction
  } | null>(null)
  const [refreshAccount, setRefreshAccount] = useState<Account | null>(null)
  const [conversion, setConversion] = useState<{ accountId: number; open: boolean; outcomeUnknown: boolean } | null>(null)
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [payeeDialogOpen, setPayeeDialogOpen] = useState(false)
  const [payeeDialogSelection, setPayeeDialogSelection] = useState<number | null>(null)
  const [payeeRecoveryActive, setPayeeRecoveryActive] = useState(false)
  const [exportScope, setExportScope] = useState<AccountScope | null>(null)
  const exportDialogOpen = exportScope !== null
  const [newTransactionChooserOpen, setNewTransactionChooserOpen] = useState(false)
  const [newTransactionAccountId, setNewTransactionAccountId] = useState<number | null>(null)
  const [newEntryOrigin, setNewEntryOrigin] = useState<'transaction' | 'transfer'>('transaction')
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(false)
  const [showAccountIcons, setShowAccountIcons] = useState(() => {
    try {
      return localStorage.getItem(SHOW_ACCOUNT_ICONS_KEY) !== 'false'
    } catch {
      return true
    }
  })
  const [highlightBankDifferences, setHighlightBankDifferences] = useState(() => {
    try {
      return localStorage.getItem(HIGHLIGHT_BANK_DIFFERENCES_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [compactMode, setCompactMode] = useState(() => {
    try {
      return localStorage.getItem(COMPACT_MODE_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [defaultSuggestion, setDefaultSuggestion] = useState<{ transactionId: number; payeeId: number; categoryId: number; scope: AccountScope; phase: 'settling' | 'ready' } | null>(null)
  const [defaultSuggestionDialog, setDefaultSuggestionDialog] = useState<PayeeDefaultCategorySuggestion | null>(null)
  const [separateAmountColumns, setSeparateAmountColumns] = useState(() => {
    try {
      return localStorage.getItem(SEPARATE_AMOUNT_COLUMNS_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [showBankDescription, setShowBankDescription] = useState(() => {
    try {
      return localStorage.getItem(SHOW_BANK_DESCRIPTION_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [showTransferColumn, setShowTransferColumn] = useState(() => {
    try {
      return localStorage.getItem(SHOW_TRANSFER_COLUMN_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [showRunningBalance, setShowRunningBalance] = useState(() => {
    try {
      return localStorage.getItem(SHOW_RUNNING_BALANCE_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [startingBalanceAccountId, setStartingBalanceAccountId] = useState<number | null>(null)
  const [showNewTransaction, setShowNewTransaction] = useState(() => {
    try {
      return localStorage.getItem(SHOW_NEW_TRANSACTION_KEY) !== 'false'
    } catch {
      return true
    }
  })
  const [initializationAnnouncement, setInitializationAnnouncement] = useState('')
  const [reviewAfterEdit, setReviewAfterEdit] = useState(() => {
    try {
      return localStorage.getItem(REVIEW_AFTER_EDIT_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [bulkStaged, setBulkStaged] = useState(false)
  const [registerSelected, setRegisterSelected] = useState(false)
  const [scheduleSelected, setScheduleSelected] = useState(false)
  const [selectionSlot, setSelectionSlot] = useState<HTMLDivElement | null>(null)
  const [reveal, setReveal] = useState<{ sourceId: number; partnerId: number; accountId: number } | null>(null)
  const revealGenerationRef = useRef(0)
  const cancelReveal = useCallback(() => {
    revealGenerationRef.current += 1
    setReveal(null)
  }, [])

  const openAccounts = useMemo(
    () => (accounts ?? []).filter((account) => !account.closed),
    [accounts],
  )
  const closedAccounts = useMemo(
    () => (accounts ?? []).filter((account) => account.closed),
    [accounts],
  )
  const selectedAccount = (accounts ?? []).find((account) => account.id === selectedAccountId)
  const scopeNeedsReview = useMemo(
    () => scopeAccounts.reduce((count, account) => count + account.pending_count, 0),
    [scopeAccounts],
  )
  const initializedOpenAccounts = useMemo(
    () => openAccounts.filter((account) => !account.plaid_connection || account.starting_balance_initialized_at !== null),
    [openAccounts],
  )
  const entryAccounts = useMemo(() => groupName === null ? initializedOpenAccounts : initializedOpenAccounts.filter((account) => accountInScope(account, selectedAccountId)), [groupName, initializedOpenAccounts, selectedAccountId])
  const newTransactionAccountOptions = useMemo(
    () => (newEntryOrigin === 'transfer' && initializedOpenAccounts.length < 2 ? [] : entryAccounts).map((account) => ({ value: String(account.id), label: account.name })),
    [entryAccounts, initializedOpenAccounts, newEntryOrigin],
  )
  const defaultSuggestionPayee = defaultSuggestionDialog ? payees.find((payee) => payee.id === defaultSuggestionDialog.payee_id) : null
  const defaultSuggestionParent = defaultSuggestionDialog ? categories.find((parent) => parent.children?.some((child) => child.id === defaultSuggestionDialog.category_id)) : null
  const defaultSuggestionCategory = defaultSuggestionParent?.children?.find((child) => child.id === defaultSuggestionDialog?.category_id) ?? null
  const startingBalanceAccount = (accounts ?? []).find((account) => account.id === startingBalanceAccountId)
  const usesPlaidWorkflow = combinedScopeSelected || Boolean(selectedAccount?.plaid_connection)
  const initializationPending = Boolean(selectedAccount?.plaid_connection && selectedAccount.starting_balance_initialized_at === null)
  const initialImportActive = Boolean(selectedAccount && plaidStatus?.initial_import_account_ids?.includes(selectedAccount.id))
  const initializationState = initialImportActive
    ? 'downloading'
    : selectedAccount?.plaid_history_imported_at === null
      ? 'unready'
      : selectedAccount?.plaid_current_balance_cents === null
        ? 'no-balance'
        : 'ready'
  const initializationEditButtonRef = useRef<HTMLButtonElement | null>(null)
  const initializationStartButtonRef = useRef<HTMLButtonElement | null>(null)
  const initializationCardRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return
    return () => {
      if (node.contains(document.activeElement)) initializationEditButtonRef.current?.focus()
    }
  }, [])
  const selectedInitializationRef = useRef({ accountId: selectedAccountId, pending: initializationPending })
  const announceNotice = useCallback((message: string) => {
    setNoticeAnnouncement((current) => ({ revision: current.revision + 1, message }))
  }, [])
  const showNotice = useCallback((message: string, tone: NoticeTone = 'neutral') => {
    noticeRevisionRef.current += 1
    const id = noticeRevisionRef.current
    setNotices((current) => [...current.filter((notice) => notice.lastSync || notice.message !== message || notice.tone !== tone), { id, message, tone }])
    if (tone === 'neutral') announceNotice(message)
  }, [announceNotice])
  const showError = useCallback((message: string) => {
    showNotice(message, 'error')
  }, [showNotice])
  const dismissNotice = useCallback((id: number, dismissalKey?: string, lastSync?: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id))
    if (!dismissalKey || !lastSync || dismissedPlaidSyncRef.current?.lastSync !== lastSync) return
    const current = dismissedPlaidSyncRef.current
    if (current.dismissedKeys.includes(dismissalKey)) return
    const next = { ...current, dismissedKeys: [...current.dismissedKeys, dismissalKey] }
    dismissedPlaidSyncRef.current = next
    try {
      localStorage.setItem(DISMISSED_PLAID_SYNC_KEY, JSON.stringify(next))
    } catch {
      return
    }
  }, [])
  useEffect(() => {
    const previous = selectedInitializationRef.current
    if (previous.accountId !== selectedAccountId || initializationPending) {
      setInitializationAnnouncement('')
    }
    if (previous.accountId === selectedAccountId && previous.pending && !initializationPending && selectedAccount) {
      setInitializationAnnouncement('Account initialized. Register ready.')
    }
    selectedInitializationRef.current = { accountId: selectedAccountId, pending: initializationPending }
  }, [initializationPending, selectedAccount, selectedAccountId])
  useEffect(() => {
    if (groupName !== null) return
    if (!(accounts ?? []).length) {
      setSelectedAccountId(null)
      return
    }
    if (
      selectedAccountId === null
      || (selectedAccountId !== 'all' && !(accounts ?? []).some((account) => account.id === selectedAccountId))
    ) {
      setSelectedAccountId(openAccounts[0]?.id ?? closedAccounts[0]?.id ?? null)
    }
  }, [accounts, closedAccounts, groupName, openAccounts, selectedAccountId])

  useEffect(() => setAccountDialog(null), [selectedAccountId])
  useEffect(() => setStartingBalanceAccountId(null), [selectedAccountId])
  useEffect(() => setDefaultSuggestionDialog(null), [selectedAccountId])

  useEffect(() => {
    if (reveal && !accountInScope((accounts ?? []).find((account) => account.id === reveal.accountId), selectedAccountId)) cancelReveal()
  }, [accounts, cancelReveal, reveal, selectedAccountId])

  useEffect(() => {
    const lastSync = plaidStatus?.last_sync
    if (!lastSync || observedPlaidSyncRef.current === lastSync) return
    observedPlaidSyncRef.current = lastSync
    const captured = syncCompletionNotices(plaidStatus, lastSync)
    const issueKeys = new Set(captured.filter((notice) => notice.dismissalKey !== 'summary').map((notice) => notice.dismissalKey))
    const previous = dismissedPlaidSyncRef.current
    const dismissedKeys = previous?.lastSync === lastSync
      ? previous.dismissedKeys
      : previous?.dismissedKeys.filter((key) => key !== 'summary' && issueKeys.has(key)) ?? []
    const dismissal = { lastSync, dismissedKeys }
    dismissedPlaidSyncRef.current = dismissal
    try {
      localStorage.setItem(DISMISSED_PLAID_SYNC_KEY, JSON.stringify(dismissal))
    } catch {
    }
    const visible = captured.filter((notice) => !dismissedKeys.includes(notice.dismissalKey ?? ''))
    const syncNotices = visible.map((notice) => ({ ...notice, id: ++noticeRevisionRef.current }))
    setNotices((current) => [...current.filter((notice) => !notice.lastSync), ...syncNotices])
    const neutralMessages = visible.filter((notice) => notice.tone !== 'error').map((notice) => [notice.title, notice.message].filter(Boolean).join('. '))
    if (neutralMessages.length > 0) setNoticeAnnouncement((current) => ({ revision: current.revision + 1, message: neutralMessages.join(' ') }))
    void invalidateAccountAndTransactionQueries(queryClient)
  }, [plaidStatus, queryClient])

  useEffect(() => {
    const revision = plaidStatus?.schedule_revision
    if (revision === undefined || observedScheduleRevision.current === revision) return
    observedScheduleRevision.current = revision
    const issues = (plaidStatus?.errors ?? []).filter((issue) => issue.kind === 'schedule_entry')
    setNotices((current) => [...current.filter((notice) => notice.title !== 'Scheduled entry needs attention'), ...issues.map((issue) => ({ id: ++noticeRevisionRef.current, title: 'Scheduled entry needs attention', message: issue.message, tone: 'error' as const, persistent: true }))])
    void invalidateAccountAndTransactionQueries(queryClient)
  }, [plaidStatus, queryClient])

  const matchWorkflow = useMatchWorkflow(showNotice)
  const pendingWorkflow = usePendingLifecycleWorkflow({
    accountId: selectedAccountId,
    onError: showNotice,
    onChanged: matchWorkflow.notifyChanged,
  })
  const resolvingFromInitialization = pendingWorkflow.initializationAccountId === selectedAccountId && pendingWorkflow.pickerPending !== null
  const page = useLedgerPage({
    historyRegistered,
    accountId: selectedAccountId,
    membershipKey: groupMemberKey,
    choosingLifecycleRow: pendingWorkflow.pickerPending !== null,
    layoutKey: `${selectedAccountId}:${schedulesVisible}:${scheduleHeight}`,
    onError: showNotice,
  })
  const ledgerSectionRef = page.ledgerSectionRef
  const ledgerCornerArea = useCallback(() => {
    const section = ledgerSectionRef.current
    if (!section) return null
    const area = section.getBoundingClientRect()
    const footer = section.querySelector('.bp-ledger-footer')?.getBoundingClientRect()
    return new DOMRect(area.left, area.top, area.width, (footer?.top ?? area.bottom) - area.top)
  }, [ledgerSectionRef])
  const commands = useLedgerCommands({
    viewKey: page.queryViewKey,
    refreshViewKey: page.viewKey,
    queryKey: page.queryKey,
    refreshOrigin: page.refreshOrigin,
    rows: page.transactions,
  })
  const noteExplicitCategorySaved = useCallback((row: LedgerRow) => {
    if (row.payee_id === null || row.category_id === null) return
    if (selectedAccountId === null) return
    setDefaultSuggestion({ transactionId: row.id, payeeId: row.payee_id, categoryId: row.category_id, scope: selectedAccountId, phase: 'settling' })
  }, [selectedAccountId])
  const editor = useLedgerEditor({
    accountId: selectedAccountId,
    transactions: commands.rows,
    viewKey: page.viewKey,
    refreshAfterApply: page.refreshAfterApply,
    commands,
    categories,
    payees,
    accounts: accounts ?? [],
    // The editor calls this after render; workspace admission needs the editor’s current status.
    exitBlocked: (): boolean => workspace.entryRecoveryBlocked,
    onNotice: showNotice,
    onExplicitCategorySaved: noteExplicitCategorySaved,
    showNewTransaction,
    reviewAfterEdit,
    onAnnounce: announceNotice,
  })
  const transferWorkflow = useTransferWorkflow({
    onError: showNotice,
    onChanged: () => showNotice('Transfer updated.'),
    onDraftCommitted: editor.finishTransferDraft,
    onSavedCommitted: editor.finishTransferSaved,
    onQueueFinished: ({ saved, skipped, remaining, uncertain }) => {
      showNotice(`Transfer queue finished: ${saved} saved · ${skipped} skipped · ${remaining} remaining${uncertain ? ` · ${uncertain} write outcome${uncertain === 1 ? '' : 's'} uncertain` : ''}`)
    },
  })
  const onTransferIntent = (intent: EditorTransferIntent) => {
    if (intent.kind === 'draft') {
      const draft = editor.ledgerTransactions.find((row) => row.id === intent.id)
      if (draft) void transferWorkflow.openDraft(draft.account_id, intent.id, intent.proposal)
    } else if (intent.kind === 'proposal') void transferWorkflow.open(intent.row, intent.proposal)
    else void transferWorkflow.open(intent.row)
  }
  const workspace = useLedgerWorkspace({
    selectedAccountId,
    accountName: selectedAccount?.name ?? null,
    accounts: accounts ?? [],
    viewKey: page.viewKey,
    query: page.query,
    editor,
    commands,
    matchWorkflow,
    pendingWorkflow,
    transferWorkflow,
    bulkStaged,
    initializationPending,
    scheduleLoading,
    onTransferIntent,
    onNotice: showNotice,
    dialogs: {
      loanDialogOpen: loanDetails !== null || resolveAccount !== null,
      accountDialog: accountDialog !== null,
      conversion,
      categoryDialogOpen,
      payeeDialogOpen,
      payeeRecoveryActive,
      exportDialogOpen,
      refreshDialogOpen: refreshAccount !== null,
      newTransactionChooserOpen,
      systemSettingsOpen,
      startingBalanceAccountId,
      defaultSuggestionDialog: defaultSuggestionDialog !== null,
      reveal: reveal !== null,
    },
  })
  const {
    history, requestAction: requestWorkspaceAction, hasRemainingWork,
    isCurrentAccount, defaultSuggestionAdmission, systemSettingsBlocked, entryRecoveryBlocked, scheduleBlocked,
  } = workspace
  const emptyGroupFallbackRef = useRef<string | null>(null)
  const groupFallbackBlocked = Boolean(hasRemainingWork() || entryRecoveryBlocked || scheduleBlocked || accountDialog || exportDialogOpen || refreshAccount || systemSettingsOpen || categoryDialogOpen || payeeDialogOpen)
  useEffect(() => {
    if (groupName === null || scopeAccounts.length) { emptyGroupFallbackRef.current = null; return }
    if (emptyGroupFallbackRef.current === groupName || groupFallbackBlocked) return
    emptyGroupFallbackRef.current = groupName
    requestWorkspaceAction(() => setSelectedAccountId(openAccounts[0]?.id ?? closedAccounts[0]?.id ?? null))
  }, [groupName, scopeAccounts.length, groupFallbackBlocked, requestWorkspaceAction, openAccounts, closedAccounts])
  const { inspect: inspectHistory } = history
  useEffect(() => {
    if (history.ready) setHistoryRegistered(true)
  }, [history.ready])
  const { recover: recoverCommands } = commands
  const inspectCommands = useCallback(async () => {
    const inspected = await inspectHistory()
    await recoverCommands()
    return inspected
  }, [inspectHistory, recoverCommands])
  const abandonTransferWorkflow = transferWorkflow.abandon
  const transientBusy = !editor.manualClearRecovery && !history.recovery && !transferWorkflow.queueActive
    && (editor.writePending || commands.anyPending || history.busy || history.fetching)
  const historyTransientBusy = transientBusy && !editor.ordinaryEditorActive && !editor.splitSessionActive && !bulkStaged
  const requestGraph = useCallback((action: () => void) => {
    requestWorkspaceAction(() => {
      if (commands.anyPending || editor.writePending) {
        showNotice('Wait for saved transaction changes to refresh first.')
        return
      }
      action()
    })
  }, [requestWorkspaceAction, commands.anyPending, editor.writePending, showNotice])
  const openMatch = matchWorkflow.open
  const openLifecycle = pendingWorkflow.openResolution
  const openInspection = pendingWorkflow.openInspection
  const onOpenMatch = useCallback((mode: MatchDialogMode, bank: LedgerRow, planned: LedgerRow) => {
    requestGraph(() => { void openMatch(mode, bank, planned) })
  }, [openMatch, requestGraph])
  const onOpenLifecycle = useCallback((pending: LedgerRow) => {
    requestGraph(() => openLifecycle(pending))
  }, [openLifecycle, requestGraph])
  const onInspectConnections = useCallback((source: LedgerRow) => {
    requestGraph(() => {
      if (source.match?.state === 'matched') void openMatch('linked', source, source)
      else openInspection(source)
    })
  }, [openInspection, openMatch, requestGraph])
  useEffect(() => {
    abandonTransferWorkflow()
  }, [abandonTransferWorkflow, selectedAccountId])
  useEffect(() => {
    if (!defaultSuggestion) return
    if (selectedAccountId !== defaultSuggestion.scope) {
      setDefaultSuggestion(null)
      return
    }
    const admission = defaultSuggestionAdmission(defaultSuggestion.phase)
    if (admission === 'wait') return
    if (admission === 'advance') {
      setDefaultSuggestion((current) => current && current.transactionId === defaultSuggestion.transactionId ? { ...current, phase: 'ready' } : current)
      return
    }
    if (admission === 'discard') {
      setDefaultSuggestion(null)
      return
    }
    const payee = payees.find((item) => item.id === defaultSuggestion.payeeId)
    const categoryParent = categories.find((parent) => parent.children?.some((item) => item.id === defaultSuggestion.categoryId))
    const category = categoryParent?.children?.find((item) => item.id === defaultSuggestion.categoryId)
    if (!payee || !categoryParent || !category || category.archived || categoryParent.archived || payee.default_category_id !== null || payee.default_category_prompt_dismissed) {
      setDefaultSuggestion(null)
      return
    }
    let active = true
    void apiClient.get<PayeeDefaultCategorySuggestion | null>(`/api/payees/${defaultSuggestion.payeeId}/default-category/suggestion?transaction_id=${defaultSuggestion.transactionId}&category_id=${defaultSuggestion.categoryId}`).then((suggestion) => {
      if (!active) return
      setDefaultSuggestion(null)
      if (suggestion) setDefaultSuggestionDialog(suggestion)
    }).catch(() => {
      if (active) setDefaultSuggestion(null)
    })
    return () => { active = false }
  }, [categories, defaultSuggestion, defaultSuggestionAdmission, payees, selectedAccountId])

  const requestManagerEntry = useCallback((action: () => void) => {
    if (!historyRegistered) {
      showNotice('Wait for the register session to load first.')
      return
    }
    requestWorkspaceAction(() => {
      if (hasRemainingWork()) {
        showNotice('Finish or cancel the active ledger work first.')
        return
      }
      action()
    })
  }, [hasRemainingWork, requestWorkspaceAction, historyRegistered, showNotice])

  const requestSystemSettingsEntry = useCallback((trigger: HTMLButtonElement) => {
    if (systemSettingsBlocked) {
      showNotice('Finish or cancel the active ledger work first.')
      return
    }
    requestManagerEntry(() => {
      trigger.focus({ preventScroll: true })
      setSystemSettingsOpen(true)
    })
  }, [requestManagerEntry, showNotice, systemSettingsBlocked])

  const closeSystemSettings = useCallback(() => {
    setSystemSettingsOpen(false)
  }, [])

  const changeSeparateAmountColumns = useCallback((enabled: boolean) => {
    setSeparateAmountColumns(enabled)
    try {
      localStorage.setItem(SEPARATE_AMOUNT_COLUMNS_KEY, String(enabled))
    } catch {
      showNotice('System settings could not be saved for reload.')
    }
  }, [showNotice])

  const changeShowAccountIcons = useCallback((enabled: boolean) => {
    setShowAccountIcons(enabled)
    try {
      localStorage.setItem(SHOW_ACCOUNT_ICONS_KEY, String(enabled))
    } catch {
      showNotice('System settings could not be saved for reload.')
    }
  }, [showNotice])

  const changeHighlightBankDifferences = useCallback((enabled: boolean) => {
    setHighlightBankDifferences(enabled)
    try {
      localStorage.setItem(HIGHLIGHT_BANK_DIFFERENCES_KEY, String(enabled))
    } catch {
      showNotice('System settings could not be saved for reload.')
    }
  }, [showNotice])

  const changeCompactMode = useCallback((enabled: boolean) => {
    setCompactMode(enabled)
    try {
      localStorage.setItem(COMPACT_MODE_KEY, String(enabled))
    } catch {
      showNotice('System settings could not be saved for reload.')
    }
  }, [showNotice])

  const changeShowBankDescription = useCallback((enabled: boolean) => {
    setShowBankDescription(enabled)
    try {
      localStorage.setItem(SHOW_BANK_DESCRIPTION_KEY, String(enabled))
    } catch {
      showNotice('Bank description preference could not be saved for reload.')
    }
  }, [showNotice])

  const changeShowTransferColumn = useCallback((enabled: boolean) => {
    setShowTransferColumn(enabled)
    try {
      localStorage.setItem(SHOW_TRANSFER_COLUMN_KEY, String(enabled))
    } catch {
      showNotice('Transfer column preference could not be saved for reload.')
    }
  }, [showNotice])

  const changeShowRunningBalance = useCallback((enabled: boolean) => {
    setShowRunningBalance(enabled)
    try {
      localStorage.setItem(SHOW_RUNNING_BALANCE_KEY, String(enabled))
    } catch {
      showNotice('System settings could not be saved for reload.')
    }
  }, [showNotice])

  const changeShowNewTransaction = useCallback((enabled: boolean) => {
    setShowNewTransaction(enabled)
    try {
      localStorage.setItem(SHOW_NEW_TRANSACTION_KEY, String(enabled))
    } catch {
      showNotice('System settings could not be saved for reload.')
    }
  }, [showNotice])

  const changeReviewAfterEdit = useCallback((enabled: boolean) => {
    setReviewAfterEdit(enabled)
    try {
      localStorage.setItem(REVIEW_AFTER_EDIT_KEY, String(enabled))
    } catch {
      showNotice('Behavior preference could not be saved for reload.')
    }
  }, [showNotice])

  const goToTransfer = useCallback((source: LedgerRow) => {
    requestWorkspaceAction(() => {
      if (hasRemainingWork()) {
        showNotice('Finish or cancel the active ledger work before opening the other account.')
        return
      }
      const generation = ++revealGenerationRef.current
      void apiClient.get<TransactionConnectionsContext>(`/api/transactions/connections/context?transaction_id=${source.id}`).then((context) => {
        if (generation !== revealGenerationRef.current) return
        const partner = context.transfer?.partner
        if (!partner) {
          showNotice(context.transfer?.unavailable_reason || 'The linked transfer is not currently available.')
          return
        }
        setReveal({ sourceId: source.id, partnerId: partner.id, accountId: partner.account_id })
        if (!accountInScope((accounts ?? []).find((account) => account.id === partner.account_id), selectedAccountId)) setSelectedAccountId(partner.account_id)
        page.clearFilters()
      }).catch((error) => { if (generation === revealGenerationRef.current) showNotice(error instanceof ApiError ? error.message : 'The linked transfer could not be located.') })
    })
  }, [accounts, hasRemainingWork, requestWorkspaceAction, page, selectedAccountId, showNotice])

  const refreshReveal = useCallback((finalAttempt: boolean) => {
    const current = reveal
    if (!current) return
    const generation = revealGenerationRef.current
    void apiClient.get<TransactionConnectionsContext>(`/api/transactions/connections/context?transaction_id=${current.sourceId}`).then((context) => {
      if (generation !== revealGenerationRef.current) return
      const partner = context.transfer?.partner
      if (!partner) {
        cancelReveal()
        showNotice(context.transfer?.unavailable_reason || 'The linked transfer is no longer available.')
        return
      }
      if (partner.id !== current.partnerId || partner.account_id !== current.accountId) {
        revealGenerationRef.current += 1
        setReveal({ sourceId: current.sourceId, partnerId: partner.id, accountId: partner.account_id })
        if (!accountInScope((accounts ?? []).find((account) => account.id === partner.account_id), selectedAccountId)) setSelectedAccountId(partner.account_id)
        page.clearFilters()
        return
      }
      if (finalAttempt) {
        cancelReveal()
        showNotice('The linked transfer could not be found in the available account history.')
      }
    }).catch((error) => {
      if (!finalAttempt || generation !== revealGenerationRef.current) return
      cancelReveal()
      showNotice(error instanceof ApiError ? error.message : 'The linked transfer could not be located.')
    })
  }, [accounts, cancelReveal, page, reveal, selectedAccountId, showNotice])

  const completeReveal = useCallback((found: boolean) => {
    if (found) cancelReveal()
    else refreshReveal(true)
  }, [cancelReveal, refreshReveal])

  const refreshRevealProgress = useCallback(() => refreshReveal(false), [refreshReveal])

  const connectionHealth = useMemo(() => new Map((plaidStatus?.connections ?? []).flatMap((connection) => connection.health === 'ok' ? [] : connection.account_ids.map((id) => [id, connection.health as ConnectionHealth] as const))), [plaidStatus])
  const repairableAccountIds = useMemo(() => new Set((plaidStatus?.errors ?? []).filter((issue) => issue.kind === 'login_required' || issue.kind === 'missing_account').flatMap((issue) => issue.account_ids)), [plaidStatus])
  const onAccountAction = (account: Account, action: AccountMenuAction) => {
    if (action === 'export') { requestManagerEntry(() => setExportScope(account.id)); return }
    if (action === 'loan') { requestManagerEntry(() => setLoanDetails({ account, resolveAfter: false })); return }
    if (action === 'refresh') { requestManagerEntry(() => setRefreshAccount(account)); return }
    if (action === 'connect') { requestWorkspaceAction(() => setConversion({ accountId: account.id, open: true, outcomeUnknown: false })); return }
    requestWorkspaceAction(() => setAccountDialog({ mode: 'edit', accountId: account.id, action: action === 'edit' ? undefined : action }))
  }
  const dialogAccount = accountDialog?.mode === 'edit'
    ? (accounts ?? []).find((account) => account.id === accountDialog.accountId)
    : undefined
  const hasPlaidConnections = (accounts ?? []).some((account) => account.plaid_connection !== null)
  const beginManualTransaction = editor.beginManualTransaction
  const beginNewTransaction = useCallback((entryOrigin: 'transaction' | 'transfer') => {
    const existingDraft = editor.ledgerTransactions.find((row) => 'is_draft' in row)
    if (existingDraft) { beginManualTransaction(existingDraft.account_id); return }
    requestWorkspaceAction(() => {
      if (entryOrigin === 'transfer' && initializedOpenAccounts.length < 2) { showNotice('Add another open, initialized account before creating a transfer.'); return }
      if (!combinedScopeSelected) {
        beginManualTransaction(undefined, entryOrigin)
        return
      }
      const firstAccount = entryAccounts[0]
      if (!firstAccount) {
        showNotice('Create or initialize an open account before adding a transaction.')
        return
      }
      setNewTransactionAccountId(firstAccount.id)
      setNewEntryOrigin(entryOrigin)
      setNewTransactionChooserOpen(true)
    })
  }, [combinedScopeSelected, requestWorkspaceAction, beginManualTransaction, editor.ledgerTransactions, entryAccounts, initializedOpenAccounts.length, showNotice])
  const confirmNewTransactionAccount = useCallback(() => {
    if (newTransactionAccountId === null) return
    if (!entryAccounts.some((account) => account.id === newTransactionAccountId) || newEntryOrigin === 'transfer' && initializedOpenAccounts.length < 2) {
      const nextAccount = entryAccounts[0]?.id ?? null
      setNewTransactionAccountId(nextAccount)
      if (nextAccount === null) setNewTransactionChooserOpen(false)
      showNotice('That account is no longer available for new transactions.')
      return
    }
    setNewTransactionChooserOpen(false)
    beginManualTransaction(newTransactionAccountId, newEntryOrigin)
  }, [beginManualTransaction, entryAccounts, initializedOpenAccounts, newTransactionAccountId, newEntryOrigin, showNotice])

  const acknowledgmentMessage = 'The register is refreshed, but the save result is still unknown. Check the saved data before continuing. Nothing will be resent.'
  const reloadMessage = history.reloadReason === 'database_changed' ? 'The database was replaced. Your unsaved work is still on screen. Copy anything you need before reloading; saving from this tab is blocked.' : 'The previous bank operation result is no longer recorded. Copy anything you need, then reload and check its saved connection status before trying again.'

  return (
    <ModalCornerProvider area={ledgerCornerArea}>
    <ModalRecoveryNoticeProvider notice={history.reloadRequired ? <div className="bp-callout bp-callout--warning" role="alert">
      <p>{reloadMessage}</p>
      <Button size="lg" onClick={() => window.location.reload()}>Reload register</Button>
    </div> : history.acknowledgmentRequired ? <div className="bp-callout bp-callout--warning" role="alert">
      <p>{acknowledgmentMessage}</p>
      <Button size="lg" onClick={history.acknowledge}>I checked the result—continue</Button>
    </div> : history.recovery && !history.reloadRequired ? <div className="bp-callout bp-callout--warning" role="alert">
      <p>{history.recovering ? 'Refreshing the saved data. Your unsaved work is still here.' : history.recovery.message}</p>
      <Button size="lg" disabled={history.recovering} onClick={() => { void inspectCommands().catch(() => showNotice('Refresh failed. Save remains blocked until inspection succeeds.')) }}>Refresh register</Button>
    </div> : history.recoveryRequired && !history.reloadRequired ? <div className={`bp-callout bp-callout--${history.recovering || history.fetching ? 'warning' : 'error'}`} role="alert">
      <p>{history.recovering || history.fetching ? 'Refreshing the register session. Your unsaved work is still here.' : 'Could not refresh the register session. Your unsaved work is still here.'}</p>
      {!history.recovering && !history.fetching && <Button size="lg" onClick={() => { void history.inspect().catch(() => showNotice('Refresh failed. Your unsaved work is still here.')) }}>Retry refresh</Button>}
    </div> : null}>
    <div className={`bp-app${pendingWorkflow.pickerPending ? ' is-lifecycle-picker' : ''}`}>
      <AccountRail
        showAccountIcons={showAccountIcons}
        highlightBankDifferences={highlightBankDifferences}
        compact={compactMode}
        openAccounts={openAccounts}
        closedAccounts={closedAccounts}
        selectedAccountId={selectedAccountId}
        onSelect={(accountId) => requestWorkspaceAction(() => { cancelReveal(); transferWorkflow.abandon(); setSelectedAccountId(accountId) })}
        onCreate={() => requestWorkspaceAction(() => setAccountDialog({ mode: 'create' }))}
        onManageCategories={() => requestManagerEntry(() => setCategoryDialogOpen(true))}
        onManagePayees={() => requestManagerEntry(() => { setPayeeDialogSelection(null); setPayeeDialogOpen(true) })}
        onSystemSettings={requestSystemSettingsEntry}
        onError={showNotice}
        health={connectionHealth}
        repairableAccountIds={repairableAccountIds}
        onAccountAction={onAccountAction}
      />

      <main className="bp-main">
        <div className="bp-notice-stack">
          <div className="bp-notice-list">
            {history.reloadRequired && <WorkspaceNoticeFrame tone="warning" role="alert" message={reloadMessage} actions={<Button size="md" variant="primary" onClick={() => window.location.reload()}>Reload register</Button>} />}
            {history.storageUnavailable && <WorkspaceNoticeFrame tone="warning" role="alert" message="This browser cannot retain save-recovery information across reload. Keep this page open until each save is confirmed or inspected." />}
            {history.acknowledgmentRequired && <WorkspaceNoticeFrame tone="warning" role="alert" message={acknowledgmentMessage} actions={<Button size="md" onClick={history.acknowledge}>I checked the result—continue</Button>} />}
            {history.recoveryRequired && !history.acknowledgmentRequired && !history.reloadRequired && <WorkspaceNoticeFrame tone={history.recovering || history.fetching ? 'warning' : 'error'} role="alert" message={history.recovering || history.fetching ? 'Refreshing the register session. Your unsaved work is still here.' : 'Could not refresh the register session. Your unsaved work is still here.'} actions={!history.recovering && !history.fetching ? <Button size="md" disabled={history.fetching || history.busy} onClick={() => { void history.inspect().catch(() => showNotice('Refresh failed. Your unsaved work is still here.')) }}>Retry refresh</Button> : undefined} />}
            {conversion?.outcomeUnknown && !conversion.open && !history.reloadRequired && <WorkspaceNoticeFrame tone="warning" role="alert" message="The bank connection result still needs checking." actions={<Button size="md" onClick={() => setConversion((current) => current && { ...current, open: true })}>Check connection</Button>} />}
            {editor.manualClearRecovery && <WorkspaceNoticeFrame tone="warning" role="alert" message={editor.manualClearRecovery.message} actions={<Button size="md" disabled={editor.manualClearPending} onClick={() => { void history.inspect().then(() => editor.recoverManualClear()).then((message) => { if (message) showNotice(message) }).catch(() => showNotice('Refresh failed. Manual clearance remains blocked until the transaction can be inspected.')) }}>{editor.manualClearPending ? 'Refreshing…' : 'Refresh transaction'}</Button>} />}
            {history.registrationFailed && <WorkspaceNoticeFrame tone="error" role="alert" message="Ledger history could not be loaded. Refresh before saving." actions={<Button size="md" disabled={history.busy} onClick={() => { void history.inspect().catch(() => showNotice('Ledger history could not be refreshed.')) }}>Refresh register</Button>} />}
            {history.refreshFailed && !history.reloadRequired && !history.recoveryRequired && !workspace.workflowOwnsRecovery && !history.recovery && <WorkspaceNoticeFrame tone="error" role="alert" message="Ledger history could not be refreshed. Undo and redo are unavailable until it succeeds." actions={<Button size="md" disabled={history.fetching || history.busy} onClick={() => { void history.inspect().catch(() => showNotice('Ledger history could not be refreshed.')) }}>Refresh history</Button>} />}
            {commands.recovery && <WorkspaceNoticeFrame tone="warning" role="alert" message={commands.recovery} actions={<Button size="md" onClick={() => { void commands.recover().catch(() => showNotice('Refresh failed. Saved changes remain visible.')) }}>Refresh register</Button>} />}
            {history.recovery && !history.acknowledgmentRequired && !history.recoveryRequired && <WorkspaceNoticeFrame tone="warning" role="alert" message={history.recovery.message} actions={<Button size="md" disabled={history.busy} onClick={() => { void inspectCommands().catch(() => showNotice('Refresh failed. Save remains blocked until the request can be inspected.')) }}>Refresh register</Button>} />}
            {notices.map((notice) => <WorkspaceNoticeItem key={notice.id} notice={notice} onDismiss={dismissNotice} />)}
          </div>
        </div>
        <div className="bp-visually-hidden" role="status" aria-atomic="true"><span key={noticeAnnouncement.revision}>{noticeAnnouncement.message}</span></div>
        <div className="bp-workspace-heading">
          {(selectedAccount || combinedScopeSelected) && <div className="bp-title-block">
            <div className="bp-title-row">
              <h1>{groupName ?? (combinedScopeSelected ? 'All Accounts' : selectedAccount?.name)}</h1>
              {selectedAccount && <Button ref={initializationEditButtonRef} size="md" variant="quiet" aria-label="Edit account" title="Edit account" onClick={() => requestWorkspaceAction(() => setAccountDialog({ mode: 'edit', accountId: selectedAccount.id }))}><Pencil aria-hidden="true" /></Button>}
            </div>
            {selectedAccount && <span className="bp-label">{accountTypeLabel(selectedAccount.type)} account</span>}
          </div>}
          <div className="bp-top-actions">
            <PlaidSyncAction hasConnections={hasPlaidConnections} status={plaidStatus} scopeAccountIds={scopeAccounts.map((account) => account.id)} onNotice={showError} />
          </div>
        </div>

        {accountsError && !(accounts ?? []).length ? (
          <div className="bp-empty"><span className="bp-empty-mark">!</span><h1>Accounts could not be loaded</h1><p>Check the backend connection and try again.</p></div>
        ) : accountsPending ? (
          <div className="bp-empty"><h1>Loading workspace…</h1></div>
        ) : (accounts ?? []).length === 0 ? (
          <div className="bp-empty"><span className="bp-empty-mark">＋</span><h1>Create your first account</h1><p>Add an account you manage yourself, or connect a bank to create accounts and import activity.</p><div className="bp-empty-actions"><Button size="lg" onClick={() => setAccountDialog({ mode: 'create' })}>New account</Button><PlaidConnectionWorkflow onError={showNotice} /></div></div>
        ) : (selectedAccount || combinedScopeSelected) ? (
          <div className="bp-content">
            <section className="bp-account-header">
              <div className="bp-account-header-row">
                <div className="bp-tabs" role="tablist" aria-label="Ledger views">
                  <button className="is-active" type="button" role="tab" aria-selected="true">Transactions</button>
                  <button type="button" role="tab" aria-selected="false" disabled>Calendar</button>
                  <button type="button" role="tab" aria-selected="false" disabled>Visualize</button>
                </div>
                <Button size="md" variant="quiet" onClick={() => requestManagerEntry(() => setExportScope(selectedAccountId))}><Download aria-hidden="true" />Export</Button>
              </div>
            </section>

            <section className="bp-ledger" ref={page.ledgerSectionRef}>
              <div className={`bp-ledger-lock${initializationPending && !resolvingFromInitialization ? ' is-locked' : ''}`} inert={initializationPending && !resolvingFromInitialization} aria-hidden={initializationPending && !resolvingFromInitialization || undefined}>
              {page.query.isError && !page.query.data ? (
                <div className="bp-state">Transactions could not be loaded.</div>
              ) : (
                <LedgerRegisterTable
                  key={selectedAccountId}
                  accountId={selectedAccountId!}
                  accounts={accounts ?? []}
                  usesPlaidWorkflow={usesPlaidWorkflow}
                  separateAmountColumns={separateAmountColumns}
                  showBankDescription={showBankDescription}
                  onShowBankDescriptionChange={changeShowBankDescription}
                  showTransferColumn={showTransferColumn}
                  onShowTransferColumnChange={changeShowTransferColumn}
                  showRunningBalance={showRunningBalance}
                  onShowRunningBalanceChange={changeShowRunningBalance}
                  onSeparateAmountColumnsChange={changeSeparateAmountColumns}
                  balanceAvailable={!combinedScopeSelected}
                  locked={initializationPending && !resolvingFromInitialization}
                  transactions={editor.ledgerTransactions}
                  allCount={page.query.data?.all_count ?? 0}
                  filteredCount={page.query.data?.filtered_count ?? 0}
                  pending={page.query.isPending}
                  payees={payees}
                  categories={categories}
                  height={page.ledgerHeight}
                  hasMore={page.query.data?.has_more ?? false}
                  loadingOlder={page.loadingOlder}
                  editorSession={editor}
                  stateCommandsBlocked={workspace.rowCommandsBlocked}
                  onMakeRecurring={(source) => {
                    requestGraph(() => {
                      setScheduleLoading(true)
                      void apiClient.get<ScheduleDefinition>(`/api/schedules/recurring-draft/${source.id}`).then((definition) => {
                        if (!isCurrentAccount(selectedAccountId)) return
                        editor.cancelEditing()
                        changeScheduleVisibility(true)
                        setScheduleSeed(definition)
                      }).catch((caught) => showNotice(caught instanceof Error ? caught.message : 'Could not prepare the schedule.')).finally(() => setScheduleLoading(false))
                    })
                  }}
                  onDuplicate={(source) => {
                    const destination = source.transfer ? (accounts ?? []).find((account) => account.id === source.transfer?.account_id) : undefined
                    if (destination?.closed) {
                      editor.beginDuplicate({ ...source, transfer_account_id: null, transfer: null })
                      showNotice('The original transfer destination is closed. Choose another open account.')
                      return
                    }
                    editor.beginDuplicate(source)
                  }}
                  onStartTransferQueue={transferWorkflow.startQueue}
                  onStartFindTransferQueue={transferWorkflow.startFindQueue}
                  writePending={editor.writePending || transferWorkflow.queueActive || history.busy || history.recovery !== null}
                  aggregatePending={commands.anyPending}
                  commandRecoveryActive={workspace.entryRecoveryBlocked}
                  pendingRowIds={commands.pendingRowIds}
                  transientBusy={transientBusy}
                  onRefreshAfterApply={page.refreshAfterApply}
                  queryReadVersion={page.queryReadVersion}
                  onReadSelection={page.readSelection}
                  onBulkStagedChange={setBulkStaged}
                  onSelectionChange={setRegisterSelected}
                  scheduleSelected={scheduleSelected}
                  blockedBySchedule={workspace.registerBlockedBySchedule}
                  selectionSlotRef={setSelectionSlot}
                  onLoadOlder={page.loadOlder}
                  onError={showNotice}
                  onOpenMatch={onOpenMatch}
                  onFindMatch={(source) => requestGraph(() => { void matchWorkflow.openFinder(source) })}
                  onOpenLifecycle={onOpenLifecycle}
                  onOpenTransfer={(source, proposal) => { if (proposal) void transferWorkflow.open(source, proposal); else requestGraph(() => { void transferWorkflow.open(source) }) }}
                  onEditPayee={(id) => {
                    if (payees.find((payee) => payee.id === id)?.kind !== 'ordinary') return
                    requestManagerEntry(() => { setPayeeDialogSelection(id); setPayeeDialogOpen(true) })
                  }}
                  onEditorTransfer={workspace.dispatchTransferIntent}
                  onInspectConnections={onInspectConnections}
                  onGoToTransfer={goToTransfer}
                  lifecyclePickerPending={pendingWorkflow.pickerPending}
                  onChooseLifecycleCleared={pendingWorkflow.chooseCleared}
                  onCancelLifecyclePicker={pendingWorkflow.close}
                  matchResetKey={matchWorkflow.resetKey}
                  viewKey={page.viewKey}
                  selectionKey={`${page.viewKey}:${groupMemberKey}`}
                  filterViewGeneration={page.filterViewGeneration}
                  filters={page.filters}
                  onFilterChange={(key, value) => requestWorkspaceAction(() => { cancelReveal(); transferWorkflow.abandon(); pendingWorkflow.close(); page.changeFilter(key, value) })}
                  onRequestWorkspaceAction={requestWorkspaceAction}
                  revealTransactionId={reveal?.partnerId ?? null}
                  revealAccountId={reveal?.accountId ?? null}
                  onCancelReveal={cancelReveal}
                  onRevealComplete={completeReveal}
                  onRevealProgress={refreshRevealProgress}
                  onHistoryGuardChange={workspace.reportTableGuard}
                  onInspectHistory={inspectCommands}
                  historyRecoveryOutcome={history.recoveryOutcome}
                  renderFooter={({ count, totalCents }) => !initializationPending && page.query.data && <footer className="bp-ledger-footer" inert={workspace.registerBlockedBySchedule}>
                    <div className="bp-ledger-action-row">
                      {(['transaction', 'transfer'] as const).map((entryOrigin) => <div className="bp-new-transaction-wrap" key={entryOrigin}><Button size="md" variant="quiet" disabled={workspace.newEntryDisabled || entryOrigin === 'transfer' && initializedOpenAccounts.length < 2} data-new-transaction-control={entryOrigin === 'transaction' || undefined} data-new-transfer-control={entryOrigin === 'transfer' || undefined} data-busy={transientBusy && !bulkStaged || undefined} title={entryOrigin === 'transfer' && initializedOpenAccounts.length < 2 ? 'Add another open, initialized account before creating a transfer.' : bulkStaged ? STAGED_CHANGES_NOTICE : transferWorkflow.queueActive ? 'Finish or exit the transfer queue first.' : undefined} onMouseDown={(event) => { if (event.button === 0 && editor.editingRef.current?.isNew) event.preventDefault() }} onClick={() => beginNewTransaction(entryOrigin)}>{entryOrigin === 'transfer' ? '+ New Transfer' : '+ New Transaction'}</Button></div>)}
                      <div className="bp-button-group bp-ledger-history-actions"><Button size="md" variant="quiet" aria-label={history.undo.title} title={history.undo.title} disabled={!history.undo.ready} data-busy={historyTransientBusy && history.usable && Boolean(history.undo.action) || undefined} onClick={() => void history.undo.run()}><Undo aria-hidden="true" />Undo</Button><span aria-hidden="true" /><Button size="md" variant="quiet" aria-label={history.redo.title} title={history.redo.title} disabled={!history.redo.ready} data-busy={historyTransientBusy && history.usable && Boolean(history.redo.action) || undefined} onClick={() => void history.redo.run()}>Redo<Redo aria-hidden="true" /></Button></div>
                      <div className="bp-ledger-filter-summary" role="status" aria-label="Transaction results">
                        {page.filters.source === 'excluded'
                          ? <Button size="md" variant="quiet" onClick={() => requestWorkspaceAction(() => page.changeFilter('source', 'all_active'))}>All ({page.query.data.active_count})</Button>
                          : page.filters.source === 'all_active' && page.query.data.excluded_count > 0
                            ? <Button size="md" variant="quiet" onClick={() => requestWorkspaceAction(() => page.changeFilter('source', 'excluded'))}>Excluded ({page.query.data.excluded_count})</Button>
                            : null}
                        {hasActiveLedgerFilters(page.activeFilters) && <>
                          <i aria-hidden="true" />
                          <span>Showing ({page.query.data.filtered_count})</span>
                          <Button size="md" variant="quiet" onClick={() => requestWorkspaceAction(() => { cancelReveal(); transferWorkflow.abandon(); page.clearFilters() })}>Clear all filters</Button>
                        </>}
                      </div>
                      {<div className="bp-ledger-statuses">
                        {bankDifferences.map(({ account, difference }) => account.type === 'loan'
                          ? <LoanDifferenceButton key={account.id} account={account} difference={difference} combined={combinedScopeSelected} onOpen={() => requestManagerEntry(() => setResolveAccount(account))} />
                          : <span key={account.id} className="bp-cleared-discrepancy" tabIndex={0} title={`Bank-reported balance ${money(account.plaid_current_balance_cents!)}; Weft Cleared ${money(account.cleared_balance_cents!)}; difference ${money(difference, true)}; updated ${account.plaid_balance_updated_at ? new Date(account.plaid_balance_updated_at).toLocaleString() : 'time unavailable'}.`}><TriangleAlert aria-hidden="true" />{combinedScopeSelected ? `${account.name} · ` : ''}Bank difference {money(difference, true)}<span className="bp-visually-hidden">Cleared balance differs from the bank-reported balance.</span></span>)}
                        {!combinedScopeSelected && (selectedAccount?.missing_pending_count ?? 0) > 0 && <span className="bp-ledger-warning"><i aria-hidden="true" />{selectedAccount?.missing_pending_count} missing pending excluded</span>}
                        <Button
                          className={`bp-ledger-review${page.filters.status.needsReview ? ' is-active' : ''}`}
                          size="md"
                          variant="quiet"
                          disabled={(combinedScopeSelected ? scopeNeedsReview : selectedAccount?.pending_count ?? 0) === 0 && !page.filters.status.needsReview}
                          aria-pressed={page.filters.status.needsReview}
                          onClick={() => requestWorkspaceAction(() => { cancelReveal(); transferWorkflow.abandon(); page.changeFilter('status', { ...page.filters.status, needsReview: !page.filters.status.needsReview }) })}
                        >
                          Transactions to review: {combinedScopeSelected ? scopeNeedsReview : selectedAccount?.pending_count}
                        </Button>
                      </div>}
                    </div>
                    <div className="bp-ledger-balance-row">
                      {!combinedScopeSelected && selectedAccount?.type === 'credit' && (selectedAccount.plaid_available_balance_cents != null || selectedAccount.plaid_limit_cents != null) && <div className="bp-credit-availability">
                        <strong>{money(selectedAccount.plaid_available_balance_cents ?? selectedAccount.plaid_limit_cents ?? 0)}</strong>
                        <span>{selectedAccount.plaid_available_balance_cents != null ? `Available credit${selectedAccount.plaid_limit_cents != null ? ` of ${money(selectedAccount.plaid_limit_cents)} limit` : ''}` : 'Credit limit'}</span>
                      </div>}
                      {(count > 0 || (!combinedScopeSelected && selectedAccount && selectedAccount.cleared_balance_cents !== null && selectedAccount.uncleared_balance_cents !== null && selectedAccount.working_balance_cents !== null)) && <div className="bp-ledger-balance-summary">
                        {count > 0 && <div className="bp-ledger-balance-term bp-selected-total">
                          {totalCents === null
                            ? <><strong aria-hidden="true">—</strong><span className="bp-visually-hidden">Selected amount unavailable</span></>
                            : <strong className={totalCents < 0 ? 'is-negative' : totalCents > 0 ? 'is-positive' : ''}>{money(totalCents, true)}</strong>}
                          <span>Selected ({count})</span>
                        </div>}
                        {!combinedScopeSelected && selectedAccount && selectedAccount.cleared_balance_cents !== null && selectedAccount.uncleared_balance_cents !== null && selectedAccount.working_balance_cents !== null && <div className="bp-balance-equation" role="group" aria-label={`Cleared ${money(selectedAccount.cleared_balance_cents)} plus uncleared ${money(selectedAccount.uncleared_balance_cents)} equals working ${money(selectedAccount.working_balance_cents)}`}>
                          <div className="bp-ledger-balance-term"><strong className={selectedAccount.cleared_balance_cents < 0 ? 'is-negative' : selectedAccount.cleared_balance_cents > 0 ? 'is-positive' : ''}>{money(selectedAccount.cleared_balance_cents)}</strong><span>Cleared</span></div>
                          <i aria-hidden="true">+</i>
                          <div className="bp-ledger-balance-term"><strong className={selectedAccount.uncleared_balance_cents < 0 ? 'is-negative' : selectedAccount.uncleared_balance_cents > 0 ? 'is-positive' : ''}>{money(selectedAccount.uncleared_balance_cents)}</strong><span>Uncleared</span></div>
                          <i aria-hidden="true">=</i>
                          <div className="bp-ledger-balance-term is-working"><strong className={selectedAccount.working_balance_cents < 0 ? 'is-negative' : selectedAccount.working_balance_cents > 0 ? 'is-positive' : ''}>{money(selectedAccount.working_balance_cents)}</strong><span>Working</span></div>
                        </div>}
                      </div>}
                    </div>
                  </footer>}
                />
              )}
              </div>
              <ScheduledPane selectionSlot={selectionSlot} registerSelected={registerSelected} onSelectionChange={setScheduleSelected} onRequestWorkspaceAction={requestWorkspaceAction} canRequestEntry={workspace.scheduleEntryAllowed} onOpenAccount={(accountId) => requestWorkspaceAction(() => { cancelReveal(); transferWorkflow.abandon(); setSelectedAccountId(accountId) })} onEditPayee={(id) => requestManagerEntry(() => { if (payees.find((payee) => payee.id === id)?.kind !== 'ordinary') return; setPayeeDialogSelection(id); setPayeeDialogOpen(true) })} formatDate={dateLabel} separateAmountColumns={separateAmountColumns} key={selectedAccountId} accountId={selectedAccountId!} accounts={accounts ?? []} payees={payees} categories={categories} page={schedules.data} loadError={schedules.isError} visible={schedulesVisible} showProjectedBalance={showProjectedBalance} onProjectedBalanceChange={(showProjectedBalance) => changeSchedulePreference({ showProjectedBalance })} lookAhead={scheduleLookAhead} onLookAheadChange={(lookAhead) => changeSchedulePreference({ lookAhead })} height={Math.min(scheduleHeight, Math.max(120, window.innerHeight - 420))} balancePending={editor.writePending || commands.anyPending || commands.recovery !== null || history.busy || history.recovery !== null || history.reloadRequired} blocked={workspace.scheduleBlocked} seed={scheduleSeed} onSeedConsumed={consumeScheduleSeed} onToggle={toggleSchedules} onHeightChange={resizeSchedules} onGuardChange={workspace.reportScheduleGuard} onNotice={showNotice} onInspect={history.inspect} onEntered={editor.followScheduledEntry} onRefresh={async () => { await schedules.refetch({ throwOnError: true }); await page.query.refetch({ throwOnError: true }) }} />
              {selectedAccount && initializationPending && !resolvingFromInitialization && (
                <div ref={initializationCardRef} className="bp-initialization-card" role="region" aria-label="Needs initialization">
                  <h2>Needs initialization</h2>
                  {initializationState === 'downloading'
                    ? <p>Downloading account history. This register will unlock when the initial history is ready.</p>
                    : initializationState === 'unready'
                      ? <p>Account history is not ready yet. Retry when the bank connection is available.</p>
                      : initializationState === 'no-balance'
                        ? <p>History is ready, but the bank did not provide a current balance. Enter it manually to finish setup.</p>
                        : <p>Review the bank balance and pending activity to finish setting up this account.</p>}
                  {initializationState === 'downloading'
                    ? null
                    : initializationState === 'unready'
                      ? <Button
                        size="lg"
                        onClick={() => {
                          void apiClient.providerCommand<PlaidStatus>('/api/plaid/sync').then((status) => {
                            queryClient.setQueryData(['plaid-status'], status)
                            return invalidateAccountAndTransactionQueries(queryClient)
                          }).catch((error) => showNotice(error instanceof ApiError ? error.message : 'Plaid sync failed.'))
                        }}
                      >Retry</Button>
                      : <Button
                        ref={initializationStartButtonRef}
                        size="lg"
                        variant="primary"
                        onClick={(event) => {
                          const trigger = event.currentTarget
                          requestManagerEntry(() => { trigger.focus({ preventScroll: true }); setStartingBalanceAccountId(selectedAccount.id) })
                        }}
                      >Initialize account</Button>}
                </div>
              )}
            </section>
          </div>
        ) : null}
      </main>
      {accountDialog && (accountDialog.mode === 'create' || dialogAccount) && <AccountDialog
        account={dialogAccount}
        accounts={accounts ?? []}
        plaidStatus={plaidStatus}
        initialAction={accountDialog.action}
        onClose={() => setAccountDialog(null)}
        onLoanDetails={() => requestManagerEntry(() => { setAccountDialog(null); setLoanDetails({ account: dialogAccount!, resolveAfter: false }) })}
        onStartingBalance={() => requestManagerEntry(() => { resetInitializationIntroCooldown(); setAccountDialog(null); setStartingBalanceAccountId(dialogAccount!.id) })}
        onConnectBank={() => { setAccountDialog(null); setConversion({ accountId: dialogAccount!.id, open: true, outcomeUnknown: false }) }}
        onCreated={(account) => setSelectedAccountId(account.id)}
        onClosed={(account) => setSelectedAccountId(account.id)}
        onReopened={(account) => setSelectedAccountId(account.id)}
        onDeleted={(accountId) => {
          if (selectedAccountId !== accountId) return
          setSelectedAccountId(
            openAccounts.find((candidate) => candidate.id !== accountId)?.id
              ?? closedAccounts.find((candidate) => candidate.id !== accountId)?.id
              ?? null,
          )
        }}
      />}
      {conversion?.open && (accounts ?? []).some((account) => account.id === conversion.accountId) && <AccountConversionDialog
        account={(accounts ?? []).find((account) => account.id === conversion.accountId)!}
        accounts={accounts ?? []}
        outcomeUnknown={conversion.outcomeUnknown}
        reloadRequired={history.reloadRequired}
        onInspectHistory={history.inspect}
        onOutcomeUnknown={() => setConversion((current) => current && { ...current, outcomeUnknown: true })}
        onOutcomeResolved={(connected) => setConversion((current) => connected ? null : current && { ...current, outcomeUnknown: false })}
        onClose={() => setConversion((current) => current?.outcomeUnknown ? { ...current, open: false } : null)}
        onResumeAccount={(accountId) => {
          setSelectedAccountId(accountId)
          setConversion({ accountId, open: true, outcomeUnknown: false })
        }}
      />}
      <div className="bp-visually-hidden" aria-live="polite">{initializationAnnouncement}</div>
      {loanDetails !== null && <LoanDetailsDialog account={loanDetails.account} placement={loanDetails.resolveAfter ? 'corner' : 'center'} onInspectHistory={history.inspect} onClose={() => setLoanDetails(null)} onSaved={() => { setLoanDetails(null); if (loanDetails.resolveAfter) setResolveAccount(loanDetails.account); else showNotice('Loan details saved.') }} />}
      {resolveAccount !== null && <ResolveDifferenceDialog account={resolveAccount} onInspectHistory={history.inspect} onClose={() => setResolveAccount(null)} onAddDetails={() => { setLoanDetails({ account: resolveAccount, resolveAfter: true }); setResolveAccount(null) }} onSaved={() => { setResolveAccount(null); showNotice('Bank difference resolved.') }} />}
      {startingBalanceAccount && <StartingBalanceDialog account={startingBalanceAccount} returnFocusRef={startingBalanceAccount.starting_balance_initialized_at === null ? initializationStartButtonRef : initializationEditButtonRef} suspended={pendingWorkflow.initializationAccountId === startingBalanceAccount.id} onResolveMissingPending={(row) => pendingWorkflow.openResolution(row, startingBalanceAccount.id)} onInspectHistory={history.inspect} onClose={() => setStartingBalanceAccountId(null)} onSaved={() => { setStartingBalanceAccountId(null); showNotice('Account initialized.') }} />}
      {categoryDialogOpen && <CategoryManagerDialog onClose={() => setCategoryDialogOpen(false)} />}
      {payeeDialogOpen && <PayeeManagerDialog initialPayeeId={payeeDialogSelection} accounts={accounts ?? []} onClose={() => setPayeeDialogOpen(false)} onInspectHistory={history.inspect} onRecoveryChange={setPayeeRecoveryActive} onPayeeReplaced={page.replacePayeeFilter} />}
      {exportScope !== null && <ExportDialog accounts={accounts ?? []} currentAccountId={exportScope} onClose={() => setExportScope(null)} />}
      {refreshAccount && <RefreshBankDialog account={refreshAccount} accounts={accounts ?? []} status={plaidStatus} onClose={() => setRefreshAccount(null)} onNotice={showNotice} />}
      {newTransactionChooserOpen && <Modal size="sm" labelledBy="new-transaction-chooser-title" extraFocusSelector=".bp-filter-select-popover button:not(:disabled), .bp-filter-select-popover input:not(:disabled)" onRequestClose={() => setNewTransactionChooserOpen(false)}>
        <DialogHeader titleId="new-transaction-chooser-title" title={newEntryOrigin === 'transfer' ? 'New transfer' : 'New transaction'} subtitle={`Choose the account for this ${newEntryOrigin}.`} onClose={() => setNewTransactionChooserOpen(false)} />
        <div className="bp-dialog-body"><label className="bp-field">Account<FilterSelect ariaLabel="Transaction account" value={newTransactionAccountId === null ? '' : String(newTransactionAccountId)} options={newTransactionAccountOptions} searchable onChange={(value) => setNewTransactionAccountId(Number(value))} /></label></div>
        <div className="bp-dialog-footer"><Button size="lg" onClick={() => setNewTransactionChooserOpen(false)}>Cancel</Button><Button size="lg" variant="primary" disabled={newTransactionAccountId === null} onClick={confirmNewTransactionAccount}>Continue</Button></div>
      </Modal>}
      {systemSettingsOpen && <SystemSettingsDialog highlightBankDifferences={highlightBankDifferences} onHighlightBankDifferencesChange={changeHighlightBankDifferences} showAccountIcons={showAccountIcons} onShowAccountIconsChange={changeShowAccountIcons} compactMode={compactMode} onCompactModeChange={changeCompactMode} showNewTransaction={showNewTransaction} onShowNewTransactionChange={changeShowNewTransaction} reviewAfterEdit={reviewAfterEdit} onReviewAfterEditChange={changeReviewAfterEdit} onClose={closeSystemSettings} />}
      {defaultSuggestionDialog && defaultSuggestionPayee && defaultSuggestionParent && defaultSuggestionCategory && <PayeeDefaultCategorySuggestionDialog
        suggestion={defaultSuggestionDialog}
        payee={defaultSuggestionPayee}
        categoryLabel={`${defaultSuggestionParent.name}: ${defaultSuggestionCategory.name}`}
        onClose={() => setDefaultSuggestionDialog(null)}
        onInspect={history.inspect}
      />}
      {workspace.splitLeavePending && <Modal size="sm" role="alertdialog" labelledBy="split-leave-title" onRequestClose={workspace.keepEditing}>
        <DialogHeader titleId="split-leave-title" title="Discard split changes?" subtitle="Your staged parent and allocation changes have not been saved." onClose={workspace.keepEditing} />
        <div className="bp-dialog-body"><p className="bp-dialog-copy">This action would leave the split editor.</p></div>
        <div className="bp-dialog-footer"><Button size="lg" onClick={workspace.keepEditing}>Keep editing</Button><Button size="lg" variant="danger" onClick={workspace.discardSplitAndContinue}>Discard changes</Button></div>
      </Modal>}
      {matchWorkflow.dialog && <MatchWorkflow
        dialog={matchWorkflow.dialog}
        onClose={matchWorkflow.close}
        onMatch={matchWorkflow.match}
        onDismiss={matchWorkflow.dismiss}
        onCorrectRelationship={matchWorkflow.correctRelationship}
        onFinderScope={(scope) => { void matchWorkflow.loadFinder(scope) }}
        onFinderCandidate={(id) => { if (matchWorkflow.dialog?.finder) void matchWorkflow.loadFinder(matchWorkflow.dialog.finder.scope, id) }}
        onFinderMore={() => {
          if (matchWorkflow.dialog?.finder?.next_cursor) {
            void matchWorkflow.loadFinder(
              matchWorkflow.dialog.finder.scope,
              matchWorkflow.dialog.finder.candidate?.id,
              matchWorkflow.dialog.finder.next_cursor,
            )
          }
        }}
      />}
      {pendingWorkflow.loading && <Modal size="md" labelledBy="pending-lifecycle-loading-title" loading onRequestClose={pendingWorkflow.close}>
        <DialogHeader titleId="pending-lifecycle-loading-title" title={pendingWorkflow.loadingInspection ? 'Transaction connections' : 'Resolve pending transaction'} onClose={pendingWorkflow.close} />
        <div className="bp-dialog-body"><p className="bp-dialog-copy" role="status">{pendingWorkflow.loadingInspection ? 'Loading transaction connections…' : 'Loading pending transaction…'}</p></div>
        <div className="bp-dialog-footer"><Button size="lg" onClick={pendingWorkflow.close}>Cancel</Button></div>
      </Modal>}
      {pendingWorkflow.connectionsContext && <TransactionConnectionsDialog
        key={pendingWorkflow.connectionsContext.context_token}
        context={pendingWorkflow.connectionsContext}
        onClose={pendingWorkflow.close}
        onCorrectRelationship={pendingWorkflow.correctRelationship}
      />}
      {pendingWorkflow.context && <PendingLifecycleDialog
        key={pendingWorkflow.context.context_token}
        context={pendingWorkflow.context}
        payees={payees}
        categories={categories}
        onClose={pendingWorkflow.close}
        onResolve={pendingWorkflow.resolve}
        onDisappear={pendingWorkflow.disappear}
        onChooseFromLedger={pendingWorkflow.chooseFromLedger}
        onRelationshipAction={pendingWorkflow.refreshRelationship}
      />}
      {transferWorkflow.dialog && <TransferLinkDialog
        payees={payees}
        categories={categories}
        key={`${transferWorkflow.dialog.sourceId}:${transferWorkflow.queue?.current ?? ''}`}
        context={transferWorkflow.dialog.context}
        loading={transferWorkflow.dialog.loading}
        writing={transferWorkflow.dialog.writing}
        outcomeUnknown={transferWorkflow.dialog.outcomeUnknown}
        error={transferWorkflow.dialog.error}
        sourceAccountName={accounts?.find((account) => account.id === (transferWorkflow.dialog?.context?.source?.account_id ?? transferWorkflow.dialog?.draftSource?.accountId))?.name ?? 'This account'}
        queue={transferWorkflow.queue ? {
          ...transferWorkflow.queue,
          onLink: transferWorkflow.linkAndNext,
          onSaveUnlinked: transferWorkflow.saveUnlinkedAndNext,
          onCreate: transferWorkflow.createCounterpartAndNext,
          onSkip: transferWorkflow.skipQueue,
          onExit: transferWorkflow.exitQueue,
        } : null}
        onClose={transferWorkflow.close}
        onChooseCandidate={(id) => { void transferWorkflow.chooseCandidate(id) }}
        onChooseDestination={(accountId) => { void transferWorkflow.chooseDestination(accountId) }}
        onFindNearby={() => { void transferWorkflow.findNearby() }}
        onFindAll={() => { void transferWorkflow.findAll() }}
        onLoadMore={() => { void transferWorkflow.loadMore() }}
        onRefresh={() => { void (async () => { try { const state = await history.inspect(); await transferWorkflow.refresh(state.outcome?.status, state.outcomeAcknowledged) } catch { showNotice('Refresh failed. Transfer actions remain blocked until the request can be inspected.') } })() }}
        onLink={transferWorkflow.link}
        onCreate={transferWorkflow.createCounterpart}
        onSaveUnlinked={transferWorkflow.saveUnlinked}
      />}
    </div>
    </ModalRecoveryNoticeProvider>
    </ModalCornerProvider>
  )
}

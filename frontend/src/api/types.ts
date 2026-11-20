export interface AccountLogo {
  id: string
  name: string
  use_count: number
}

export interface IconImportResult {
  logo: AccountLogo
  reused: boolean
}

export interface Account {
  id: number
  name: string
  type: AccountType
  group_name: string | null
  cash_flow_reporting: boolean
  net_worth_reporting: boolean
  logo_id: string | null
  closed: boolean
  plaid_balance_updated_at: string | null
  plaid_current_balance_cents: number | null
  plaid_available_balance_cents: number | null
  plaid_limit_cents: number | null
  starting_balance_initialized_at: string | null
  plaid_history_imported_at: string | null
  cleared_balance_cents: number | null
  uncleared_balance_cents: number | null
  working_balance_cents: number | null
  pending_count: number
  missing_pending_count: number
  plaid_connection: {
    item_id: number
    institution: string
    plaid_account_id: string
  } | null
  type_change_locked: boolean
}

export interface AffectedSchedule {
  id: number
  account_name: string
  payee_name: string | null
  next_date: string
  memo: string
}

export interface AccountClosePreview {
  preview_token: string
  schedules: AffectedSchedule[]
}

export interface AffectedRule { id: number; position: number; payee_name: string }

export interface AccountDeletionPreview {
  rules: AffectedRule[]
  schedules: AffectedSchedule[]
  preview_token: string
  removed_transaction_count: number
  surviving_transfer_transaction_count: number
  plaid_item_effect: 'none' | 'kept_shared' | 'revoked'
}

export type AccountType = 'checking' | 'savings' | 'credit' | 'cash' | 'loan'

export interface StartingBalanceTotals {
  starting_balance_cents: number
  cleared_balance_cents: number
  uncleared_balance_cents: number
  working_balance_cents: number
}

export interface StartingBalanceContext {
  account_id: number
  context_token: string
  bank_balance_cents: number | null
  bank_balance_fetched_at: string | null
  initialized_at: string | null
  before: StartingBalanceTotals | null
  pending_rows: LedgerRow[]
  missing_pending_rows: LedgerRow[]
}

export interface StartingBalancePreview {
  preview_token: string
  before: StartingBalanceTotals | null
  after: StartingBalanceTotals
}

export interface StartingBalanceSuggestion {
  status: 'unique' | 'ambiguous' | 'none' | 'unsupported' | 'limit'
  included_pending: LedgerTarget[]
  available_balance_cents: number | null
  reason: string | null
}

export interface Payee {
  id: number
  name: string
  kind: 'ordinary' | 'myself' | 'starting_balance' | 'unknown'
  schedule_count: number
  default_category_id: number | null
  default_category_prompt_dismissed: boolean
  remembered_category_id: number | null
}

export type PayeeTextOperator = 'is' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'regex'
export interface PayeeTextCondition { field: 'description' | 'merchant'; operator: PayeeTextOperator; value: string }
export interface PayeeAmountCondition {
  operator: 'any' | 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
  direction: 'inflow' | 'outflow'
  value_cents: number | null
  upper_cents: number | null
}
export interface PayeeRuleDraft {
  id?: number
  payee_id: number | null
  category_id: number | null
  account_id: number | null
  amount: PayeeAmountCondition | null
  text_conditions: PayeeTextCondition[]
}
export interface PayeeRule extends PayeeRuleDraft {
  payee_id: number
  id: number
  position: number
  matching_count: number | null
  deciding_count: number | null
}
export interface PayeeRules { rules: PayeeRule[]; rules_token: string; evaluation_error: string | null }
export interface PayeeReferenceTransaction {
  payee_id: number
  id: number
  account_name: string
  date: string
  amount_cents: number
  payee_name: string
  description: string
  source: string
  reason: 'current' | 'matched' | 'replaced' | 'excluded' | 'removed' | 'missing_pending' | 'expired_pending'
}
export interface PayeeReferences {
  displayed_transaction_count: number
  following_transaction_count: number
  unknown_transaction_count: number
  preview_token: string
  payee: Payee
  destination?: Payee
  transaction_count: number
  schedule_count: number
  rules: PayeeRule[]
  groups: {
    key: string
    transaction: PayeeReferenceTransaction | null
    records: PayeeReferenceTransaction[]
    schedule: { id: number; account_name: string; date: string; amount_cents: number; frequency: string; memo: string } | null
  }[]
  total_groups: number
  offset: number
  next_offset: number | null
}
export interface PayeeScheduleAssignments {
  payee: Payee
  preview_token: string
  rows: { id: number; account_name: string; date: string; amount_cents: number; frequency: string; memo: string }[]
  total_count: number
  offset: number
  next_offset: number | null
}
export interface PayeeUnusedDeletionPreview {
  preview_token: string
  payees: { id: number; name: string; rules: PayeeRule[]; following_transaction_count: number; unknown_transaction_count: number }[]
}
export interface LedgerTarget { id: number; edit_token: string }
export interface PayeeDefaultCategorySuggestion {
  payee_id: number
  category_id: number
  transaction_count: number
}

export interface ComparisonRowEdits {
  payee_id?: number
  category_id?: number | null
  memo?: string
}

export interface TransferReviewProposal {
  payee_id: number
  transfer_account_id: number
  draft: TransferDraft
}

export interface TransferDraft {
  date: string
  duplicate_source_id?: number
  amount_cents: number
  memo: string
  flag: TransactionFlag
  categorization?: SingleCategorization | null
}

export interface TransferQueueEntry extends LedgerTarget {
  proposal: TransferReviewProposal | null
}

export interface BulkTransferQueueStart {
  entries: TransferQueueEntry[]
}

export interface TransferReviewContextRequest {
  proposal: TransferReviewProposal
  expected_edit_token?: string
  scope: 'nearby' | 'all'
  candidate_id?: number
  cursor?: string
}

export interface PayeeHistoryPage {
  rows: LedgerRow[]
  total_count: number
  has_more: boolean
  next_before_date: string | null
  next_before_id: number | null
  next_before_order: number | null
}
export interface PayeePreviewDecision {
  earlier_rule_id: number | null
  payee_id: number
  category_id: number | null
  changes_category: boolean
  changes_retained_payee: boolean
  eligible: boolean
  blocked: 'account_not_initialized' | 'not_editable' | null
}
export interface PayeePreview extends PayeeHistoryPage {
  counts: { matching: number; decides: number; earlier: number; blocked: number; applicable: number }
  decisions: Record<string, PayeePreviewDecision>
  preview_token: string
}
export interface PayeeRuleTrace {
  transaction: LedgerRow
  merchant_name: string | null
  matching_rule_ids: number[]
  deciding_rule_id: number | null
  payee_id: number | null
  category_id: number | null
  fallback_name: string | null
}

export interface Category {
  rules: AffectedRule[]
  id: number
  name: string
  parent_id: number | null
  archived: boolean
  is_discretionary: boolean | null
  transaction_count: number
  schedule_count: number
}

export interface CategoryTree extends Category {
  parent_id: null
  children: Category[]
}

export interface CategoryCreateCommand {
  name: string
  parent_id: number | null
  is_discretionary?: boolean | null
}

export interface CategoryUpdateCommand {
  name?: string
  parent_id?: number
  archived?: boolean
  is_discretionary?: boolean | null
}

export interface CategoryDeleteCommand {
  destination_id: number | null
}

export type AllowedAction = 'edit' | 'move' | 'clearance' | 'manual_clearance' | 'review' | 'find_match' | 'unmatch' | 'dismiss_match' | 'delete' | 'pending_lifecycle' | 'find_transfer' | 'bank_continuity' | 'inspect_connections' | 'unlink_transfer' | 'go_to_transfer' | 'duplicate' | 'make_recurring' | 'exclude' | 'restore'
export type EditableField = 'date' | 'payee_id' | 'transfer_account_id' | 'category_id' | 'memo' | 'amount_cents' | 'flag'

export interface LedgerMatchSummary {
  id: number
  state: MatchState
}

export type BankContinuityKind = 'provider' | 'explicit' | 'inferred_posted' | 'inferred_pending'

export interface BankContinuityRecord {
  id: number
  source_transaction_id: number
  target_transaction_id: number
  kind: BankContinuityKind
  payee_source: 'source' | 'target'
  transfer_source: 'source' | 'target'
  category_source: 'source' | 'target'
  memo_source: 'source' | 'target'
  flag_source: 'source' | 'target'
}

export interface TransactionConnectionsContext {
  account_name: string
  transaction_id: number
  context_token: string
  records: BankContinuityRecord[]
  sources: LedgerRow[]
  representative: LedgerRow
  representative_id: number
  actions: RelationshipAction[]
  transfer: TransferInspection | null
}

export type MatchState = 'suggested' | 'matched' | 'dismissed'
export type TransactionStatus = 'pending' | 'uncleared' | 'cleared' | 'reconciled'
export type TransactionFlag = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | null

export interface LedgerRow {
  match_role: 'feed' | 'history' | null
  id: number
  account_id: number
  date: string
  payee_kind: 'ordinary' | 'myself' | 'starting_balance' | 'unknown'
  description: string
  payee_id: number
  transfer_account_id: number | null
  category_id: number | null
  memo: string
  amount_cents: number
  running_balance_cents: number | null
  status: TransactionStatus
  manually_cleared: boolean
  approved: boolean
  source: 'manual' | 'plaid' | 'starting_balance'
  flag: TransactionFlag
  match: LedgerMatchSummary | null
  missing_pending: boolean
  excluded: boolean
  pinned: boolean
  allowed_actions: AllowedAction[]
  disabled_actions: Partial<Record<AllowedAction, string>>
  editable_fields: EditableField[]
  payee_name: string | null
  category_name: string | null
  subcategory_name: string | null
  allocations: LedgerAllocation[]
  category_assigned: boolean
  edit_token: string
  rule_description: string | null
  payee_category_memory?: { payee_id: number; remembered_category_id: number | null } | null
  transfer: {
    account_id: number
    account_name: string
    label: string
    state: 'unlinked' | 'linked' | 'attention'
    attention_reasons: string[]
    automatic_reason: 'destination' | 'provider' | null
  } | null
  bank_continuity?: { inferred: boolean; associations: BankContinuityRecord[] } | null
}

export interface LedgerAllocation {
  id: number
  category_id: number | null
  category_name: string | null
  subcategory_name: string | null
  memo: string
  amount_cents: number
  unassigned: boolean
}

export type SingleCategorization = { kind: 'single'; category_id: number | null }
export type TransactionCategorization =
  | SingleCategorization
  | {
      kind: 'split'
      allocations: Array<{
        id?: number | null
        category_id: number | null
        memo: string
        amount_cents: number
        unassigned?: boolean
      }>
    }

export interface ManualEntryCommand {
  account_id: number
  date: string
  duplicate_source_id?: number
  payee_id?: number | null
  transfer_account_id?: number | null
  categorization?: TransactionCategorization
  memo?: string
  amount_cents: number
  flag?: TransactionFlag
}

export interface LedgerEditCommand {
  review_after_edit?: boolean
  date?: string
  payee_id?: number | null
  transfer_account_id?: number | null
  categorization?: TransactionCategorization
  memo?: string
  amount_cents?: number
  flag?: TransactionFlag
  expected_edit_token?: string
}

export interface LedgerPage {
  rows: LedgerRow[]
  all_count: number
  active_count: number
  excluded_count: number
  filtered_count: number
  has_more: boolean
  next_before_date: string | null
  next_before_id: number | null
  next_before_order: number | null
}

export interface LedgerBulkChanges {
  payee_id?: number | null
  transfer_account_id?: number | null
  category_id?: number | null
  memo?: string
  flag?: TransactionFlag
  approved?: boolean
  clearance?: 'cleared' | 'uncleared'
  manual_clearance?: boolean
}

export interface LedgerBulkApplyCommand {
  targets: LedgerTarget[]
  changes: LedgerBulkChanges
  memo_overwrite_confirmed?: boolean
}

export interface LedgerBulkApplyResult {
  status: 'ok'
  rows: LedgerRow[]
}

export interface LedgerHistoryPreview {
  warning: string | null
}

export interface PlaidConnectionFreshness {
  institution: string
  account_ids: number[]
  bank_updated_at: string | null
  bank_failed_at: string | null
  synced_at: string | null
  health: 'ok' | 'failing' | 'needs_sign_in'
}

export interface PlaidStatus {
  bank_sync_paused: boolean
  schedule_revision: number
  last_sync: string | null
  initial_import_account_ids: number[]
  added: number
  matched: number
  suggested: number
  queued: number
  errors: Array<{
    kind: 'login_required' | 'missing_account' | 'temporary' | 'local_custody' | 'transaction_warning' | 'schedule_entry' | 'rule_evaluation' | 'other'
    message: string
    account_ids: number[]
    missing_account_ids: number[]
  }>
  connections: PlaidConnectionFreshness[]
}

export type MatchSource = 'feed' | 'history'

export interface RelationshipAction {
  kind: 'bank' | 'match' | 'transfer'
  id: number
  source_id: number
  target_id: number
  source_label: string
  target_label: string
  context_token: string
  evidence: string
  consequence: string
}

export interface TransferInspection {
  partner: LedgerRow | null
  account_name: string
  anchor_id: number
  unavailable_reason: string | null
  action: RelationshipAction
}

export interface MatchContext {
  representative: LedgerRow
  unmatch_action: RelationshipAction | null
  transfer: TransferInspection | null
  id: number | null
  selections: {
    payee: MatchSource
    transfer: MatchSource
    description: MatchSource
    category: MatchSource
    memo: MatchSource
    flag: MatchSource
  }
   feed: LedgerRow
   history: LedgerRow
  rationale: string
  context_token: string
  fixed_fields: Array<'payee' | 'transfer' | 'category'>
  blocking_reason: string | null
}

export interface MatchFinderContext {
  source: LedgerRow
  candidates: LedgerRow[]
  candidate: LedgerRow | null
  comparison: MatchContext | null
  scope: 'nearby' | 'all'
  next_cursor: string | null
}

export type PendingLifecycleSource = 'pending' | 'cleared'

export interface PendingLifecycleContext {
  pending: LedgerRow
  cleared: LedgerRow | null
  rationale: string
  context_token: string
  fixed_fields: Array<'payee' | 'transfer' | 'category'>
  blocking_reason: string | null
  disappearance_message: string
  selections: {
    payee: PendingLifecycleSource | null
    transfer: PendingLifecycleSource
    category: PendingLifecycleSource
    memo: PendingLifecycleSource
    flag: PendingLifecycleSource
  }
  history_relations: Array<{
    context_token: string
    id: number
    state: 'suggested' | 'matched'
    feed_transaction_id: number
    history: LedgerRow
  }>
}

export interface TransferContext {
  source: LedgerRow | null
  draft: { category_label: string; date: string; description: string; amount_cents: number; memo: string; flag: TransactionFlag } | null
  proposal: TransferReviewProposal | null
  proposal_payee_name: string | null
  counterpart_payee_id: number | null
  destination: TransferDestination | null
  counterpart_destinations: TransferDestination[]
  candidates: TransferCandidate[]
  candidate: TransferCandidate | null
  scope: 'nearby' | 'all'
  next_cursor: string | null
  context_token: string
  allowed_actions: Array<'link' | 'create_counterpart' | 'save_unlinked'>
  search_all_accounts: boolean
}

export interface TransferDestination {
  id: number
  name: string
  type: AccountType
  closed: boolean
}

export interface TransferCandidate extends LedgerRow {
  account_name: string
}

export interface TransferCommandResult {
  source: LedgerRow
  partner: LedgerRow | null
}

export interface PendingLifecycleSelections {
  payee_source: PendingLifecycleSource
  transfer_source: PendingLifecycleSource
  category_source: PendingLifecycleSource
  memo_source: PendingLifecycleSource
  flag_source: PendingLifecycleSource
}

export interface LedgerHistoryAction {
  id: string
  label: string
  account_ids: number[]
}

export interface LedgerHistoryOutcome {
  request_id: string
  status: 'committed' | 'not_committed' | 'expired'
  message?: string
}

export interface LedgerHistoryState {
  epoch: string
  revision: number
  undo: LedgerHistoryAction | null
  redo: LedgerHistoryAction | null
  notice: string | null
  outcome: LedgerHistoryOutcome | null
}

export interface LedgerHistoryReplayResult extends LedgerHistoryState {
  message?: string
  account_ids?: number[]
}

export interface LedgerHistorySessionState extends LedgerHistoryState {
  database_generation: string
}

export interface LedgerHistoryInspection extends LedgerHistorySessionState {
  outcomeResolved: boolean
  outcomeAcknowledged: boolean
}


export type ScheduleFrequency = 'once' | 'daily' | 'weekly' | 'every_other_week' | 'every_four_weeks' | 'monthly' | 'every_two_months' | 'every_three_months' | 'every_four_months' | 'twice_yearly' | 'yearly' | 'every_two_years'
export type ScheduleLookAhead = 'off' | 'end_of_month' | '4_weeks' | '12_weeks'
export interface ScheduleDefinition {
  account_id: number
  next_date: string
  frequency: ScheduleFrequency
  anchor_day?: number | null
  payee_id: number | null
  transfer_account_id: number | null
  category_id: number | null
  memo: string
  amount_cents: number
  match_tolerance_cents: number
  end_date: string | null
}
export interface ScheduledTransaction extends ScheduleDefinition {
  payee_id: number
  id: number
  account_name: string
  payee_name: string | null
  category_name: string | null
  pause_reason: string | null
  edit_token: string
  mirror: { account_id: number; account_name: string } | null
  ghost: boolean
  projected_balance_cents: number | null
  allowed_actions: ('edit' | 'delete' | 'skip' | 'enter_now')[]
}
export interface SchedulePage {
  today: string
  projected_balance_available: boolean
  rows: ScheduledTransaction[]
  move_account_ids: Record<number, number[]>
  duplicate_transfer_candidates: { id: number; account_id: number; account_name: string; target_account_id: number; amount_cents: number }[]
}
export interface ScheduleBulkChanges { payee_id?: number; category_id?: number | null; memo?: string }
export interface ScheduleBatchRequest {
  targets: { id: number; edit_token: string }[]
  action: 'enter_now' | 'skip' | 'send_to' | 'update'
  destination_account_id?: number
  changes?: ScheduleBulkChanges
  memo_overwrite_confirmed?: boolean
}
export type OpenAIConnectionState = {
  revision: string
  ai_disabled: boolean
  selected_model: string | null
  active_client_id: string | null
  registrations: Array<{ client_id: string; email: string | null; connected: boolean; verified: boolean }>
  connected: boolean
  plan_usage_enabled: boolean
  usage_acknowledged: boolean
  authorization_pending: boolean
  authorization_attempt: string | null
  authorization_error: string | null
}

export type OpenAIModel = { slug: string; display_name: string }


export interface LoanDetails {
  kind: 'mortgage' | 'student' | 'other'
  escrow_cents: number
}

export interface LoanAccountContext {
  account_id: number
  account_name: string
  details: LoanDetails | null
  difference_cents: number | null
  bank_updated_at: string | null
  payee: { id: number; name: string; assignable: boolean } | null
  interest_category_id: number | null
  escrow_category_id: number | null
  today: string
}

export interface LedgerFilterChoices { payee_ids: number[]; category_values: string[] }

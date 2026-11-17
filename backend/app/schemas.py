from datetime import date as date_, datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

AccountType = Literal["checking", "savings", "credit", "cash", "loan"]
TransactionFlag = Literal["red", "orange", "yellow", "green", "blue", "violet"]
AllowedAction = Literal[
    "edit",
    "move",
    "clearance",
    "manual_clearance",
    "review",
    "find_match",
    "unmatch",
    "dismiss_match",
    "delete",
    "pending_lifecycle",
    "find_transfer",
    "bank_continuity",
    "inspect_connections",
    "unlink_transfer",
    "go_to_transfer",
    "duplicate",
    "make_recurring",
    "exclude",
    "restore",
]
EditableField = Literal[
    "date", "payee_id", "transfer_account_id", "category_id", "memo", "amount_cents", "flag"
]
PositiveInt = Annotated[StrictInt, Field(gt=0)]
SafeCents = Annotated[StrictInt, Field(ge=-9007199254740991, le=9007199254740991)]


def normalize_account_name(value: str | None) -> str:
    if value is None or not value.strip():
        raise ValueError("Account name cannot be blank")
    return value.strip()


def normalize_account_group(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > 80 or not value.isprintable():
        raise ValueError("Group names must be one line of 80 characters or fewer")
    return value


class AccountCreate(BaseModel):
    name: str
    type: AccountType
    _name = field_validator("name")(normalize_account_name)
    group_name: StrictStr | None = None
    cash_flow_reporting: StrictBool = True
    net_worth_reporting: StrictBool = True
    _group = field_validator("group_name")(normalize_account_group)
    logo_id: StrictStr | None = None


class LedgerHistoryReplay(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_id: str
    expected_revision: int = Field(ge=0)


class AccountUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    type: AccountType | None = None
    _name = field_validator("name")(normalize_account_name)
    group_name: StrictStr | None = None
    cash_flow_reporting: StrictBool | None = None
    net_worth_reporting: StrictBool | None = None
    _group = field_validator("group_name")(normalize_account_group)
    logo_id: StrictStr | None = None

    @model_validator(mode="after")
    def reject_explicit_nulls(self):
        if any(
            field in self.model_fields_set and getattr(self, field) is None
            for field in ("name", "type", "cash_flow_reporting", "net_worth_reporting")
        ):
            raise ValueError("Account update fields cannot be null")
        return self


class AccountReorder(BaseModel):
    ids: list[int] = Field(min_length=1)

    @field_validator("ids")
    @classmethod
    def unique(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value):
            raise ValueError("Account ids must be unique")
        return value


class AccountCloseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    disconnect_bank: StrictBool
    preview_token: str


class PlaidConnectionOut(BaseModel):
    item_id: int
    institution: str
    plaid_account_id: str


class AccountOut(BaseModel):
    id: int
    name: str
    type: AccountType
    group_name: str | None
    cash_flow_reporting: bool
    net_worth_reporting: bool
    logo_id: str | None
    closed: bool
    plaid_current_balance_cents: int | None = None
    plaid_available_balance_cents: int | None = None
    plaid_limit_cents: int | None = None
    plaid_balance_updated_at: datetime | None = None
    starting_balance_initialized_at: datetime | None = None
    plaid_history_imported_at: datetime | None = None
    plaid_connection: PlaidConnectionOut | None = None
    type_change_locked: bool = False
    cleared_balance_cents: int | None = None
    uncleared_balance_cents: int | None = None
    working_balance_cents: int | None = None
    pending_count: int = 0
    missing_pending_count: int = 0


class AffectedSchedule(BaseModel):
    id: int
    account_name: str
    payee_name: str | None
    next_date: date_
    memo: str


class AccountClosePreview(BaseModel):
    preview_token: str
    schedules: list[AffectedSchedule]


class AffectedRule(BaseModel):
    id: int
    position: int
    payee_name: str


class AccountDeletionPreview(BaseModel):
    rules: list[AffectedRule] = Field(default_factory=list)
    schedules: list[AffectedSchedule]
    preview_token: str
    removed_transaction_count: int
    surviving_transfer_transaction_count: int
    plaid_item_effect: Literal["none", "kept_shared", "revoked"]


class AccountDeletionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preview_token: str


class PayeeOut(BaseModel):
    id: int
    name: str
    kind: Literal["ordinary", "myself", "starting_balance", "unknown"]
    default_category_id: int | None = None
    default_category_prompt_dismissed: bool = False
    remembered_category_id: int | None = None
    schedule_count: int = 0


class PayeeName(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str


class PayeeTextCondition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: Literal["description", "merchant"]
    operator: Literal["is", "contains", "not_contains", "starts_with", "ends_with", "regex"]
    value: StrictStr


class PayeeAmountCondition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operator: Literal["any", "eq", "gt", "gte", "lt", "lte", "between"]
    direction: Literal["inflow", "outflow"]
    value_cents: Annotated[StrictInt, Field(ge=0, le=9007199254740991)] | None = None
    upper_cents: Annotated[StrictInt, Field(ge=0, le=9007199254740991)] | None = None

    @model_validator(mode="after")
    def valid_bounds(self):
        if self.operator == "any":
            if self.value_cents is not None or self.upper_cents is not None:
                raise ValueError("Any amount does not accept a value")
        elif self.value_cents is None:
            raise ValueError("Enter an amount")
        elif self.operator == "between":
            if self.upper_cents is None or self.upper_cents < self.value_cents:
                raise ValueError("The upper amount must be at least the lower amount")
        elif self.upper_cents is not None:
            raise ValueError("Only Between accepts an upper amount")
        return self


class PayeeRuleDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: PositiveInt | None = None
    payee_id: PositiveInt
    category_id: PositiveInt | None = None
    account_id: PositiveInt | None = None
    amount: PayeeAmountCondition | None = None
    text_conditions: list[PayeeTextCondition] = Field(default_factory=list)

    @model_validator(mode="after")
    def has_condition(self):
        if self.account_id is None and self.amount is None and not self.text_conditions:
            raise ValueError("Add at least one condition")
        return self


class PayeeRuleOut(PayeeRuleDraft):
    id: int
    position: int
    matching_count: int | None
    deciding_count: int | None


class PayeeRules(BaseModel):
    rules: list[PayeeRuleOut]
    rules_token: str
    evaluation_error: str | None = None


class PayeeRuleSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_rules_token: str
    rule: PayeeRuleDraft


class PayeeRuleSaveRequest(PayeeRuleSave):
    apply_preview_token: str | None = None


class PayeeRuleDelete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_rules_token: str


class PayeeRuleMove(PayeeRuleDelete):
    direction: Literal["up", "down"]


class PayeeReferenceTransaction(BaseModel):
    payee_id: int
    id: int
    account_name: str
    date: date_
    amount_cents: int
    payee_name: str
    description: str
    source: str
    reason: Literal["current", "matched", "replaced", "excluded", "removed", "missing_pending", "expired_pending"]


class PayeeReferenceSchedule(BaseModel):
    id: int
    account_name: str
    date: date_
    amount_cents: int
    frequency: str
    memo: str


class PayeeReferenceGroup(BaseModel):
    key: str
    transaction: PayeeReferenceTransaction | None
    records: list[PayeeReferenceTransaction]
    schedule: PayeeReferenceSchedule | None


class PayeeReferences(BaseModel):
    displayed_transaction_count: int
    following_transaction_count: int
    unknown_transaction_count: int
    preview_token: str
    payee: PayeeOut
    transaction_count: int
    schedule_count: int
    rules: list[PayeeRuleOut]
    groups: list[PayeeReferenceGroup]
    total_groups: int
    offset: int
    next_offset: int | None


class PayeeReplacementPreview(PayeeReferences):
    destination: PayeeOut


class PayeeReplacementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    destination_payee_id: PositiveInt
    preview_token: str


class PayeeScheduleAssignments(BaseModel):
    payee: PayeeOut
    preview_token: str
    rows: list[PayeeReferenceSchedule]
    total_count: int
    offset: int
    next_offset: int | None


class PayeeScheduleAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    destination_payee_id: PositiveInt
    preview_token: str
    schedule_ids: list[PositiveInt] = Field(min_length=1)


class PayeeDeletionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preview_token: str


class PayeeUnusedDeletionEntry(BaseModel):
    following_transaction_count: int
    unknown_transaction_count: int
    id: int
    name: str
    rules: list[PayeeRuleOut]


class PayeeUnusedDeletionPreview(BaseModel):
    preview_token: str
    payees: list[PayeeUnusedDeletionEntry]


class Target(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: PositiveInt
    edit_token: str


def unique_targets(value: list[Target]) -> list[Target]:
    if len({item.id for item in value}) != len(value):
        raise ValueError("Transaction ids must be unique")
    return value


class PayeeDefaultCategoryPreview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category_id: PositiveInt
    expected_default_category_id: PositiveInt | None


class PayeeDefaultCategoryPreviewOut(BaseModel):
    targets: list[Target]


class PayeeDefaultCategorySave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category_id: PositiveInt | None
    expected_default_category_id: PositiveInt | None
    targets: list[Target] = Field(default_factory=list)

    _unique_targets = field_validator("targets")(unique_targets)


class PayeeDefaultCategorySuggestion(BaseModel):
    payee_id: int
    category_id: int
    transaction_count: int


class StartingBalanceTotals(BaseModel):
    starting_balance_cents: SafeCents
    cleared_balance_cents: SafeCents
    uncleared_balance_cents: SafeCents
    working_balance_cents: SafeCents


class StartingBalanceContext(BaseModel):
    account_id: PositiveInt
    context_token: str
    bank_balance_cents: SafeCents | None = None
    bank_balance_fetched_at: datetime | None = None
    initialized_at: datetime | None = None
    before: StartingBalanceTotals | None = None
    pending_rows: list["LedgerRow"] = Field(default_factory=list)
    missing_pending_rows: list["LedgerRow"] = Field(default_factory=list)


class StartingBalancePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    context_token: str
    reference_balance_cents: SafeCents
    included_pending: list[Target] = Field(default_factory=list)

    _unique_included_pending = field_validator("included_pending")(unique_targets)

    @field_validator("context_token")
    @classmethod
    def nonblank_context_token(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Context token cannot be blank")
        return value


class StartingBalancePreview(BaseModel):
    preview_token: str
    before: StartingBalanceTotals | None = None
    after: StartingBalanceTotals


class StartingBalanceSuggestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    context_token: str
    reference_balance_cents: SafeCents

    @field_validator("context_token")
    @classmethod
    def nonblank_context_token(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Context token cannot be blank")
        return value


class StartingBalanceSuggestion(BaseModel):
    status: Literal["unique", "ambiguous", "none", "unsupported", "limit"]
    included_pending: list[Target] = Field(default_factory=list)
    available_balance_cents: SafeCents | None = None
    reason: str | None = None


class StartingBalanceConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_token: str
    reference_balance_cents: SafeCents
    included_pending: list[Target] = Field(default_factory=list)

    _unique_included_pending = field_validator("included_pending")(unique_targets)

    @field_validator("preview_token")
    @classmethod
    def nonblank_preview_token(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Preview token cannot be blank")
        return value


class PayeeHistoryPage(BaseModel):
    rows: list["LedgerRow"]
    total_count: int
    has_more: bool
    next_before_date: date_ | None = None
    next_before_id: int | None = None
    next_before_order: int | None = None


class PayeePreviewRequest(PayeeRuleSave):
    before_date: date_ | None = None
    before_id: int | None = None
    before_order: int | None = None


class PayeePreviewDecision(BaseModel):
    earlier_rule_id: int | None
    payee_id: int
    category_id: int | None
    changes_category: bool
    changes_retained_payee: bool
    eligible: bool
    blocked: Literal["account_not_initialized", "not_editable"] | None = None


class PayeePreview(PayeeHistoryPage):
    counts: dict[str, int]
    decisions: dict[str, PayeePreviewDecision]
    preview_token: str


class PayeeRuleApply(PayeeRuleSave):
    preview_token: str
    targets: list[Target] = Field(min_length=1)
    _unique_targets = field_validator("targets")(unique_targets)


class PayeeRuleTrace(BaseModel):
    transaction: "LedgerRow"
    merchant_name: str | None
    matching_rule_ids: list[int]
    deciding_rule_id: int | None
    payee_id: int | None
    category_id: int | None
    fallback_name: str | None


class PayeeCategoryMemory(BaseModel):
    payee_id: int
    remembered_category_id: int | None


class CategoryOut(BaseModel):
    rules: list[AffectedRule] = Field(default_factory=list)
    id: int
    name: str
    parent_id: int | None = None
    archived: bool
    is_discretionary: bool | None
    schedule_count: int = 0
    transaction_count: int


class CategoryTreeOut(CategoryOut):
    children: list[CategoryOut] = Field(default_factory=list)


class CategoryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    parent_id: int | None = None
    is_discretionary: StrictBool | None = None


class CategoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    parent_id: int | None = None
    archived: bool | None = None
    is_discretionary: StrictBool | None = None


class CategoryDelete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    destination_id: int | None


class LedgerMatchSummary(BaseModel):
    id: int
    state: Literal["suggested", "matched", "dismissed"]


class TransactionAllocationOut(BaseModel):
    id: int
    category_id: int | None = None
    category_name: str | None = None
    subcategory_name: str | None = None
    memo: str
    amount_cents: int
    unassigned: bool = False


class LedgerTransferSummary(BaseModel):
    account_id: int
    account_name: str
    label: str
    state: Literal["unlinked", "linked", "attention"]
    attention_reasons: list[str] = Field(default_factory=list)
    automatic_reason: Literal["destination", "provider"] | None = None


class BankContinuityRecord(BaseModel):
    id: int
    source_transaction_id: int
    target_transaction_id: int
    kind: Literal["provider", "explicit", "inferred_posted", "inferred_pending"]
    payee_source: Literal["source", "target"]
    transfer_source: Literal["source", "target"]
    category_source: Literal["source", "target"]
    memo_source: Literal["source", "target"]
    flag_source: Literal["source", "target"]


class LedgerBankContinuitySummary(BaseModel):
    inferred: bool
    associations: list[BankContinuityRecord]


class BankContinuityReject(BaseModel):
    model_config = ConfigDict(extra="forbid")
    record_id: PositiveInt
    transaction_id: PositiveInt
    context_token: str


class LedgerRow(BaseModel):
    match_role: Literal["feed", "history"] | None = None
    id: int
    account_id: int
    date: date_
    payee_kind: Literal["ordinary", "myself", "starting_balance", "unknown"]
    payee_id: int
    transfer_account_id: int | None = None
    category_id: int | None = None
    category_assigned: bool = False
    allocations: list[TransactionAllocationOut] = Field(default_factory=list)
    edit_token: str = ""
    description: str
    rule_description: str | None = None
    payee_category_memory: PayeeCategoryMemory | None = None
    memo: str
    amount_cents: int
    running_balance_cents: int | None = None
    status: Literal["pending", "uncleared", "cleared", "reconciled"]
    manually_cleared: bool
    approved: bool
    source: Literal["manual", "plaid", "starting_balance"]
    flag: TransactionFlag | None = None
    payee_name: str | None = None
    category_name: str | None = None
    subcategory_name: str | None = None
    match: LedgerMatchSummary | None = None
    transfer: LedgerTransferSummary | None = None
    bank_continuity: LedgerBankContinuitySummary | None = None
    missing_pending: bool = False
    pinned: bool = False
    excluded: bool = False
    allowed_actions: list[AllowedAction] = Field(default_factory=list)
    disabled_actions: dict[AllowedAction, str] = Field(default_factory=dict)
    editable_fields: list[EditableField] = Field(default_factory=list)


class RelationshipAction(BaseModel):
    kind: Literal["bank", "match", "transfer"]
    id: int
    source_id: int
    target_id: int
    source_label: str
    target_label: str
    context_token: str
    evidence: str
    consequence: str


class TransferInspection(BaseModel):
    partner: LedgerRow | None = None
    account_name: str
    anchor_id: int
    unavailable_reason: str | None = None
    action: RelationshipAction


class TransactionConnectionsContext(BaseModel):
    account_name: str
    transaction_id: int
    context_token: str
    records: list[BankContinuityRecord]
    sources: list[LedgerRow]
    representative: LedgerRow
    representative_id: int
    actions: list[RelationshipAction]
    transfer: TransferInspection | None = None


class AccountScopeFilter(BaseModel):
    account_id: int | None = None
    group_name: str | None = Field(default=None, min_length=1, max_length=80)


LedgerStatus = Literal["pending", "cleared", "uncleared", "reconciled", "unmatched"]
LedgerFilterId = Annotated[int, Field(gt=0, le=9007199254740991)]
LedgerCategoryValue = LedgerFilterId | Literal["none", "unassigned"]


class LedgerFilter(AccountScopeFilter):
    model_config = ConfigDict(extra="forbid")

    range: Literal["all", "this_month", "latest_3_months", "this_year"] = "all"
    statuses: list[LedgerStatus] = Field(default_factory=list, max_length=5)
    needs_review: bool = False
    source: Literal["manual", "plaid", "starting_balance"] | None = None
    payee_mode: Literal["include", "exclude"] | None = None
    payee_ids: list[LedgerFilterId] = Field(default_factory=list, max_length=200)
    description: str | None = None
    category_mode: Literal["include", "exclude"] | None = None
    category_values: list[LedgerCategoryValue] = Field(default_factory=list, max_length=200)
    memo: str | None = None
    amount_min_cents: int | None = None
    amount_max_cents: int | None = None
    scope: Literal["active", "excluded", "all_sources"] = "active"

    @model_validator(mode="after")
    def validate_selections(self) -> "LedgerFilter":
        for name in ("payee_ids", "category_values", "statuses"):
            values = getattr(self, name)
            if len(values) != len(set(values)):
                raise ValueError(f"{name} must contain unique values")
        for name, values in (("payee", self.payee_ids), ("category", self.category_values)):
            mode = getattr(self, f"{name}_mode")
            if values and mode is None:
                raise ValueError(f"Choose a {name} selection mode")
            if mode == "include" and not values:
                raise ValueError(f"Select at least one {name} value")
        return self


class LedgerFilterChoices(BaseModel):
    payee_ids: list[int]
    category_values: list[str]


class LedgerFilterSuggestions(BaseModel):
    values: list[str]


class LedgerFilterSuggestionQuery(AccountScopeFilter):
    field: Literal["description", "memo"]
    q: str = Field(min_length=1, max_length=512)


class LedgerPageQuery(LedgerFilter):
    page_size: int = 200
    before_date: date_ | None = None
    before_id: int | None = None
    before_order: int | None = None
    include_pinned: bool = True
    through_date: date_ | None = None


class LedgerPage(BaseModel):
    rows: list[LedgerRow]
    all_count: int
    active_count: int = 0
    excluded_count: int = 0
    filtered_count: int
    has_more: bool
    next_before_date: date_ | None = None
    next_before_id: int | None = None
    next_before_order: int | None = None


class LedgerExport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_ids: list[PositiveInt] = Field(min_length=1)
    include_history: StrictBool
    include_schedules: StrictBool
    date_from: date_ | None = None
    date_to: date_ | None = None
    include_pending: StrictBool = True
    split_mode: Literal["transaction", "category"] = "transaction"

    @field_validator("account_ids")
    @classmethod
    def unique_account_ids(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value):
            raise ValueError("Account ids must be unique")
        return value

    @model_validator(mode="after")
    def valid_selection(self):
        if not self.include_history and not self.include_schedules:
            raise ValueError("Choose at least one export type")
        if self.include_history:
            if (self.date_from is None) != (self.date_to is None):
                raise ValueError("Date range requires both bounds or neither")
            if self.date_from is not None and self.date_from > self.date_to:
                raise ValueError("Date range cannot end before it begins")
        return self


class TransactionAllocationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int | None = None
    category_id: int | None
    memo: str = ""
    amount_cents: StrictInt
    unassigned: StrictBool = False


class SingleCategorization(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["single"]
    category_id: int | None


class SplitCategorization(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["split"]
    allocations: list[TransactionAllocationInput] = Field(min_length=2)


Categorization = Annotated[
    SingleCategorization | SplitCategorization, Field(discriminator="kind")
]


class TransactionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: int
    date: date_
    duplicate_source_id: PositiveInt | None = None
    payee_id: PositiveInt
    transfer_account_id: PositiveInt | None = None
    categorization: Categorization | None = None
    memo: str = ""
    flag: TransactionFlag | None = None
    amount_cents: int

    @model_validator(mode="after")
    def explicit_categorization(self):
        if "categorization" in self.model_fields_set and self.categorization is None:
            raise ValueError("categorization cannot be null")
        return self


class TransactionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    review_after_edit: bool = False
    date: date_ | None = None
    payee_id: PositiveInt | None = None
    transfer_account_id: PositiveInt | None = None
    categorization: Categorization | None = None
    expected_edit_token: str | None = None
    memo: str | None = None
    amount_cents: int | None = None
    flag: TransactionFlag | None = None

    @model_validator(mode="after")
    def validate_update(self):
        if "categorization" in self.model_fields_set and self.categorization is None:
            raise ValueError("categorization cannot be null")
        if any(
            field in self.model_fields_set and getattr(self, field) is None
            for field in ("date", "payee_id", "memo", "amount_cents")
        ):
            raise ValueError("Transaction update fields cannot be null")
        return self


class TransactionTargets(BaseModel):
    model_config = ConfigDict(extra="forbid")
    targets: list[Target] = Field(min_length=1)

    _unique_targets = field_validator("targets")(unique_targets)


class LedgerHistoryPreview(BaseModel):
    warning: str | None


class TransactionBulkMove(TransactionTargets):
    destination_account_id: PositiveInt


class TransactionClearance(BaseModel):
    intent: Literal["cleared", "uncleared"]


class TransactionManualClearance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["clear", "undo"]
    expected_edit_token: str

    @field_validator("expected_edit_token")
    @classmethod
    def nonblank_expected_edit_token(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Expected edit token cannot be blank")
        return value


class TransactionReview(BaseModel):
    ids: list[int] = Field(min_length=1)
    approved: bool


class TransactionBulkChanges(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payee_id: PositiveInt | None = None
    transfer_account_id: PositiveInt | None = None
    category_id: PositiveInt | None = None
    memo: StrictStr = ""
    flag: TransactionFlag | None = None
    approved: StrictBool = False
    clearance: Literal["cleared", "uncleared"] | None = None
    manual_clearance: StrictBool = False

    @model_validator(mode="after")
    def has_change(self):
        if "payee_id" in self.model_fields_set and self.payee_id is None:
            raise ValueError("Payee cannot be cleared")
        if self.memo == "":
            self.model_fields_set.discard("memo")
        if not self.model_fields_set:
            raise ValueError("At least one bulk change is required")
        return self


class TransactionBulkApply(BaseModel):
    model_config = ConfigDict(extra="forbid")

    targets: list[Target] = Field(min_length=1)
    changes: TransactionBulkChanges
    memo_overwrite_confirmed: StrictBool = False

    @field_validator("targets")
    @classmethod
    def unique_ids(cls, value: list[Target]) -> list[Target]:
        return unique_targets(value)


class TransactionBulkApplyResult(BaseModel):
    status: Literal["ok"]
    rows: list[LedgerRow]


class TransactionMatchCreate(BaseModel):
    feed_transaction_id: int
    history_transaction_id: int
    context_token: str
    payee_source: Literal["feed", "history"]
    transfer_source: Literal["feed", "history"]
    description_source: Literal["feed", "history"]
    category_source: Literal["feed", "history"]
    memo_source: Literal["feed", "history"]
    flag_source: Literal["feed", "history"]


class TransactionUnmatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    context_token: str


class TransactionMatchContext(BaseModel):
    representative: LedgerRow
    unmatch_action: RelationshipAction | None = None
    transfer: TransferInspection | None = None
    context_token: str
    fixed_fields: list[Literal["payee", "transfer", "category"]] = Field(default_factory=list)
    blocking_reason: str | None = None
    id: int | None = None
    selections: dict[
        Literal["payee", "transfer", "description", "category", "memo", "flag"],
        Literal["feed", "history"] | None,
    ]
    feed: LedgerRow
    history: LedgerRow
    rationale: str


class MatchFinderContext(BaseModel):
    source: LedgerRow
    candidates: list[LedgerRow]
    candidate: LedgerRow | None = None
    comparison: TransactionMatchContext | None = None
    scope: Literal["nearby", "all"]
    next_cursor: str | None = None


class TransferDestination(BaseModel):
    id: int
    name: str
    type: AccountType
    closed: bool


class TransferCandidate(LedgerRow):
    account_name: str


class ComparisonRowEdits(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payee_id: PositiveInt | None = None
    category_id: PositiveInt | None = None
    memo: StrictStr = ""

    @model_validator(mode="after")
    def real_payee(self):
        if "payee_id" in self.model_fields_set and self.payee_id is None:
            raise ValueError("Payee cannot be cleared")
        return self


class TransferReviewProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payee_id: PositiveInt
    transfer_account_id: PositiveInt
    draft: "TransferDraft"


class TransferDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: date_
    duplicate_source_id: PositiveInt | None = None
    amount_cents: StrictInt
    memo: StrictStr = ""
    flag: TransactionFlag | None = None
    categorization: SingleCategorization | None = None


class TransferDraftPreview(BaseModel):
    category_label: str
    date: date_
    description: str
    amount_cents: int
    memo: str
    flag: TransactionFlag | None = None


class TransferDraftContextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: PositiveInt
    proposal: TransferReviewProposal
    scope: Literal["nearby", "all"] = "nearby"
    candidate_id: PositiveInt | None = None
    cursor: str | None = None


def require_transfer_candidate(command):
    if command.intent == "link" and command.candidate_id is None:
        raise ValueError("A candidate is required to link a transfer")
    if command.intent == "create_counterpart" and command.row_edits.payee_id is None:
        raise ValueError("Review and choose the counterpart Payee before creation")
    if command.intent == "save_unlinked" and command.row_edits.model_fields_set:
        raise ValueError("Save unlinked cannot save counterpart edits")
    return command


class TransferDraftCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    row_edits: ComparisonRowEdits = Field(default_factory=ComparisonRowEdits)

    account_id: PositiveInt
    proposal: TransferReviewProposal
    context_token: str
    intent: Literal["link", "create_counterpart", "save_unlinked"]
    candidate_id: PositiveInt | None = None

    link_requires_candidate = model_validator(mode="after")(require_transfer_candidate)

class TransferContext(BaseModel):
    source: LedgerRow | None = None
    draft: TransferDraftPreview | None = None
    destination: TransferDestination | None = None
    candidates: list[TransferCandidate]
    candidate: TransferCandidate | None = None
    scope: Literal["nearby", "all"]
    next_cursor: str | None = None
    context_token: str
    allowed_actions: list[Literal["link", "create_counterpart", "save_unlinked"]]
    proposal: TransferReviewProposal | None = None
    proposal_payee_name: str | None = None
    counterpart_payee_id: int | None = None
    search_all_accounts: bool = False
    counterpart_destinations: list[TransferDestination] = Field(default_factory=list)


class TransferReviewContextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal: TransferReviewProposal
    expected_edit_token: str | None = None
    scope: Literal["nearby", "all"] = "nearby"
    candidate_id: PositiveInt | None = None
    cursor: str | None = None

    @field_validator("expected_edit_token")
    @classmethod
    def nonblank_expected_edit_token(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Expected edit token cannot be blank")
        return value


class TransferReviewCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    row_edits: ComparisonRowEdits = Field(default_factory=ComparisonRowEdits)

    proposal: TransferReviewProposal
    context_token: str
    intent: Literal["link", "create_counterpart", "save_unlinked"]
    candidate_id: PositiveInt | None = None

    link_requires_candidate = model_validator(mode="after")(require_transfer_candidate)


class TransferCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    context_token: str


class TransferLinkCommand(TransferCommand):
    candidate_id: PositiveInt
    row_edits: ComparisonRowEdits = Field(default_factory=ComparisonRowEdits)


class TransferCounterpartCommand(TransferCommand):
    candidate_id: PositiveInt | None = None
    row_edits: ComparisonRowEdits

    @model_validator(mode="after")
    def reviewed_payee(self):
        if self.row_edits.payee_id is None:
            raise ValueError("Review and choose the counterpart Payee before creation")
        return self


class TransferResult(BaseModel):
    source: LedgerRow
    partner: LedgerRow | None = None


class PendingHistoryRelation(BaseModel):
    context_token: str
    id: int
    state: Literal["suggested", "matched"]
    feed_transaction_id: int
    history: LedgerRow


class PendingLifecycleContext(BaseModel):
    fixed_fields: list[Literal["payee", "transfer", "category"]] = Field(default_factory=list)
    blocking_reason: str | None = None
    disappearance_message: str
    pending: LedgerRow
    cleared: LedgerRow | None = None
    rationale: str
    context_token: str
    selections: dict[
        Literal["payee", "transfer", "category", "memo", "flag"],
        Literal["pending", "cleared"] | None,
    ]
    history_relations: list[PendingHistoryRelation]


class PendingLifecycleSelections(BaseModel):
    payee_source: Literal["pending", "cleared"]
    transfer_source: Literal["pending", "cleared"]
    category_source: Literal["pending", "cleared"]
    memo_source: Literal["pending", "cleared"]
    flag_source: Literal["pending", "cleared"]


class PendingLifecycleResolve(BaseModel):
    model_config = ConfigDict(extra="forbid")
    row_edits: ComparisonRowEdits = Field(default_factory=ComparisonRowEdits)
    pending_transaction_id: int
    cleared_transaction_id: int
    context_token: str
    selections: PendingLifecycleSelections


class PendingLifecycleDisappear(BaseModel):
    pending_transaction_id: int
    cleared_transaction_id: int | None = None
    context_token: str


class PlaidStatus(BaseModel):
    bank_sync_paused: bool = False
    schedule_revision: int = 0
    last_sync: datetime | None = None
    added: int = 0
    matched: int = 0
    suggested: int = 0
    queued: int = 0
    errors: list["PlaidSyncIssue"] = Field(default_factory=list)
    initial_import_account_ids: list[int] = Field(default_factory=list)


class PlaidSyncIssue(BaseModel):
    kind: Literal[
        "login_required",
        "missing_account",
        "temporary",
        "local_custody",
        "other",
        "transaction_warning",
        "rule_evaluation",
        "schedule_entry",
    ]
    message: str
    account_ids: list[int] = Field(default_factory=list)
    missing_account_ids: list[int] = Field(default_factory=list)


ScheduleFrequency = Literal[
    "once", "daily", "weekly", "every_other_week", "every_four_weeks",
    "monthly", "every_two_months", "every_three_months", "every_four_months",
    "twice_yearly", "yearly", "every_two_years",
]


class ScheduleDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: PositiveInt
    next_date: date_
    frequency: ScheduleFrequency
    anchor_day: Annotated[StrictInt, Field(ge=1, le=31)] | None = None
    payee_id: PositiveInt
    transfer_account_id: PositiveInt | None = None
    category_id: PositiveInt | None = None
    memo: str = ""
    amount_cents: SafeCents
    match_tolerance_cents: Annotated[StrictInt, Field(ge=0, le=9007199254740991)] = 0
    end_date: date_ | None = None


class ScheduleUpdate(ScheduleDefinition):
    edit_token: str


class ScheduleCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    edit_token: str


class ScheduleBulkChanges(BaseModel):
    model_config = ConfigDict(extra="forbid")
    payee_id: PositiveInt | None = None
    category_id: PositiveInt | None = None
    memo: str | None = None

    @model_validator(mode="after")
    def has_change(self):
        if "payee_id" in self.model_fields_set and self.payee_id is None:
            raise ValueError("Payee cannot be cleared")
        if self.memo in (None, ""):
            self.model_fields_set.discard("memo")
        if not self.model_fields_set:
            raise ValueError("At least one schedule change is required")
        return self


class ScheduleBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    targets: list[Target] = Field(min_length=1)
    action: Literal["enter_now", "skip", "send_to", "update"]
    destination_account_id: PositiveInt | None = None
    changes: ScheduleBulkChanges | None = None
    memo_overwrite_confirmed: StrictBool = False

    @field_validator("targets")
    @classmethod
    def unique_ids(cls, value: list[Target]) -> list[Target]:
        return unique_targets(value)

    @model_validator(mode="after")
    def action_fields(self):
        if (self.action == "send_to") != (self.destination_account_id is not None):
            raise ValueError("Only Send to account requires a destination")
        if (self.action == "update") != (self.changes is not None):
            raise ValueError("Only metadata Save requires changes")
        if self.memo_overwrite_confirmed and self.action != "update":
            raise ValueError("Memo confirmation requires metadata Save")
        return self


class StatusOk(BaseModel):
    status: Literal["ok"]


class StatusDeleted(BaseModel):
    status: Literal["deleted"]


class StatusRestored(BaseModel):
    status: Literal["restored"]


class StatusAbandoned(BaseModel):
    status: Literal["abandoned"]


class StatusConnected(BaseModel):
    status: Literal["connected"]
    account_id: int


class RestoreAccountPreview(BaseModel):
    id: int
    name: str
    working_balance_cents: int | None
    latest_transaction_date: date_ | None


class RestorePreview(BaseModel):
    digest: str
    generation: str
    recipient: str
    key_id: str
    created_at: str
    provider_configuration_matches: bool
    accounts: list[RestoreAccountPreview]


class LinkTokenOut(BaseModel):
    link_token: str
    configuration_identity: str | None = None


class PlaidExchangeOut(BaseModel):
    status: Literal["connected"]


class LocalAccountReference(BaseModel):
    id: int
    name: str


class ExistingProviderAccount(BaseModel):
    provider_account_id: str
    name: str
    mask: str | None
    type: str | None
    subtype: str | None
    currency: str | None
    current_balance_cents: int | None
    mapped_account: LocalAccountReference | None


class ExistingItemAccounts(BaseModel):
    item_id: int
    institution: str
    accounts: list[ExistingProviderAccount]
    missing_mapped_accounts: list[LocalAccountReference]


class ConversionChoices(BaseModel):
    payee_source: Literal["feed", "history"]
    transfer_source: Literal["feed", "history"]
    description_source: Literal["feed", "history"]
    category_source: Literal["feed", "history"]
    memo_source: Literal["feed", "history"]
    flag_source: Literal["feed", "history"]


class ConversionBalanceTotals(BaseModel):
    cleared_balance_cents: int
    uncleared_balance_cents: int
    working_balance_cents: int


class ConversionBucketCount(BaseModel):
    rows: int
    open: int
    matched: int


class ConversionBuckets(BaseModel):
    ready: ConversionBucketCount
    choice: ConversionBucketCount
    new: ConversionBucketCount
    kept: ConversionBucketCount
    pending: ConversionBucketCount


class ConversionPreview(BaseModel):
    preview_token: str
    buckets: ConversionBuckets
    unresolved_count: int
    matched_count: int
    returning_count: int
    returning_ready_count: int
    superseded_skipped_count: int
    pending_candidate_count: int
    pending_candidate_amount_cents: int
    plaid_current_balance_cents: int | None
    currency_code: str | None
    currency_warning: bool
    balance_fetched_at: datetime | None
    before: ConversionBalanceTotals
    after: ConversionBalanceTotals | None
    previous_starting_balance_cents: int | None
    starting_balance_cents: int | None
    history_seam_date: date_ | None
    history_seam_before_cents: int | None
    history_seam_after_cents: int | None
    can_commit: bool


class ConversionAttempt(BaseModel):
    id: str
    account_id: int
    state: Literal["fetching", "review", "failed"]
    error: str | None
    institution: str
    shared_item_id: int | None
    provider_account: dict[str, object]
    review_all_new: bool
    review: ConversionPreview | None


class ConversionLinkTokenStatus(BaseModel):
    attempt: ConversionAttempt | None
    link_token: str | None = None
    configuration_identity: str | None = None


class ConversionFeedBase(BaseModel):
    id: str
    date: date_
    payee_name: str | None
    description: str
    amount_cents: int
    pending: bool
    memo: str
    flag: None
    category_name: str | None
    source: Literal["plaid"] | None = None


class ConversionFeedRow(ConversionFeedBase):
    review_bucket: Literal["ready", "choice", "new", "kept", "pending"]
    review_status: Literal["open", "blocked", "matched", "new", "pending"]
    matched_history_id: int | None
    ready_history_id: int | None
    blocking_reason: str | None
    extra: bool


class ConversionHistoryRow(LedgerRow):
    review_bucket: Literal["ready", "choice", "new", "kept", "pending"]
    matched_feed_id: str | None
    extra: bool


class ConversionPage(BaseModel):
    rows: list[ConversionFeedRow]
    total_count: int
    next_cursor: str | None


class ConversionHistoryPage(BaseModel):
    rows: list[ConversionHistoryRow]
    total_count: int
    next_cursor: str | None


class ConversionEdge(BaseModel):
    feed_id: str
    history_id: int
    returning: bool
    blocking_reason: str | None
    fixed_owner: Literal["feed", "history"] | None
    decision: dict[str, object] | None = None


class ConversionComparison(BaseModel):
    edge: ConversionEdge
    feed: ConversionFeedBase
    history: LedgerRow
    feed_matched_history_id: int | None
    history_matched_feed_id: str | None
    choices: ConversionChoices
    rationale: str


class ConversionReview(BaseModel):
    attempt: ConversionAttempt
    feed: ConversionPage
    history: ConversionHistoryPage
    selected_feed_id: str | None
    selected_history_id: int | None
    feed_candidate_ids: list[int]
    history_candidate_ids: list[str]
    comparison: ConversionComparison | None


class ConversionDisconnectOut(BaseModel):
    status: Literal["disconnected"]


class OpenAIRegistrationOut(BaseModel):
    client_id: str
    email: str | None
    connected: bool
    verified: bool


class OpenAIStatusOut(BaseModel):
    revision: str
    ai_disabled: bool
    selected_model: str | None
    active_client_id: str | None
    registrations: list[OpenAIRegistrationOut]
    connected: bool
    plan_usage_enabled: bool
    usage_acknowledged: bool
    authorization_pending: bool
    authorization_attempt: str | None
    authorization_error: str | None


class OpenAIModelsOut(BaseModel):
    models: list["OpenAIModelOut"]


class OpenAIModelOut(BaseModel):
    slug: str
    display_name: str


class OpenAIAuthorizationOut(BaseModel):
    authorization_url: str
    attempt_id: str


class OpenAIDisconnectOut(BaseModel):
    state: OpenAIStatusOut
    revocation_confirmed: bool


class OpenAICheckOut(BaseModel):
    model: str
    message: str


class ScheduleRowOut(BaseModel):
    id: int
    account_id: int
    next_date: date_
    frequency: ScheduleFrequency
    anchor_day: int | None
    payee_id: int
    transfer_account_id: int | None = None
    category_id: int | None
    memo: str
    amount_cents: int
    match_tolerance_cents: int
    end_date: date_ | None
    account_name: str
    payee_name: str | None
    category_name: str | None
    pause_reason: str | None
    edit_token: str
    mirror: dict[str, int | str] | None
    ghost: bool
    projected_balance_cents: int | None = None
    allowed_actions: list[Literal["edit", "delete", "skip", "enter_now"]]


class SchedulePageOut(BaseModel):
    today: date_
    projected_balance_available: bool
    rows: list[ScheduleRowOut]
    move_account_ids: dict[int, list[int]]
    duplicate_transfer_candidates: list["ScheduleDuplicateTransfer"]


class ScheduleDuplicateTransfer(BaseModel):
    id: int
    account_id: int
    account_name: str
    target_account_id: int
    amount_cents: int


class ScheduleEnterOut(BaseModel):
    rows: list[LedgerRow]


class LedgerHistoryActionOut(BaseModel):
    id: str
    label: str
    account_ids: list[int]


class LedgerHistoryOutcomeOut(BaseModel):
    request_id: str
    status: Literal["committed", "not_committed", "expired"]
    message: str | None = None


class LedgerHistoryStateOut(BaseModel):
    epoch: str
    revision: int
    undo: LedgerHistoryActionOut | None
    redo: LedgerHistoryActionOut | None
    notice: str | None
    outcome: LedgerHistoryOutcomeOut | None
    database_generation: str


class LedgerHistoryReplayOut(BaseModel):
    epoch: str
    revision: int
    undo: LedgerHistoryActionOut | None
    redo: LedgerHistoryActionOut | None
    notice: str | None
    outcome: LedgerHistoryOutcomeOut | None
    message: str | None = None
    account_ids: list[int] | None = None


NonnegativeCents = Annotated[SafeCents, Field(ge=0)]


class LoanDetailsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["mortgage", "student", "other"]
    escrow_cents: NonnegativeCents


class LoanDetailsSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    details: LoanDetailsInput | None


class LoanResolve(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_difference_cents: Annotated[SafeCents, Field(gt=0)]
    escrow_cents: NonnegativeCents
    interest_cents: NonnegativeCents

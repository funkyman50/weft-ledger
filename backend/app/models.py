from datetime import date, datetime
from uuid import uuid4

from sqlalchemy import CheckConstraint, ForeignKey, Index, JSON, LargeBinary, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class CommandConfirmation(Base):
    __tablename__ = "command_confirmations"

    request_id: Mapped[str] = mapped_column(primary_key=True)
    database_generation: Mapped[str]
    page_session: Mapped[str]
    epoch: Mapped[str]
    sequence: Mapped[int]
    completed_at: Mapped[datetime]
    label: Mapped[str]


class AccountLogo(Base):
    __tablename__ = "account_logos"

    id: Mapped[str] = mapped_column(primary_key=True)
    name: Mapped[str]
    digest: Mapped[str] = mapped_column(index=True)
    image: Mapped[bytes] = mapped_column(LargeBinary)


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    logo_id: Mapped[str | None] = mapped_column(ForeignKey("account_logos.id", ondelete="RESTRICT"), default=None)
    group_name: Mapped[str | None] = mapped_column(default=None)
    cash_flow_reporting: Mapped[bool] = mapped_column(default=True)
    net_worth_reporting: Mapped[bool] = mapped_column(default=True)
    type: Mapped[str]
    sort_order: Mapped[int] = mapped_column(default=0)
    closed: Mapped[bool] = mapped_column(default=False)
    plaid_current_balance_cents: Mapped[int | None] = mapped_column(default=None)
    plaid_available_balance_cents: Mapped[int | None] = mapped_column(default=None)
    plaid_limit_cents: Mapped[int | None] = mapped_column(default=None)
    plaid_balance_iso_currency_code: Mapped[str | None] = mapped_column(default=None)
    plaid_balance_updated_at: Mapped[datetime | None] = mapped_column(default=None)
    starting_balance_initialized_at: Mapped[datetime | None] = mapped_column(
        default=None
    )
    plaid_history_imported_at: Mapped[datetime | None] = mapped_column(default=None)


class LoanDetails(Base):
    __tablename__ = "loan_details"

    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str]
    escrow_cents: Mapped[int]


class AccountBalanceObservation(Base):
    __tablename__ = "account_balance_observations"
    __table_args__ = (Index("ix_account_balance_observations_account_recorded", "account_id", "recorded_at", "id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    feed_key: Mapped[str]
    current_balance_cents: Mapped[int | None]
    currency_code: Mapped[str | None]
    recorded_at: Mapped[datetime]
    provider_updated_at: Mapped[datetime | None]


class Payee(Base):
    __tablename__ = "payees"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    name_key: Mapped[str]
    kind: Mapped[str] = mapped_column(default="ordinary")
    default_category_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), default=None
    )
    default_category_prompt_dismissed: Mapped[bool] = mapped_column(default=False)
    remembered_category_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), default=None
    )
    category_streak_ids: Mapped[list[int]] = mapped_column(JSON, default=list)


class PayeeRule(Base):
    __tablename__ = "payee_rules"
    id: Mapped[int] = mapped_column(primary_key=True)
    payee_id: Mapped[int] = mapped_column(ForeignKey("payees.id", ondelete="CASCADE"))
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="RESTRICT"), default=None)
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), default=None)
    position: Mapped[int]
    amount: Mapped[dict | None] = mapped_column(JSON, default=None)
    text_conditions: Mapped[list[dict]] = mapped_column(JSON, default=list)
    conditions_key: Mapped[str]


class Category(Base):
    __tablename__ = "categories"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    name_key: Mapped[str]
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id"), default=None
    )
    archived: Mapped[bool] = mapped_column(default=False)
    is_discretionary: Mapped[bool | None] = mapped_column(default=None)


class ScheduledTransaction(Base):
    __tablename__ = "scheduled_transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"))
    next_date: Mapped[date]
    frequency: Mapped[str]
    anchor_day: Mapped[int]
    payee_id: Mapped[int] = mapped_column(ForeignKey("payees.id"))
    transfer_account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"), default=None)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"), default=None)
    memo: Mapped[str] = mapped_column(default="")
    amount_cents: Mapped[int]
    match_tolerance_cents: Mapped[int] = mapped_column(default=0)
    end_date: Mapped[date | None] = mapped_column(default=None)


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (Index("ix_transactions_amount_date_account", "amount_cents", "date", "account_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"))
    date: Mapped[date]
    description: Mapped[str] = mapped_column(default="")
    payee_id: Mapped[int] = mapped_column(ForeignKey("payees.id"))
    transfer_account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"), default=None)
    transfer_payee_confirmed: Mapped[bool] = mapped_column(default=False)
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id"), default=None
    )
    category_assigned: Mapped[bool] = mapped_column(default=False)
    memo: Mapped[str] = mapped_column(default="")
    amount_cents: Mapped[int]
    match_tolerance_cents: Mapped[int] = mapped_column(default=0)
    status: Mapped[str]
    manually_cleared: Mapped[bool] = mapped_column(default=False)
    approved: Mapped[bool] = mapped_column(default=True)
    source: Mapped[str] = mapped_column(default="manual")
    flag: Mapped[str | None] = mapped_column(default=None)
    plaid_txn_id: Mapped[str | None] = mapped_column(default=None)
    plaid_raw: Mapped[dict | None] = mapped_column(JSON, default=None)
    plaid_removed_at: Mapped[datetime | None] = mapped_column(default=None)
    pending_resolved: Mapped[bool] = mapped_column(default=False)
    plaid_excluded_at: Mapped[datetime | None] = mapped_column(default=None)
    plaid_excluded_amount_cents: Mapped[int | None] = mapped_column(default=None)
    feed_historical_at: Mapped[datetime | None] = mapped_column(default=None)
    provider_lifecycle_detached_at: Mapped[datetime | None] = mapped_column(default=None)
    feed_replacement_id: Mapped[int | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="SET NULL"), default=None
    )
    pending_replacement_id: Mapped[int | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="SET NULL"), default=None
    )
    transfer_partner_id: Mapped[int | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="SET NULL"), default=None, unique=True
    )
    bank_continuity: Mapped["BankContinuity | None"] = relationship(
        "BankContinuity",
        primaryjoin="and_(Transaction.id == foreign(BankContinuity.target_transaction_id), BankContinuity.state == 'active')",
        foreign_keys="BankContinuity.target_transaction_id",
        viewonly=True,
        uselist=False,
        lazy="select",
    )


class BankContinuity(Base):
    __tablename__ = "bank_continuities"
    __table_args__ = (
        UniqueConstraint("source_transaction_id", "target_transaction_id"),
        CheckConstraint("source_transaction_id != target_transaction_id"),
        CheckConstraint("kind IN ('provider', 'explicit', 'inferred_posted', 'inferred_pending')"),
        CheckConstraint("state IN ('active', 'rejected', 'inactive')"),
        CheckConstraint("payee_source IN ('source', 'target')"),
        CheckConstraint("transfer_source IN ('source', 'target')"),
        CheckConstraint("category_source IN ('source', 'target')"),
        CheckConstraint("memo_source IN ('source', 'target')"),
        CheckConstraint("flag_source IN ('source', 'target')"),
        Index("uq_bank_continuities_active_successor", "source_transaction_id", unique=True, sqlite_where=text("state = 'active'")),
        Index("uq_bank_continuities_active_predecessor", "target_transaction_id", unique=True, sqlite_where=text("state = 'active'")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id", ondelete="CASCADE"))
    target_transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id", ondelete="CASCADE"))
    kind: Mapped[str]
    state: Mapped[str]
    payee_source: Mapped[str] = mapped_column(default="target")
    transfer_source: Mapped[str] = mapped_column(default="target")
    category_source: Mapped[str] = mapped_column(default="target")
    memo_source: Mapped[str] = mapped_column(default="target")
    flag_source: Mapped[str] = mapped_column(default="target")
    handoff: Mapped[dict] = mapped_column(JSON, default=dict, server_default=text("'{}'"))
    source_transaction: Mapped["Transaction"] = relationship(
        "Transaction", foreign_keys=[source_transaction_id]
    )
    target_transaction: Mapped["Transaction"] = relationship(
        "Transaction", foreign_keys=[target_transaction_id]
    )


class AutomaticTransferLink(Base):
    __tablename__ = "automatic_transfer_links"
    __table_args__ = (
        UniqueConstraint("outflow_transaction_id", "inflow_transaction_id"),
        CheckConstraint("outflow_transaction_id != inflow_transaction_id"),
        CheckConstraint("state IN ('active', 'rejected', 'inactive')"),
        CheckConstraint("reason IN ('destination', 'provider', 'explicit')"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    outflow_transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id", ondelete="CASCADE"))
    inflow_transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id", ondelete="CASCADE"))
    state: Mapped[str]
    reason: Mapped[str]
    handoff: Mapped[dict] = mapped_column(JSON, default=dict, server_default=text("'{}'"))


class TransactionAllocation(Base):
    __tablename__ = "transaction_allocations"

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE")
    )
    position: Mapped[int]
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id"), default=None
    )
    memo: Mapped[str] = mapped_column(default="")
    amount_cents: Mapped[int]
    unassigned: Mapped[bool] = mapped_column(default=False)


class TransactionMatch(Base):
    __tablename__ = "transaction_matches"
    id: Mapped[int] = mapped_column(primary_key=True)
    feed_transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE")
    )
    history_transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE")
    )
    state: Mapped[str] = mapped_column(default="suggested")
    matched_by: Mapped[str | None] = mapped_column(default=None)
    payee_source: Mapped[str | None] = mapped_column(default=None)
    transfer_source: Mapped[str | None] = mapped_column(default=None)
    description_source: Mapped[str | None] = mapped_column(default=None)
    category_source: Mapped[str | None] = mapped_column(default=None)
    memo_source: Mapped[str | None] = mapped_column(default=None)
    flag_source: Mapped[str | None] = mapped_column(default=None)
    feed_transaction: Mapped["Transaction"] = relationship(
        "Transaction", foreign_keys=[feed_transaction_id]
    )
    history_transaction: Mapped["Transaction"] = relationship(
        "Transaction", foreign_keys=[history_transaction_id]
    )


class PlaidItem(Base):
    __tablename__ = "plaid_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[str]
    client_id_hash: Mapped[str]
    environment: Mapped[str]
    access_token_enc: Mapped[str]
    cursor: Mapped[str] = mapped_column(default="")
    institution: Mapped[str]
    institution_id: Mapped[str | None] = mapped_column(default=None)


class PlaidAccountLink(Base):
    __tablename__ = "plaid_account_links"
    id: Mapped[int] = mapped_column(primary_key=True)
    plaid_item_id: Mapped[int] = mapped_column(
        ForeignKey("plaid_items.id", ondelete="CASCADE")
    )
    plaid_account_id: Mapped[str]
    balance_history_key: Mapped[str] = mapped_column(default=lambda: uuid4().hex, unique=True)
    account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE")
    )


class AccountConversionAttempt(Base):
    __tablename__ = "account_conversion_attempts"
    id: Mapped[str] = mapped_column(primary_key=True)
    singleton: Mapped[int] = mapped_column(default=1, unique=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), unique=True)
    plaid_item_id: Mapped[int] = mapped_column(ForeignKey("plaid_items.id", ondelete="CASCADE"), unique=True)
    plaid_account_id: Mapped[str] = mapped_column(unique=True)
    state: Mapped[str]
    cursor: Mapped[str] = mapped_column(default="")
    history_complete_at: Mapped[datetime | None] = mapped_column(default=None)
    current_balance_cents: Mapped[int | None] = mapped_column(default=None)
    available_balance_cents: Mapped[int | None] = mapped_column(default=None)
    limit_cents: Mapped[int | None] = mapped_column(default=None)
    currency_code: Mapped[str | None] = mapped_column(default=None)
    balance_fetched_at: Mapped[datetime | None] = mapped_column(default=None)
    provider_account: Mapped[dict] = mapped_column(JSON, default=dict)
    decisions: Mapped[dict] = mapped_column(JSON, default=dict)
    review_all_new: Mapped[bool] = mapped_column(default=False)
    error: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime]
    updated_at: Mapped[datetime]


class AccountConversionRow(Base):
    __tablename__ = "account_conversion_rows"
    id: Mapped[int] = mapped_column(primary_key=True)
    attempt_id: Mapped[str] = mapped_column(ForeignKey("account_conversion_attempts.id", ondelete="CASCADE"))
    provider_transaction_id: Mapped[str]
    raw: Mapped[dict] = mapped_column(JSON)
    date: Mapped[date]
    description: Mapped[str]
    amount_cents: Mapped[int]
    pending: Mapped[bool]
    removed_at: Mapped[datetime | None] = mapped_column(default=None)
    pending_transaction_id: Mapped[str | None] = mapped_column(default=None)


class PlaidSyncState(Base):
    __tablename__ = "plaid_sync_state"
    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    last_sync: Mapped[datetime | None] = mapped_column(default=None)
    schedule_revision: Mapped[int] = mapped_column(default=0)
    added: Mapped[int] = mapped_column(default=0)
    matched: Mapped[int] = mapped_column(default=0)
    suggested: Mapped[int] = mapped_column(default=0)
    queued: Mapped[int] = mapped_column(default=0)
    errors: Mapped[list[dict]] = mapped_column(JSON, default=list)

import hashlib
import json
import threading
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime
from itertools import batched
from pathlib import Path
from uuid import uuid4

from sqlalchemy import bindparam, delete, event, insert, or_, select, text, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, SessionTransaction

from app.db import SQL_ID_BATCH_SIZE
from app.diagnostics import diagnostics, lifecycle_fields, valid_uuid
from app.errors import AppError
from app.models import (
    Account,
    AutomaticTransferLink,
    BankContinuity,
    Category,
    Payee,
    ScheduledTransaction,
    Transaction,
    TransactionAllocation,
    TransactionMatch,
)

MAX_PAGES = 32
MAX_ACTIONS = 100
MAX_IMAGES = 20_000
MAX_OUTCOMES = 256
TRANSACTION_TABLE = Transaction.__table__
ALLOCATION_TABLE = TransactionAllocation.__table__
MATCH_TABLE = TransactionMatch.__table__
SCHEDULE_TABLE = ScheduledTransaction.__table__
RELATIONSHIP_TABLES = (
    ("continuities", BankContinuity.__table__, "source_transaction_id", "target_transaction_id"),
    ("automatic_transfers", AutomaticTransferLink.__table__, "outflow_transaction_id", "inflow_transaction_id"),
)
IMAGE_KEYS = ("schedules", "transactions", "allocations", "matches", "continuities", "automatic_transfers")


def _json_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _stable(value) -> str:
    return json.dumps(value, default=_json_value, sort_keys=True, separators=(",", ":"))


def _rows(connection, table, where=None):
    statement = select(table)
    if where is not None:
        statement = statement.where(where)
    return [dict(row) for row in connection.execute(statement).mappings()]


def _rows_for_ids(connection, table, identifiers, *columns, where=None):
    result = {}
    for batch in batched(sorted(set(identifiers)), SQL_ID_BATCH_SIZE):
        predicate = or_(*(column.in_(batch) for column in columns))
        if where is not None:
            predicate &= where
        for row in _rows(connection, table, predicate):
            result[row["id"]] = row
    return sorted(result.values(), key=lambda row: row["id"])


def _transaction_image(row: dict) -> dict:
    value = dict(row)
    raw = value.pop("plaid_raw", None)
    if raw is not None:
        value["plaid_raw_hash"] = hashlib.sha256(_stable(raw).encode()).hexdigest()
    else:
        value["plaid_raw_hash"] = None
    return value


def _handoff_targets(records):
    targets = set()
    for record in records:
        for row in (record["handoff"] or {}).get("rows", []):
            for stage in ("before", "applied"):
                values = row[stage]
                if values["transfer_account_id"] is not None:
                    targets.add(values["transfer_account_id"])
    return targets



def _reference_image(connection, transactions, allocations, schedules=(), relationships=()):
    transactions = [*transactions, *schedules]
    account_ids = {row["account_id"] for row in transactions}
    account_ids.update(row["transfer_account_id"] for row in transactions if row["transfer_account_id"] is not None)
    account_ids.update(_handoff_targets(relationships))
    category_ids = {
        row["category_id"] for row in transactions if row["category_id"] is not None
    } | {row["category_id"] for row in allocations if row["category_id"] is not None}
    payee_ids = {row["payee_id"] for row in transactions if row["payee_id"] is not None}
    categories = _rows_for_ids(connection, Category.__table__, category_ids, Category.id)
    payees = _rows_for_ids(connection, Payee.__table__, payee_ids, Payee.id)
    accounts = _rows_for_ids(connection, Account.__table__, account_ids, Account.id)
    for row in accounts:
        for key in (
            "plaid_current_balance_cents", "plaid_available_balance_cents", "plaid_limit_cents",
            "plaid_balance_iso_currency_code", "plaid_balance_updated_at", "plaid_history_imported_at",
        ):
            row.pop(key, None)
    for row in payees:
        row.pop("default_category_id", None)
        row.pop("default_category_prompt_dismissed", None)
        row.pop("remembered_category_id", None)
        row.pop("category_streak_ids", None)
    return {"accounts": accounts, "categories": categories, "payees": payees}


def _graph(connection, seeds: set[int], schedule_ids=()) -> dict:
    ids = {identifier for identifier in seeds if identifier is not None}
    previous = set()
    while ids != previous:
        previous = set(ids)
        if not ids:
            break
        transactions = _rows_for_ids(connection, TRANSACTION_TABLE, ids, TRANSACTION_TABLE.c.id)
        ids.update(
            row[key]
            for row in transactions
            for key in ("transfer_partner_id", "pending_replacement_id", "feed_replacement_id")
            if row[key] is not None
        )
        incoming = _rows_for_ids(
            connection,
            TRANSACTION_TABLE,
            ids,
            TRANSACTION_TABLE.c.transfer_partner_id,
            TRANSACTION_TABLE.c.pending_replacement_id,
            TRANSACTION_TABLE.c.feed_replacement_id,
        )
        ids.update(row["id"] for row in incoming)
        matches = _rows_for_ids(
            connection,
            MATCH_TABLE,
            ids, MATCH_TABLE.c.feed_transaction_id, MATCH_TABLE.c.history_transaction_id,
            where=MATCH_TABLE.c.state != "suggested",
        )
        ids.update(row["feed_transaction_id"] for row in matches)
        ids.update(row["history_transaction_id"] for row in matches)
        for _key, table, first, second in RELATIONSHIP_TABLES:
            records = _rows_for_ids(connection, table, ids, table.c[first], table.c[second])
            ids.update(row[field] for row in records for field in (first, second))
    transactions = _rows_for_ids(connection, TRANSACTION_TABLE, ids, TRANSACTION_TABLE.c.id)
    live_ids = {row["id"] for row in transactions}
    allocations = _rows_for_ids(connection, ALLOCATION_TABLE, live_ids, ALLOCATION_TABLE.c.transaction_id)
    matches = _rows_for_ids(
        connection,
        MATCH_TABLE,
        live_ids, MATCH_TABLE.c.feed_transaction_id, MATCH_TABLE.c.history_transaction_id,
        where=MATCH_TABLE.c.state != "suggested",
    )
    schedules = _rows_for_ids(connection, SCHEDULE_TABLE, schedule_ids, SCHEDULE_TABLE.c.id)
    relationships = {key: _rows_for_ids(connection, table, live_ids, table.c[first], table.c[second]) for key, table, first, second in RELATIONSHIP_TABLES}
    return {
        **relationships,
        "schedules": sorted(schedules, key=lambda row: row["id"]),
        "transactions": sorted((_transaction_image(row) for row in transactions), key=lambda row: row["id"]),
        "allocations": sorted(allocations, key=lambda row: row["id"]),
        "matches": sorted(matches, key=lambda row: row["id"]),
        "references": _reference_image(connection, transactions, allocations, schedules, relationships["automatic_transfers"]),
    }


def _normalize_expiry(before, after, expired_ids):
    if not expired_ids:
        return before
    after_matches = {row["id"]: row for row in after["matches"]}
    value = {**before, "matches": []}
    for row in before["matches"]:
        value["matches"].append(after_matches.get(row["id"], row) if row["id"] in expired_ids else row)
    return value


def _image_count(snapshot):
    return sum(len(snapshot[key]) for key in IMAGE_KEYS)


def preview_receipt_warning(db: Session, transaction_ids: set[int]) -> str | None:
    images = 2 * _image_count(_graph(db.connection(), transaction_ids))
    if images > MAX_IMAGES:
        return "This save may not be undoable and may end earlier undo history because it could change too many records."
    return None


def _empty_snapshot():
    return {**{key: [] for key in IMAGE_KEYS}, "references": {"accounts": [], "categories": [], "payees": []}}


def _merge_snapshot(original, incoming):
    result = _empty_snapshot()
    for key in IMAGE_KEYS:
        values = {row["id"]: row for row in original[key]}
        for row in incoming[key]:
            values.setdefault(row["id"], row)
        result[key] = sorted(values.values(), key=lambda row: row["id"])
    for key in ("accounts", "categories", "payees"):
        values = {row["id"]: row for row in original["references"][key]}
        for row in incoming["references"][key]:
            values.setdefault(row["id"], row)
        result["references"][key] = sorted(values.values(), key=lambda row: row["id"])
    return result


def _without_new(snapshot, absent):
    value = _empty_snapshot()
    value["schedules"] = [row for row in snapshot["schedules"] if row["id"] not in absent["schedules"]]
    transaction_ids = absent["transactions"]
    value["transactions"] = [row for row in snapshot["transactions"] if row["id"] not in transaction_ids]
    value["allocations"] = [row for row in snapshot["allocations"] if row["id"] not in absent["allocations"] and row["transaction_id"] not in transaction_ids]
    value["matches"] = [
        row for row in snapshot["matches"]
        if row["id"] not in absent["matches"]
        and row["feed_transaction_id"] not in transaction_ids
        and row["history_transaction_id"] not in transaction_ids
    ]
    for key, _table, first, second in RELATIONSHIP_TABLES:
        value[key] = [row for row in snapshot[key] if row["id"] not in absent[key] and row[first] not in transaction_ids and row[second] not in transaction_ids]
    referenced = value["transactions"] + value["schedules"]
    account_ids = {row["account_id"] for row in referenced}
    account_ids.update(row["transfer_account_id"] for row in referenced if row["transfer_account_id"] is not None)
    account_ids.update(_handoff_targets(value["automatic_transfers"]))
    category_ids = {row["category_id"] for row in referenced if row["category_id"] is not None} | {row["category_id"] for row in value["allocations"] if row["category_id"] is not None}
    payee_ids = {row["payee_id"] for row in referenced if row["payee_id"] is not None}
    value["references"] = {
        "accounts": [row for row in snapshot["references"]["accounts"] if row["id"] in account_ids],
        "categories": [row for row in snapshot["references"]["categories"] if row["id"] in category_ids],
        "payees": [row for row in snapshot["references"]["payees"] if row["id"] in payee_ids],
    }
    return value


@dataclass
class Receipt:
    id: str
    label: str
    account_ids: list[int]
    before: dict
    after: dict
    references: dict


@dataclass
class PageHistory:
    epoch: str = field(default_factory=lambda: str(uuid4()))
    receipts: list[Receipt] = field(default_factory=list)
    cursor: int = 0
    revision: int = 0
    notice: str | None = None
    outcomes: OrderedDict = field(default_factory=OrderedDict)
    highwater: int = 0
    active: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)


class LedgerHistoryManager:
    def __init__(self, database_generation: str):
        self.database_generation = database_generation
        self.pages: OrderedDict[str, PageHistory] = OrderedDict()
        self._lock = threading.Lock()

    def _page(self, session_id: str, *, create=False):
        page = self.pages.get(session_id)
        if page is None and create:
            if len(self.pages) >= MAX_PAGES:
                for key, item in list(self.pages.items()):
                    if not item.active:
                        self.pages.pop(key)
                        break
            if len(self.pages) >= MAX_PAGES:
                raise AppError("history_capacity", "Undo history is busy. Try again shortly.", 409)
            page = PageHistory()
            self.pages[session_id] = page
        if page is not None:
            self.pages.move_to_end(session_id)
        return page

    @contextmanager
    def locked_page(self, session_id: str, *, create=False):
        with self._lock:
            page = self._page(session_id, create=create)
            if page is None:
                raise AppError("history_expired", "The register session changed. Your unsaved work is still here. Try again once the register finishes refreshing.", 409)
            page.active += 1
        page.lock.acquire()
        try:
            yield page
        finally:
            page.lock.release()
            with self._lock:
                page.active -= 1

    def state(self, page: PageHistory, request_id=None, request_sequence=None):
        undo = page.receipts[page.cursor - 1] if page.cursor else None
        redo = page.receipts[page.cursor] if page.cursor < len(page.receipts) else None
        outcome = None
        if request_id is not None:
            item = page.outcomes.get(request_id)
            if item is not None:
                outcome = item
            elif request_sequence is not None and request_sequence <= page.highwater:
                outcome = {"request_id": request_id, "status": "expired", "message": "The request outcome expired. Refresh data before saving again."}
            else:
                page.highwater = max(page.highwater, request_sequence or 0)
                outcome = {"request_id": request_id, "status": "not_committed"}
        return {
            "epoch": page.epoch,
            "revision": page.revision,
            "undo": _receipt_out(undo),
            "redo": _receipt_out(redo),
            "notice": page.notice,
            "outcome": outcome,
        }

    def complete(self, page, request_id, sequence, notice):
        page.highwater = max(page.highwater, sequence)
        page.outcomes[request_id] = {"request_id": request_id, "status": "committed", "message": notice}
        page.outcomes.move_to_end(request_id)
        while len(page.outcomes) > MAX_OUTCOMES:
            page.outcomes.popitem(last=False)

    def add(self, page, receipt: Receipt, request_id, sequence):
        if page.cursor < len(page.receipts):
            page.receipts = page.receipts[:page.cursor]
        incoming_images = _image_count(receipt.before) + _image_count(receipt.after)
        while page.receipts and (
            len(page.receipts) >= MAX_ACTIONS
            or sum(_image_count(item.before) + _image_count(item.after) for item in page.receipts) + incoming_images > MAX_IMAGES
        ):
            page.receipts.pop(0)
            page.cursor -= 1
        if incoming_images > MAX_IMAGES:
            page.receipts = []
            page.cursor = 0
            page.notice = "This save cannot be undone because it changed too many records."
        else:
            page.receipts.append(receipt)
            page.cursor = len(page.receipts)
            page.notice = None
        page.revision += 1
        self.complete(page, request_id, sequence, receipt.label)

    def clear(self, page, request_id, sequence, message):
        page.receipts = []
        page.cursor = 0
        page.revision += 1
        page.notice = message
        self.complete(page, request_id, sequence, message)


@dataclass(frozen=True)
class PageRequest:
    session: str
    request_id: str
    sequence: int
    epoch: str


@dataclass
class HistoryCapture:
    manager: LedgerHistoryManager
    page: PageHistory
    request_id: str
    sequence: int
    label: str
    seeds: set[int] = field(default_factory=set)
    schedule_ids: set[int] = field(default_factory=set)
    new_objects: set[ScheduledTransaction | Transaction | TransactionAllocation | TransactionMatch | BankContinuity | AutomaticTransferLink] = field(default_factory=set)
    absent: dict[str, set[int]] = field(default_factory=lambda: {name: set() for name in IMAGE_KEYS})
    before: dict = field(default_factory=_empty_snapshot)
    after: dict | None = None


@dataclass
class PageCompletion:
    manager: LedgerHistoryManager
    page: PageHistory
    request_id: str
    sequence: int
    message: str
    preserve_history: bool
    changed: bool = False


@dataclass
class WriteContext:
    command: bool = False
    request: PageRequest | None = None
    reservation: SessionTransaction | None = None
    capture: HistoryCapture | None = None
    completion: PageCompletion | None = None
    expired_matches: set[int] = field(default_factory=set)
    diagnostic_events: list[dict] = field(default_factory=list)
    diagnostic_blocks: dict[tuple, dict] = field(default_factory=dict)
    diagnostic_omitted: int = 0
    diagnostic_generation: str | None = None

    def clear_transaction(self) -> None:
        self.reservation = None
        self.capture = None
        self.completion = None
        self.expired_matches = set()
        self.diagnostic_events = []
        self.diagnostic_blocks = {}
        self.diagnostic_omitted = 0
        self.diagnostic_generation = None


def write_context(db: Session) -> WriteContext:
    context = db.info.get(WriteContext)
    if context is None:
        context = WriteContext()
        db.info[WriteContext] = context
    return context


def report_expired_match(db: Session, identifier: int) -> None:
    write_context(db).expired_matches.add(identifier)


def record_lifecycle(db, workflow, decision, reason, **fields):
    try:
        if not db.in_transaction() or db.in_nested_transaction():
            return
        context = write_context(db)
        if context.diagnostic_generation is None:
            context.diagnostic_generation = ""
            path = Path(db.get_bind().url.database)
            context.diagnostic_generation = valid_uuid(path.with_name(path.name + ".generation").read_text().strip()) or ""
        if not context.diagnostic_generation:
            return
        values = lifecycle_fields(workflow, decision, reason, database_generation=context.diagnostic_generation, **fields)
        if not {"workflow", "decision", "reason"}.issubset(values):
            context.diagnostic_omitted += 1
            return
        if decision == "blocked":
            key = (workflow, values.get("account_id"), reason)
            summary = context.diagnostic_blocks.get(key)
            if summary is None:
                if len(context.diagnostic_blocks) >= 200:
                    context.diagnostic_omitted += 1
                    return
                summary = {**values, "blocked_count": 0, "sample_count": int("transaction_id" in values)}
                context.diagnostic_blocks[key] = summary
            elif summary["sample_count"] == 1 and (values.get("transaction_id"), values.get("candidate_id")) != (summary.get("transaction_id"), summary.get("candidate_id")):
                summary.update(other_transaction_id=values.get("transaction_id"), other_candidate_id=values.get("candidate_id"), sample_count=2)
            summary["blocked_count"] += 1
        elif len(context.diagnostic_events) < 800:
            context.diagnostic_events.append(values)
        else:
            context.diagnostic_omitted += 1
    except Exception:
        pass


def _receipt_out(receipt):
    if receipt is None:
        return None
    return {"id": receipt.id, "label": receipt.label, "account_ids": receipt.account_ids}


def _reference_union(before, after):
    result = {"accounts": [], "categories": [], "payees": []}
    for key in result:
        values = {row["id"]: row for row in before["references"][key]}
        values.update({row["id"]: row for row in after["references"][key]})
        result[key] = sorted(values.values(), key=lambda row: row["id"])
    return result


def _current_references(connection, references):
    result = {"accounts": [], "categories": [], "payees": []}
    for key, table in (("accounts", Account.__table__), ("categories", Category.__table__), ("payees", Payee.__table__)):
        ids = {row["id"] for row in references[key]}
        if ids:
            result[key] = _rows_for_ids(connection, table, ids, table.c.id)
    for row in result["accounts"]:
        for key in ("plaid_current_balance_cents", "plaid_available_balance_cents", "plaid_limit_cents", "plaid_balance_iso_currency_code", "plaid_balance_updated_at", "plaid_history_imported_at"):
            row.pop(key, None)
    for row in result["payees"]:
        row.pop("default_category_id", None)
        row.pop("default_category_prompt_dismissed", None)
        row.pop("remembered_category_id", None)
        row.pop("category_streak_ids", None)
    return result


def _without_references(snapshot):
    return {key: value for key, value in snapshot.items() if key != "references"}


def reserve_write(db: Session):
    transaction = db.get_transaction()
    if transaction is not None and write_context(db).reservation is transaction:
        return
    try:
        db.execute(text("BEGIN IMMEDIATE"))
    except OperationalError as error:
        if "locked" in str(error).lower() or "busy" in str(error).lower():
            raise AppError("database_busy", "Another save is finishing. Try again.", 409) from error
        raise
    write_context(db).reservation = db.get_transaction()


def install_listeners():
    if getattr(install_listeners, "installed", False):
        return
    install_listeners.installed = True

    @event.listens_for(Session, "before_flush")
    def _before_flush(db, _context, _instances):
        capture = write_context(db).capture
        completion = write_context(db).completion
        if capture is None and not completion:
            return
        changed = list(db.new) + list(db.dirty) + list(db.deleted)
        if completion:
            completion.changed = completion.changed or any(
                item in db.new or item in db.deleted or db.is_modified(item, include_collections=False)
                for item in changed
            )
        if capture is None:
            return
        seeds = capture.seeds
        capture.new_objects.update(
            item for item in db.new if isinstance(item, (ScheduledTransaction, Transaction, TransactionAllocation, TransactionMatch, BankContinuity, AutomaticTransferLink))
        )
        for item in changed:
            if isinstance(item, ScheduledTransaction):
                if item.id is not None:
                    capture.schedule_ids.add(item.id)
            elif isinstance(item, Transaction):
                if item.id is not None:
                    seeds.add(item.id)
            elif isinstance(item, TransactionAllocation):
                if item.transaction_id is not None:
                    seeds.add(item.transaction_id)
            elif isinstance(item, TransactionMatch):
                if item.id in write_context(db).expired_matches:
                    continue
                seeds.update((item.feed_transaction_id, item.history_transaction_id))
            elif isinstance(item, BankContinuity):
                seeds.update((item.source_transaction_id, item.target_transaction_id))
            elif isinstance(item, AutomaticTransferLink):
                seeds.update((item.outflow_transaction_id, item.inflow_transaction_id))
        if seeds or capture.schedule_ids:
            before = _without_new(_graph(db.connection(), seeds, capture.schedule_ids), capture.absent)
            capture.before = _merge_snapshot(capture.before, before)

    @event.listens_for(Session, "after_flush_postexec")
    def _after_flush(db, _context):
        capture = write_context(db).capture
        if capture is None:
            return
        for item in capture.new_objects:
            if isinstance(item, ScheduledTransaction) and item.id is not None:
                capture.absent["schedules"].add(item.id)
                capture.schedule_ids.add(item.id)
            elif isinstance(item, Transaction) and item.id is not None:
                capture.absent["transactions"].add(item.id)
                capture.seeds.add(item.id)
            elif isinstance(item, TransactionAllocation) and item.id is not None:
                capture.absent["allocations"].add(item.id)
                capture.seeds.add(item.transaction_id)
            elif isinstance(item, TransactionMatch) and item.id is not None:
                capture.absent["matches"].add(item.id)
                capture.seeds.update((item.feed_transaction_id, item.history_transaction_id))
            elif isinstance(item, BankContinuity) and item.id is not None:
                capture.absent["continuities"].add(item.id)
                capture.seeds.update((item.source_transaction_id, item.target_transaction_id))
            elif isinstance(item, AutomaticTransferLink) and item.id is not None:
                capture.absent["automatic_transfers"].add(item.id)
                capture.seeds.update((item.outflow_transaction_id, item.inflow_transaction_id))
        after_seeds = capture.seeds | {row["id"] for row in capture.before["transactions"]}
        if after_seeds or capture.schedule_ids:
            capture.after = _graph(db.connection(), after_seeds, capture.schedule_ids)

    @event.listens_for(Session, "after_commit")
    def _after_commit(db):
        if db.in_nested_transaction():
            return
        context = write_context(db)
        capture, completion, expired = context.capture, context.completion, context.expired_matches
        try:
            diagnostics.publish_lifecycle(context.diagnostic_events, context.diagnostic_blocks, context.diagnostic_omitted, context.diagnostic_generation)
        except Exception:
            pass
        context.clear_transaction()
        if capture is not None:
            manager, page = capture.manager, capture.page
            empty = _empty_snapshot()
            after = capture.after or empty
            before = _normalize_expiry(capture.before or empty, after, expired)
            if _stable(before) != _stable(after):
                account_ids = sorted({row["account_id"] for row in before["transactions"] + after["transactions"] + before["schedules"] + after["schedules"]})
                manager.add(page, Receipt(str(uuid4()), capture.label, account_ids, before, after, _reference_union(before, after)), capture.request_id, capture.sequence)
            else:
                manager.complete(page, capture.request_id, capture.sequence, "No saved data changed.")
        elif completion:
            if completion.changed:
                if completion.preserve_history:
                    completion.manager.complete(completion.page, completion.request_id, completion.sequence, completion.message)
                else:
                    completion.manager.clear(completion.page, completion.request_id, completion.sequence, completion.message)
            else:
                completion.manager.complete(completion.page, completion.request_id, completion.sequence, "No saved data changed.")

    @event.listens_for(Session, "after_rollback")
    def _after_rollback(db):
        if db.in_nested_transaction():
            return
        write_context(db).clear_transaction()


def start_capture(db, manager, page, request_id, sequence, label):
    write_context(db).capture = HistoryCapture(manager, page, request_id, sequence, label)


def start_completion(
    db,
    manager,
    page,
    request_id,
    sequence,
    message,
    preserve_history,
):
    completion = PageCompletion(manager, page, request_id, sequence, message, preserve_history)
    write_context(db).completion = completion
    return completion


def replay(db, page, action_id, expected_revision, direction):
    if expected_revision != page.revision:
        raise AppError("history_revision_stale", "Undo history changed. Refresh it and try again.", 409)
    index = page.cursor - 1 if direction == "undo" else page.cursor
    if index < 0 or index >= len(page.receipts) or page.receipts[index].id != action_id:
        raise AppError("history_action_stale", "That undo action is no longer current.", 409)
    receipt = page.receipts[index]
    expected, desired = (receipt.after, receipt.before) if direction == "undo" else (receipt.before, receipt.after)
    schedule_ids = {row["id"] for row in expected["schedules"] + desired["schedules"]}
    current = _graph(db.connection(), {row["id"] for row in expected["transactions"] + desired["transactions"]}, schedule_ids)
    if _stable(_without_references(current)) != _stable(_without_references(expected)) or _stable(_current_references(db.connection(), receipt.references)) != _stable(receipt.references):
        _invalidate(page)
    try:
        _restore(db, desired, {row["id"] for row in current["transactions"]} | {row["id"] for row in expected["transactions"]}, schedule_ids)
    except AppError as error:
        if error.code == "history_conflict":
            _invalidate(page)
        raise
    if direction == "undo":
        message = f"{receipt.label} undone."
    else:
        message = f"{receipt.label} redone."
    return receipt, message


def _invalidate(page):
    page.receipts = []
    page.cursor = 0
    page.revision += 1
    page.notice = "This action can no longer be reversed because related records changed."
    raise AppError("history_conflict", page.notice, 409)


def publish_replay(page, direction, message):
    page.cursor += -1 if direction == "undo" else 1
    page.revision += 1
    page.notice = message


def _restore(db, snapshot, affected_ids, schedule_ids):
    for batch in batched(schedule_ids, SQL_ID_BATCH_SIZE):
        db.execute(delete(SCHEDULE_TABLE).where(SCHEDULE_TABLE.c.id.in_(batch)))
    if snapshot["schedules"]:
        db.execute(insert(SCHEDULE_TABLE), snapshot["schedules"])
    desired_transactions = {row["id"]: row for row in snapshot["transactions"]}
    desired_allocations = {row["id"]: row for row in snapshot["allocations"]}
    desired_matches = {row["id"]: row for row in snapshot["matches"]}
    ids = set(desired_transactions) | set(affected_ids)
    # Current closure was verified, so these deletes cannot affect an unrecorded relation.
    for batch in batched(ids, SQL_ID_BATCH_SIZE):
        db.execute(delete(MATCH_TABLE).where((MATCH_TABLE.c.feed_transaction_id.in_(batch)) | (MATCH_TABLE.c.history_transaction_id.in_(batch))))
        db.execute(delete(ALLOCATION_TABLE).where(ALLOCATION_TABLE.c.transaction_id.in_(batch)))
        for _key, table, first, second in RELATIONSHIP_TABLES:
            db.execute(delete(table).where(or_(table.c[first].in_(batch), table.c[second].in_(batch))))
        db.execute(update(TRANSACTION_TABLE).where(TRANSACTION_TABLE.c.id.in_(batch)).values(transfer_partner_id=None, pending_replacement_id=None))
    current = {row["id"]: row for row in _rows_for_ids(db.connection(), TRANSACTION_TABLE, ids, TRANSACTION_TABLE.c.id)}
    for identifier in set(current) - set(desired_transactions):
        if current[identifier]["source"] == "plaid":
            raise AppError("history_conflict", "This action can no longer be reversed because related records changed.", 409)
        db.execute(delete(TRANSACTION_TABLE).where(TRANSACTION_TABLE.c.id == identifier))
    transaction_updates = {}
    for identifier, row in desired_transactions.items():
        values = {key: value for key, value in row.items() if key not in ("plaid_raw_hash", "transfer_partner_id", "pending_replacement_id")}
        if identifier not in current:
            if row["source"] != "manual":
                raise AppError("history_conflict", "This action can no longer be reversed because related records changed.", 409)
            db.execute(insert(TRANSACTION_TABLE).values(**values, transfer_partner_id=None, pending_replacement_id=None))
        else:
            existing = current[identifier]
            if existing["source"] == "plaid":
                locally_owned = (
                    "payee_id", "transfer_account_id", "transfer_payee_confirmed",
                    "category_id", "category_assigned", "memo", "approved", "flag",
                    "manually_cleared", "plaid_excluded_at", "plaid_excluded_amount_cents",
                    "feed_replacement_id",
                )
                if existing["provider_lifecycle_detached_at"] is not None:
                    locally_owned += ("status",)
                values = {key: values[key] for key in locally_owned}
            values.pop("id", None)
            transaction_updates.setdefault(tuple(sorted(values)), []).append({"_id": identifier, **values})
    for columns, values in transaction_updates.items():
        db.connection().execute(
            update(TRANSACTION_TABLE)
            .where(TRANSACTION_TABLE.c.id == bindparam("_id"))
            .values({column: bindparam(column) for column in columns}),
            values,
        )
    allocation_collisions = _rows_for_ids(
        db.connection(), ALLOCATION_TABLE, desired_allocations, ALLOCATION_TABLE.c.id,
    )
    match_collisions = _rows_for_ids(
        db.connection(), MATCH_TABLE, desired_matches, MATCH_TABLE.c.id,
    )
    if allocation_collisions or match_collisions:
        raise AppError("history_conflict", "This action can no longer be reversed because related records changed.", 409)
    if desired_allocations:
        db.execute(insert(ALLOCATION_TABLE), list(desired_allocations.values()))
    if desired_matches:
        db.execute(insert(MATCH_TABLE), list(desired_matches.values()))
    for key, table, _first, _second in RELATIONSHIP_TABLES:
        if snapshot[key]:
            if _rows_for_ids(db.connection(), table, [row["id"] for row in snapshot[key]], table.c.id):
                raise AppError("history_conflict", "Related bank associations changed.", 409)
            db.execute(insert(table), snapshot[key])
    for column in ("pending_replacement_id", "transfer_partner_id"):
        values = [
            {"_id": identifier, column: row[column]}
            for identifier, row in desired_transactions.items()
            if row[column] is not None
        ]
        if values:
            db.connection().execute(
                update(TRANSACTION_TABLE)
                .where(TRANSACTION_TABLE.c.id == bindparam("_id"))
                .values({column: bindparam(column)}),
                values,
            )
    db.flush()

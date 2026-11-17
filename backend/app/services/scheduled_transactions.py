import calendar
import hashlib
import json
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.diagnostics import diagnostics
from app.errors import AppError
from app.models import Account, Category, Payee, ScheduledTransaction
from app.schemas import ScheduleBatch, ScheduleDefinition, SingleCategorization, TransactionCreate
from app.services import categories, ledger, ledger_projection, transfers, payee_identity, payees
from app.services import transaction_matching as matching

DAY_INTERVALS = {"daily": 1, "weekly": 7, "every_other_week": 14, "every_four_weeks": 28}
MONTH_INTERVALS = {"monthly": 1, "every_two_months": 2, "every_three_months": 3, "every_four_months": 4, "twice_yearly": 6, "yearly": 12, "every_two_years": 24}
# The widest Look ahead choice; the browser narrows previews to the selected cutoff.
PREVIEW_DAYS = 84


def next_occurrence(current: date, frequency: str, anchor_day: int) -> date | None:
    if frequency == "once":
        return None
    if frequency in DAY_INTERVALS:
        return current + timedelta(days=DAY_INTERVALS[frequency])
    month = current.year * 12 + current.month - 1 + MONTH_INTERVALS[frequency]
    year, month_index = divmod(month, 12)
    return date(year, month_index + 1, min(anchor_day, calendar.monthrange(year, month_index + 1)[1]))


def image(schedule: ScheduledTransaction) -> dict:
    return {column.name: getattr(schedule, column.name) for column in ScheduledTransaction.__table__.columns}


def target(db: Session, schedule: ScheduledTransaction) -> Account | None:
    return payee_identity.target(db, schedule.transfer_account_id)


def pause_reason(db: Session, schedule: ScheduledTransaction) -> str | None:
    source = db.get(Account, schedule.account_id)
    destination = target(db, schedule)
    closed = [account.name for account in (source, destination) if account and account.closed]
    if closed:
        return f"Paused · {', '.join(closed)} closed"
    payee = db.get(Payee, schedule.payee_id)
    if payee is None or payee.kind not in ("ordinary", "myself"):
        return "Paused · choose a Payee"
    return None


def token(db: Session, schedule: ScheduledTransaction) -> str:
    source, destination = db.get(Account, schedule.account_id), target(db, schedule)
    category = db.get(Category, schedule.category_id) if schedule.category_id else None
    parent = db.get(Category, category.parent_id) if category and category.parent_id else None
    payee = db.get(Payee, schedule.payee_id)
    facts = [image(schedule), [(a.id, a.name, a.closed, ledger_projection.account_requires_initialization(db, a.id)) for a in (source, destination) if a], [(c.id, c.name, c.archived, c.parent_id) for c in (category, parent) if c], (payee.id, payee.name) if payee else None]
    return hashlib.sha256(json.dumps(facts, default=str, sort_keys=True).encode()).hexdigest()


def can_enter(db: Session, schedule: ScheduledTransaction) -> bool:
    return (
        pause_reason(db, schedule) is None
        and not ledger_projection.account_requires_initialization(db, schedule.account_id)
        and (schedule.transfer_account_id is None or not ledger_projection.account_requires_initialization(db, schedule.transfer_account_id))
    )


def projection(db: Session, schedule: ScheduledTransaction) -> dict:
    source = db.get(Account, schedule.account_id)
    payee = db.get(Payee, schedule.payee_id)
    category = db.get(Category, schedule.category_id) if schedule.category_id else None
    reason = pause_reason(db, schedule)
    category_name = categories.category_out(db, category, 0)["name"] if category else None
    return {**image(schedule), "account_name": source.name, "payee_name": payee.name if payee else None, "category_name": category_name, "pause_reason": reason, "edit_token": token(db, schedule), "mirror": None, "ghost": False, "allowed_actions": ["edit", "delete"] + (["skip"] if reason is None else []) + (["enter_now"] if can_enter(db, schedule) else [])}


def mirror_projection(db: Session, schedule: ScheduledTransaction, destination: Account) -> dict:
    owner = db.get(Account, schedule.account_id)
    payee = db.get(Payee, schedule.payee_id)
    amount = -schedule.amount_cents
    return {**image(schedule), "account_id": destination.id, "amount_cents": amount, "match_tolerance_cents": 0,
            "transfer_account_id": owner.id, "category_id": None, "account_name": destination.name,
            "payee_name": payee.name, "category_name": None,
            "pause_reason": None, "edit_token": "", "mirror": {"account_id": owner.id, "account_name": owner.name}, "ghost": False, "allowed_actions": []}


def _payee_assignment_snapshot(db: Session, payee_id: int) -> dict:
    payee = payees.require_assignable(db, payee_id)
    definitions = db.scalars(select(ScheduledTransaction).where(
        ScheduledTransaction.payee_id == payee_id,
    ).order_by(ScheduledTransaction.next_date.desc(), ScheduledTransaction.id.desc())).all()
    rows = [{
        "id": row.id, "account_name": db.get(Account, row.account_id).name,
        "date": row.next_date, "amount_cents": row.amount_cents,
        "frequency": row.frequency, "memo": row.memo,
    } for row in definitions]
    identity = payees.out(db, payee, schedule_count=len(rows))
    return {
        "payee": identity, "rows": rows, "total_count": len(rows),
        "preview_token": hashlib.sha256(json.dumps(
            ["payee-schedules", identity, [token(db, row) for row in definitions]],
            sort_keys=True, default=str,
        ).encode()).hexdigest(),
    }


def payee_assignments(db: Session, payee_id: int, offset: int = 0) -> dict:
    result = _payee_assignment_snapshot(db, payee_id)
    result.update(rows=result["rows"][offset:offset + 100], offset=offset,
                  next_offset=offset + 100 if offset + 100 < result["total_count"] else None)
    return result


def assign_payee(db: Session, source_id: int, payload) -> None:
    destination = payees.require_assignable(db, payload.destination_payee_id).id
    if destination == source_id:
        raise AppError("payee_assignment_invalid", "Choose a different payee.", 422)
    snapshot = _payee_assignment_snapshot(db, source_id)
    identifiers = set(payload.schedule_ids)
    if snapshot["preview_token"] != payload.preview_token or not identifiers <= {row["id"] for row in snapshot["rows"]}:
        raise AppError("payee_assignment_stale", "Schedules changed. Review the selection again.", 409)
    for identifier in identifiers:
        db.get(ScheduledTransaction, identifier).payee_id = destination
    db.flush()


def list_schedules(db: Session, account_id: int | None = None, group_name: str | None = None) -> dict:
    context = ledger_projection.projection_lookups(db)
    account_ids = ledger_projection.scope_account_ids(context, account_id, group_name)
    today = context.now.date()
    statement = select(ScheduledTransaction).join(Account, ScheduledTransaction.account_id == Account.id).order_by(ScheduledTransaction.next_date, ScheduledTransaction.id)
    if account_id is None:
        statement = statement.where(Account.closed.is_(False))
    if account_ids is not None:
        statement = statement.where(ScheduledTransaction.account_id.in_(account_ids))
    schedules = list(db.scalars(statement))
    rows = [projection(db, schedule) for schedule in schedules]
    enterable_ids = {row["id"] for row in rows if "enter_now" in row["allowed_actions"]}
    candidates = []
    for account in context.accounts.values():
        try:
            _require_source(db, account.id, context=context)
        except AppError:
            continue
        candidates.append(account.id)
    move_account_ids = {}
    for schedule in schedules:
        destination = target(db, schedule)
        identifiers = [identifier for identifier in candidates if identifier != schedule.account_id and (destination is None or identifier != destination.id)]
        if identifiers:
            definition = {key: getattr(schedule, key) for key in ScheduleDefinition.model_fields}
            definition["account_id"] = identifiers[0]
            try:
                _validate(db, ScheduleDefinition(**definition), schedule, context=context)
            except AppError:
                identifiers = []
        move_account_ids[schedule.id] = identifiers
    duplicate_candidates = []
    for schedule in db.scalars(select(ScheduledTransaction).where(ScheduledTransaction.transfer_account_id.is_not(None))):
        destination = target(db, schedule)
        owner = db.get(Account, schedule.account_id)
        duplicate_candidates.append({"id": schedule.id, "account_id": owner.id, "account_name": owner.name, "target_account_id": destination.id, "amount_cents": schedule.amount_cents})
        if pause_reason(db, schedule) or (account_ids is not None and destination.id not in account_ids):
            continue
        rows.append(mirror_projection(db, schedule, destination))
        if account_id is not None and can_enter(db, schedule):
            enterable_ids.add(schedule.id)
    through = today + timedelta(days=PREVIEW_DAYS)
    occurrences = []
    for row in list(rows):
        if row["pause_reason"]:
            continue
        cutoff = min(through, row["end_date"] or through)
        occurrence = row["next_date"]
        while occurrence is not None and occurrence <= cutoff:
            if account_id is not None and row["id"] in enterable_ids:
                occurrences.append({"id": row["id"], "date": occurrence, "amount_cents": row["amount_cents"]})
            if occurrence > today and occurrence > row["next_date"]:
                rows.append({**row, "next_date": occurrence, "ghost": True, "edit_token": "", "allowed_actions": []})
            if occurrence == cutoff:
                break
            occurrence = next_occurrence(occurrence, row["frequency"], row["anchor_day"])
    balances = ledger_projection.scheduled_balance_projection(db, account_id, occurrences, context=context) if account_id is not None else None
    for row in rows:
        row["projected_balance_cents"] = balances.get((row["id"], row["next_date"])) if balances is not None else None
    rows.sort(key=lambda row: (row["pause_reason"] is not None, *ledger_projection.chronology_key(row["next_date"], row["amount_cents"], row["id"]), row["mirror"] is not None))
    return {"today": today, "projected_balance_available": balances is not None, "rows": rows, "move_account_ids": move_account_ids, "duplicate_transfer_candidates": duplicate_candidates}


def affected(db: Session, account_id: int) -> list[ScheduledTransaction]:
    return list(db.scalars(select(ScheduledTransaction).where((ScheduledTransaction.account_id == account_id) | (ScheduledTransaction.transfer_account_id == account_id)).order_by(ScheduledTransaction.id)))


def affected_summary(db: Session, schedules: list[ScheduledTransaction]) -> list[dict]:
    return [{key: row[key] for key in ("id", "account_name", "payee_name", "next_date", "memo")} for row in (projection(db, schedule) for schedule in schedules)]


def _require_source(db: Session, account_id: int, previous: ScheduledTransaction | None = None, *, context=None) -> Account:
    source = context.accounts.get(account_id) if context is not None else db.get(Account, account_id)
    if source is None:
        raise AppError("account_not_found", "Choose an existing account.", 422)
    ledger_projection.require_account_initialized(db, source.id, context=context)
    if source.closed and (previous is None or previous.account_id != source.id):
        raise AppError("schedule_account_closed", "Choose an open account for a new schedule.", 422)
    return source


def _validate(db: Session, payload: ScheduleDefinition, previous: ScheduledTransaction | None = None, *, context=None) -> dict:
    values = payload.model_dump(exclude={"edit_token"})
    source = _require_source(db, payload.account_id, previous, context=context)
    changed_date = previous is None or previous.next_date != payload.next_date
    if changed_date and payload.next_date <= date.today():
        raise AppError("schedule_date_invalid", "The next date must be tomorrow or later.", 422)
    if payload.end_date is not None and payload.end_date < payload.next_date:
        raise AppError("schedule_end_invalid", "The end date must be on or after the next date.", 422)
    anchor = payload.anchor_day if previous is None and payload.anchor_day is not None else payload.next_date.day if changed_date else previous.anchor_day
    if previous and previous.frequency not in MONTH_INTERVALS and payload.frequency in MONTH_INTERVALS:
        anchor = payload.next_date.day
    if payload.frequency in MONTH_INTERVALS and payload.next_date.day != min(anchor, calendar.monthrange(payload.next_date.year, payload.next_date.month)[1]):
        raise AppError("schedule_anchor_invalid", "The next date does not match the recurrence day.", 422)
    values["anchor_day"] = anchor
    ledger.validate_metadata_values(db, values)
    if payload.category_id is not None and (previous is None or previous.category_id != payload.category_id):
        categories.require_assignable(db, payload.category_id)
    destination = payee_identity.target(db, payload.transfer_account_id)
    old_target = target(db, previous) if previous else None
    if payload.match_tolerance_cents and payload.amount_cents == 0:
        raise AppError("schedule_tolerance_invalid", "+/- Match requires a nonzero amount.", 422)
    if destination is not None and payload.amount_cents == 0:
        raise AppError("schedule_transfer_invalid", "Transfers require a nonzero amount.", 422)
    if destination:
        ledger_projection.require_account_initialized(db, destination.id, context=context)
        if destination.id == source.id:
            raise AppError("schedule_transfer_invalid", "Choose another transfer account.", 422)
        if destination.closed and (old_target is None or old_target.id != destination.id):
            raise AppError("schedule_target_closed", "Choose an open transfer account.", 422)
    return values


def create(db: Session, payload: ScheduleDefinition) -> dict:
    schedule = ScheduledTransaction(**_validate(db, payload))
    db.add(schedule)
    db.flush()
    return projection(db, schedule)


def require_current(db: Session, identifier: int, edit_token: str) -> ScheduledTransaction:
    schedule = db.get(ScheduledTransaction, identifier)
    if schedule is None or token(db, schedule) != edit_token:
        raise AppError("schedule_stale", "This schedule changed. Refresh and compare before trying again.", 409)
    return schedule


def _advance(db: Session, schedule: ScheduledTransaction) -> bool:
    next_date = next_occurrence(schedule.next_date, schedule.frequency, schedule.anchor_day)
    if next_date is None or (schedule.end_date is not None and next_date > schedule.end_date):
        db.delete(schedule)
        return False
    schedule.next_date = next_date
    return True


def skip_missed(db: Session, schedule: ScheduledTransaction) -> None:
    while schedule.next_date <= date.today():
        if not _advance(db, schedule):
            break


def resume_account(db: Session, account_id: int) -> None:
    for schedule in affected(db, account_id):
        if pause_reason(db, schedule) is None:
            skip_missed(db, schedule)
    db.flush()


def update(db: Session, identifier: int, payload) -> dict | None:
    schedule = require_current(db, identifier, payload.edit_token)
    return _update_values(db, schedule, _validate(db, payload, schedule))


def _update_values(db: Session, schedule: ScheduledTransaction, values: dict) -> dict | None:
    identifier = schedule.id
    paused = pause_reason(db, schedule) is not None
    for key, value in values.items():
        setattr(schedule, key, value)
    if paused and pause_reason(db, schedule) is None:
        skip_missed(db, schedule)
    db.flush()
    return None if schedule in db.deleted or db.get(ScheduledTransaction, identifier) is None else projection(db, schedule)


def delete(db: Session, identifier: int, edit_token: str) -> None:
    db.delete(require_current(db, identifier, edit_token))
    db.flush()


def skip(db: Session, identifier: int, edit_token: str) -> dict | None:
    schedule = require_current(db, identifier, edit_token)
    if pause_reason(db, schedule):
        raise AppError("schedule_paused", "Reopen the accounts before skipping this schedule.", 409)
    survives = _advance(db, schedule)
    db.flush()
    return projection(db, schedule) if survives else None


def _enter(db: Session, schedule: ScheduledTransaction, *, approved: bool) -> list:
    ledger_projection.require_account_initialized(db, schedule.account_id)
    if pause_reason(db, schedule):
        raise AppError("schedule_paused", "Reopen the accounts before entering this schedule.", 409)
    destination = target(db, schedule)
    payee = db.get(Payee, schedule.payee_id)
    payees.require_assignable(db, schedule.payee_id)
    description = payee.name
    payload = TransactionCreate(account_id=schedule.account_id, date=schedule.next_date, payee_id=schedule.payee_id, transfer_account_id=schedule.transfer_account_id, memo=schedule.memo, amount_cents=schedule.amount_cents, categorization=SingleCategorization(kind="single", category_id=schedule.category_id))
    if destination:
        rows = list(transfers.enter_scheduled(db, payload, description=description, source_approved=approved))
    else:
        rows = [ledger.create_manual_transaction(db, payload, approved=approved, description=description)]
    rows[0].match_tolerance_cents = schedule.match_tolerance_cents
    _advance(db, schedule)
    db.flush()
    return rows


def enter_now(db: Session, identifier: int, edit_token: str) -> dict:
    schedule = require_current(db, identifier, edit_token)
    rows = _enter(db, schedule, approved=True)
    matching.reconcile(db, {row.account_id for row in rows}, allow_automatic=True, expire_stale=True, transaction_ids={row.id for row in rows})
    db.flush()
    return {"rows": [ledger_projection.row(db, ledger_projection.resolve_relationship(db, row).parent) for row in rows]}


def batch(db: Session, payload: ScheduleBatch) -> dict:
    selected = [require_current(db, item.id, item.edit_token) for item in payload.targets]
    permission = payload.action if payload.action in ("enter_now", "skip") else "edit"
    for schedule in selected:
        if permission not in projection(db, schedule)["allowed_actions"]:
            raise AppError("schedule_batch_unavailable", "Every selected schedule must allow this action. Remove paused or unavailable schedules and try again.", 409)
    values = []
    if payload.action in ("update", "send_to"):
        changes = payload.changes.model_dump(exclude_unset=True) if payload.changes else {"account_id": payload.destination_account_id}
        for schedule in selected:
            if payload.action == "send_to" and schedule.account_id == payload.destination_account_id:
                raise AppError("schedule_move_same_account", "Choose an account outside the selected source accounts.", 422)
            definition = {key: getattr(schedule, key) for key in ScheduleDefinition.model_fields}
            try:
                values.append(_validate(db, ScheduleDefinition(**(definition | changes)), schedule))
            except AppError as error:
                owner = db.get(Account, schedule.account_id)
                raise AppError(error.code, f"{owner.name} · {schedule.next_date}: {error.message}", error.status, error.detail) from error
        memo = changes.get("memo")
        if memo and not payload.memo_overwrite_confirmed and any(schedule.memo and schedule.memo != memo for schedule in selected):
            raise AppError("schedule_memo_confirmation_required", "Confirm replacement of existing schedule memos before saving.", 409)
    rows = []
    for index, schedule in enumerate(selected):
        if payload.action == "enter_now":
            rows.extend(_enter(db, schedule, approved=True))
        elif payload.action == "skip":
            _advance(db, schedule)
        else:
            _update_values(db, schedule, values[index])
    db.flush()
    if rows:
        matching.reconcile(db, {row.account_id for row in rows}, allow_automatic=True, expire_stale=True, transaction_ids={row.id for row in rows})
        db.flush()
    return {"status": "ok"}


def recurring_draft(db: Session, identifier: int) -> dict:
    transaction = ledger_projection.require_transaction(db, identifier)
    row = ledger_projection.row(db, transaction)
    if "make_recurring" not in row["allowed_actions"]:
        raise AppError("schedule_source_unavailable", "This row cannot become a schedule.", 422)
    current = row["date"]
    anchor = current.day
    next_date = next_occurrence(current, "monthly", anchor)
    while next_date <= date.today():
        next_date = next_occurrence(next_date, "monthly", anchor)
    return {"account_id": transaction.account_id, "next_date": next_date, "frequency": "monthly", "anchor_day": anchor, "payee_id": row["payee_id"], "transfer_account_id": row["transfer_account_id"], "category_id": row["category_id"], "memo": row["memo"], "amount_cents": row["amount_cents"], "match_tolerance_cents": 0, "end_date": None}


def enter_due(db: Session) -> tuple[int, list[dict]]:
    count, failed_dates, account_ids, transaction_ids = 0, {}, set(), set()
    identifiers = list(db.scalars(select(ScheduledTransaction.id).where(ScheduledTransaction.next_date <= date.today()).order_by(ScheduledTransaction.next_date, ScheduledTransaction.id)))
    for identifier in identifiers:
        schedule = db.get(ScheduledTransaction, identifier)
        if pause_reason(db, schedule):
            continue
        source_id = schedule.account_id
        entered = []
        try:
            with db.begin_nested():
                while schedule.next_date <= date.today():
                    entered.extend(_enter(db, schedule, approved=False))
                    if db.get(ScheduledTransaction, identifier) is None:
                        break
        except Exception as error:
            diagnostics.emit("schedule.entry_failed", "error", error=error, code=error.code if isinstance(error, AppError) else "schedule_entry_failed")
            failed_dates.setdefault(source_id, set()).add(schedule.next_date)
        else:
            count += len(entered)
            account_ids.update(row.account_id for row in entered)
            transaction_ids.update(row.id for row in entered)
    if account_ids:
        matching.reconcile(db, account_ids, allow_automatic=True, expire_stale=True, transaction_ids=transaction_ids)
        db.flush()
    issues = [{"kind": "schedule_entry", "message": f"Scheduled entries in {db.get(Account, identifier).name} could not be entered (next dates: {', '.join(str(day) for day in sorted(days))}). Review their definitions and account setup, then retry a refresh.", "account_ids": [identifier], "missing_account_ids": []} for identifier, days in failed_dates.items()]
    return count, issues

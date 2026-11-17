import csv
import io
import re
import zipfile

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Account, Category, Payee, ScheduledTransaction
from app.services import ledger_projection, scheduled_transactions

COLUMNS = (
    "Transaction ID",
    "Account",
    "Date",
    "Payee",
    "Description",
    "Bank description",
    "Category",
    "Subcategory",
    "Memo",
    "Category memo",
    "Amount",
    "Outflow",
    "Inflow",
    "Balance",
    "Status",
    "Manual clearance",
    "Reviewed",
    "Source",
    "Flag",
    "Transfer account",
    "Transfer state",
    "Missing pending",
)


def _text(value: object | None) -> str:
    result = "" if value is None else str(value)
    if result.lstrip().startswith(("=", "+", "-", "@")):
        return f"'{result}"
    return result


def _amount(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    value = abs(cents)
    return f"{sign}{value // 100}.{value % 100:02d}"


def _amount_columns(cents: int) -> list[str]:
    return [_amount(cents), _amount(-cents) if cents < 0 else "", _amount(cents) if cents >= 0 else ""]


def _account_identity(accounts: list[Account]) -> str:
    if len(accounts) > 1:
        return "multiple-accounts"
    return re.sub(r"[^A-Za-z0-9._-]+", "-", accounts[0].name.strip()).strip("-.") or f"account-{accounts[0].id}"


def _category(category_name: str | None, *, unassigned: bool = False) -> str:
    if unassigned:
        return "Unassigned split"
    return category_name or "No category"


def _source(value: str) -> str:
    return "Starting balance" if value == "starting_balance" else value.title()


def _record(account_name: str, row: dict, *, category: str, subcategory: str, category_memo: str, amount_cents: int) -> list[str]:
    transfer = row["transfer"]
    return [
        str(row["id"]),
        _text(account_name),
        row["date"].isoformat(),
        _text(row["payee_name"]),
        _text(row["description"]),
        _text(row["rule_description"]) if row["source"] == "plaid" else "",
        _text(category),
        _text(subcategory),
        _text(row["memo"]),
        _text(category_memo),
        *_amount_columns(amount_cents),
        _amount(row["running_balance_cents"]) if row["running_balance_cents"] is not None else "",
        row["status"].title(),
        "Yes" if row["manually_cleared"] else "No",
        "Yes" if row["approved"] else "No",
        _source(row["source"]),
        row["flag"] or "",
        _text(transfer["account_name"]) if transfer else "",
        transfer["state"].title() if transfer else "",
        "Yes" if row["missing_pending"] else "No",
    ]


def csv_export(
    db: Session,
    account_ids: list[int],
    *,
    date_from=None,
    date_to=None,
    include_pending: bool,
    split_mode: str,
) -> tuple[str, str]:
    accounts = db.scalars(
        select(Account)
        .where(Account.id.in_(account_ids))
        .order_by(Account.sort_order, Account.id)
    ).all()
    if len(accounts) != len(account_ids):
        raise AppError("account_not_found", "Account not found", 422)
    account_by_id = {account.id: account for account in accounts}
    context = ledger_projection.projection_lookups(db)
    projection = ledger_projection.parent_projection(db, set(account_ids), lookups=context)
    rows = [item[2] for item in projection.values()]
    by_account = {identifier: [] for identifier in account_ids}
    for row in rows:
        row["running_balance_cents"] = None
        by_account[row["account_id"]].append(row)
    for identifier, account_rows in by_account.items():
        if not ledger_projection.account_requires_initialization(db, identifier, context=context):
            balances = {row["id"]: row["running_balance_cents"] for row in ledger_projection.running_balance_projection(account_rows)}
            for row in account_rows:
                row["running_balance_cents"] = balances[row["id"]]
    rows.sort(
        key=lambda row: (
            account_by_id[row["account_id"]].sort_order,
            account_by_id[row["account_id"]].id,
            *ledger_projection.chronology_key(row["date"], row["amount_cents"], row["id"], row["source"]),
        )
    )

    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(COLUMNS)
    for row in rows:
        if not include_pending and row["status"] == "pending":
            continue
        if date_from is not None and row["date"] < date_from:
            continue
        if date_to is not None and row["date"] > date_to:
            continue
        account_name = account_by_id[row["account_id"]].name
        allocations = row["allocations"]
        if split_mode == "category" and allocations:
            for allocation in allocations:
                writer.writerow(
                    _record(
                        account_name,
                        row,
                        category=_category(
                            allocation["category_name"],
                            unassigned=allocation["unassigned"],
                        ),
                        subcategory=allocation["subcategory_name"] or "",
                        category_memo=allocation["memo"],
                        amount_cents=allocation["amount_cents"],
                    )
                )
            continue
        writer.writerow(
            _record(
                account_name,
                row,
                category="Split" if allocations else _category(row["category_name"]),
                subcategory="" if allocations else row["subcategory_name"] or "",
                category_memo="",
                amount_cents=row["amount_cents"],
            )
        )
    identity = _account_identity(accounts)
    bounds = "all-dates" if date_from is None else f"{date_from.isoformat()}-to-{date_to.isoformat()}"
    return output.getvalue(), f"weft-{identity}-{bounds}.csv"


SCHEDULE_COLUMNS = (
    "Schedule ID", "Account", "Frequency", "Next date", "End date", "Anchor day",
    "Payee", "Category", "Subcategory", "Memo", "Amount", "Outflow", "Inflow",
    "+/- Match", "Transfer account", "Paused", "Pause reason",
)


def scheduled_csv_export(db: Session, account_ids: list[int]) -> tuple[str, str]:
    all_accounts = {account.id: account for account in db.scalars(select(Account)).all()}
    if any(identifier not in all_accounts for identifier in account_ids):
        raise AppError("account_not_found", "Account not found", 422)
    accounts = sorted((all_accounts[identifier] for identifier in account_ids), key=lambda account: (account.sort_order, account.id))
    definitions = list(db.scalars(select(ScheduledTransaction).where(ScheduledTransaction.account_id.in_(account_ids))))
    reasons = {schedule.id: scheduled_transactions.pause_reason(db, schedule) for schedule in definitions}
    definitions.sort(key=lambda schedule: (
        all_accounts[schedule.account_id].sort_order, schedule.account_id,
        reasons[schedule.id] is not None,
        *ledger_projection.chronology_key(schedule.next_date, schedule.amount_cents, schedule.id),
    ))
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(SCHEDULE_COLUMNS)
    for schedule in definitions:
        category = db.get(Category, schedule.category_id) if schedule.category_id else None
        parent = db.get(Category, category.parent_id) if category and category.parent_id else None
        payee = db.get(Payee, schedule.payee_id)
        destination = all_accounts.get(schedule.transfer_account_id)
        writer.writerow([
            schedule.id, _text(all_accounts[schedule.account_id].name), schedule.frequency,
            schedule.next_date.isoformat(), schedule.end_date.isoformat() if schedule.end_date else "", schedule.anchor_day,
            _text(payee.name if payee else None), _text(_category(parent.name if parent else category.name if category else None)),
            _text(category.name if parent else ""), _text(schedule.memo), *_amount_columns(schedule.amount_cents),
            _amount(schedule.match_tolerance_cents), _text(destination.name if destination else None),
            "Yes" if reasons[schedule.id] else "No", _text(reasons[schedule.id]),
        ])
    return output.getvalue(), f"weft-schedules-{_account_identity(accounts)}.csv"


def download_export(
    db: Session,
    account_ids: list[int],
    *,
    include_history: bool,
    include_schedules: bool,
    date_from=None,
    date_to=None,
    include_pending: bool,
    split_mode: str,
) -> tuple[bytes, str, str]:
    files = []
    if include_history:
        files.append(csv_export(db, account_ids, date_from=date_from, date_to=date_to, include_pending=include_pending, split_mode=split_mode))
    if include_schedules:
        files.append(scheduled_csv_export(db, account_ids))
    encoded = [(filename, ("\ufeff" + content).encode("utf-8")) for content, filename in files]
    if len(encoded) == 1:
        filename, content = encoded[0]
        return content, filename, "text/csv"
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for filename, content in encoded:
            archive.writestr(filename, content)
    return output.getvalue(), encoded[0][0].removesuffix(".csv") + ".zip", "application/zip"

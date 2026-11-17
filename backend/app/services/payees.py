from operator import eq, ge, gt, le, lt
from datetime import datetime
import hashlib
import json
import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.diagnostics import diagnostics
from app.models import (
    Account,
    Category,
    Payee,
    PayeeRule,
    ScheduledTransaction,
    Transaction,
)
from app.services import categories, rule_regex, payee_identity, ledger_projection


def name_key(value: str) -> str:
    result = value.strip()
    if not result:
        raise AppError("payee_name_invalid", "Payee name cannot be blank", 422)
    return result.casefold()


def normalized_text(value: str | None) -> str:
    return value.strip().casefold() if isinstance(value, str) else ""


def compile_regex(value: str) -> re.Pattern[str]:
    try:
        return re.compile(value, re.IGNORECASE)
    except re.error as error:
        raise AppError("payee_rule_invalid", f"Invalid regex: {error}", 422) from error


def _text_condition(operator: str, raw: str) -> tuple[str, str]:
    value = raw.strip()
    if not value:
        raise AppError("payee_rule_invalid", "Rule text cannot be blank", 422)
    if len(value) > 512:
        raise AppError(
            "payee_rule_invalid", "Rule text cannot exceed 512 characters", 422
        )
    if operator == "regex":
        compile_regex(value)
        return value, value
    return value, value.casefold()


def active_category(db: Session, category_id: int | None) -> Category | None:
    if category_id is None:
        return None
    category = db.get(Category, category_id)
    if (
        category is None
        or category.parent_id is None
        or category.archived
    ):
        return None
    parent = db.get(Category, category.parent_id)
    return (
        category
        if parent and not parent.archived
        else None
    )


def default_category(db: Session, payee_id: int) -> Category | None:
    payee = db.get(Payee, payee_id)
    return active_category(db, payee.default_category_id) if payee and payee.kind == "ordinary" else None


def rule_data(rule: PayeeRule, position: int | None = None) -> dict:
    return {
        "id": rule.id,
        "payee_id": rule.payee_id,
        "category_id": rule.category_id,
        "account_id": rule.account_id,
        "amount": rule.amount,
        "text_conditions": rule.text_conditions,
        "position": position if position is not None else rule.position,
    }


def stored_rules(db: Session) -> list[PayeeRule]:
    return list(db.scalars(select(PayeeRule).order_by(PayeeRule.position)).all())


def rules_token(rules: list[PayeeRule]) -> str:
    value = [rule_data(rule) for rule in rules]
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def check_rules(db: Session, expected: str) -> list[PayeeRule]:
    rules = stored_rules(db)
    if rules_token(rules) != expected:
        raise AppError(
            "payee_rules_stale",
            "The global rules changed. Refresh and compare before saving.",
            409,
        )
    return rules


def normalize_rule(db: Session, draft) -> tuple[dict, str]:
    existing = db.get(PayeeRule, draft.id) if draft.id is not None else None
    if draft.id is not None and existing is None:
        raise AppError("payee_rule_not_found", "The rule no longer exists.", 409)
    require_assignable(db, draft.payee_id)
    if draft.account_id is not None and db.get(Account, draft.account_id) is None:
        raise AppError("account_not_found", "The rule account no longer exists.", 422)
    if draft.category_id is not None and (
        existing is None or existing.category_id != draft.category_id
    ):
        require_default_category(db, draft.category_id)
    text_conditions, keys = [], []
    for condition in draft.text_conditions:
        value, normalized = _text_condition(condition.operator, condition.value)
        item = {
            "field": condition.field,
            "operator": condition.operator,
            "value": value,
        }
        text_conditions.append(item)
        keys.append((condition.field, condition.operator, normalized))
    amount = draft.amount.model_dump() if draft.amount else None
    key = json.dumps(
        [draft.account_id, amount, sorted(set(keys))],
        sort_keys=True,
        ensure_ascii=False,
    )
    return {
        "id": draft.id,
        "payee_id": draft.payee_id,
        "category_id": draft.category_id,
        "account_id": draft.account_id,
        "amount": amount,
        "text_conditions": text_conditions,
    }, key


AMOUNT_COMPARATORS = {"eq": eq, "gt": gt, "gte": ge, "lt": lt, "lte": le}


class RuleEvaluationError(AppError):
    def __init__(self, item: dict | None = None, *, position: int | None = None, unavailable=False):
        identifier = item.get("id") if item else None
        name = f"Rule {position}" if position is not None else "This rule"
        if unavailable:
            message = "Payee rules could not be evaluated. Retry or review the rules in Payees."
        elif item is None:
            message = "Payee rules exceeded the combined regex evaluation limit. Simplify the rules in Payees and retry."
        else:
            message = f"{name} exceeded the regex evaluation limit. Simplify the rule in Payees and retry."
        super().__init__("payee_rule_evaluation_failed", message, 422, {"rule_id": identifier})
        diagnostics.emit("payee.rule_evaluation_failed", "warning", code=self.code)


class RuleEvaluator:
    def __init__(self, db: Session, items: list[dict]):
        self.db = db
        self.items = items
        self.display_positions = {
            item["id"]: position
            for position, item in enumerate((item for item in items if item["id"] is not None), 1)
        }
        self.names = {payee.id: payee.name for payee in db.scalars(select(Payee)).all()}
        self.regex_budget = rule_regex.EvaluationBudget()

    def matches(
        self,
        item: dict,
        account_id: int,
        amount_cents: int,
        description: str | None,
        merchant_name: str | None,
    ) -> bool:
        if item["account_id"] is not None and item["account_id"] != account_id:
            return False
        amount = item["amount"]
        if amount:
            if (
                amount["direction"] == "inflow"
                and amount_cents <= 0
                or amount["direction"] == "outflow"
                and amount_cents >= 0
            ):
                return False
            magnitude, value, upper = (
                abs(amount_cents),
                amount["value_cents"],
                amount["upper_cents"],
            )
            operator = amount["operator"]
            if operator == "between":
                if not value <= magnitude <= upper:
                    return False
            elif operator != "any" and not AMOUNT_COMPARATORS[operator](
                magnitude, value
            ):
                return False
        for condition in item["text_conditions"]:
            text = normalized_text(
                description if condition["field"] == "description" else merchant_name
            )
            if not text:
                return False
            value, operator = normalized_text(condition["value"]), condition["operator"]
            if operator == "regex":
                try:
                    matched = self.regex_budget.search(condition["value"], text)
                except rule_regex.EvaluationLimit as error:
                    raise RuleEvaluationError(item, position=self.display_positions.get(item["id"])) from error
                except rule_regex.BudgetExhausted as error:
                    raise RuleEvaluationError() from error
                except rule_regex.EvaluatorUnavailable as error:
                    raise RuleEvaluationError(unavailable=True) from error
            elif operator == "is":
                matched = text == value
            elif operator == "contains":
                matched = value in text
            elif operator == "not_contains":
                matched = value not in text
            elif operator == "starts_with":
                matched = text.startswith(value)
            else:
                matched = text.endswith(value)
            if not matched:
                return False
        return True

    def resolve(
        self,
        account_id: int,
        amount_cents: int,
        description: str | None,
        merchant_name: str | None,
    ) -> dict:
        for item in self.items:
            if self.matches(item, account_id, amount_cents, description, merchant_name):
                return self.result_for_item(item)
        return {"rule_id": None, "payee_id": None, "category_id": None}

    def result_for_item(self, item: dict) -> dict:
        category = active_category(self.db, item["category_id"])
        return {"rule_id": item["id"], "payee_id": item["payee_id"], "category_id": category.id if category else None}


def load_evaluator(db: Session, items: list[dict] | None = None) -> RuleEvaluator:
    return RuleEvaluator(
        db,
        items if items is not None else [rule_data(rule) for rule in stored_rules(db)],
    )


def preview_evaluator(db: Session, draft, expected: str) -> tuple[RuleEvaluator, dict]:
    rules = check_rules(db, expected)
    selected, _key = normalize_rule(db, draft)
    items = [rule_data(rule) for rule in rules]
    if draft.id is None:
        items.insert(0, selected)
    else:
        items = [selected if item["id"] == draft.id else item for item in items]
    return load_evaluator(db, items), selected


def save_rule(db: Session, draft, expected: str) -> PayeeRule:
    rules = check_rules(db, expected)
    values, key = normalize_rule(db, draft)
    duplicate = next(
        (rule for rule in rules if rule.id != draft.id and rule.conditions_key == key),
        None,
    )
    if duplicate:
        raise AppError(
            "payee_rule_duplicate",
            "These conditions duplicate an existing rule.",
            422,
            {
                "rule_id": duplicate.id,
                "position": rules.index(duplicate) + 1,
                "payee_name": db.get(Payee, duplicate.payee_id).name,
            },
        )
    rule = db.get(PayeeRule, draft.id) if draft.id is not None else None
    values.pop("id")
    if rule is None:
        rule = PayeeRule(
            **values,
            conditions_key=key,
            position=min((item.position for item in rules), default=1) - 1,
        )
        db.add(rule)
    else:
        for name, value in values.items():
            setattr(rule, name, value)
        rule.conditions_key = key
    db.flush()
    return rule


def move_rule(db: Session, identifier: int, direction: str, expected: str) -> None:
    rules = check_rules(db, expected)
    index = next(
        (index for index, rule in enumerate(rules) if rule.id == identifier), None
    )
    if index is None:
        raise AppError("payee_rule_not_found", "The rule no longer exists.", 409)
    neighbor = index + (-1 if direction == "up" else 1)
    if not 0 <= neighbor < len(rules):
        return
    rule, other = rules[index], rules[neighbor]
    old = rule.position
    rule.position = min(item.position for item in rules) - 1
    db.flush()
    other_position = other.position
    other.position = old
    db.flush()
    rule.position = other_position
    db.flush()


def delete_rule(db: Session, identifier: int, expected: str) -> None:
    rules = check_rules(db, expected)
    rule = next((item for item in rules if item.id == identifier), None)
    if rule is None:
        raise AppError("payee_rule_not_found", "The rule no longer exists.", 409)
    db.delete(rule)
    db.flush()


def create(db: Session, name: str, *, reuse: bool = False) -> Payee:
    display, key = name.strip(), name_key(name)
    existing = db.scalar(select(Payee).where(Payee.name_key == key))
    if existing:
        if reuse and existing.kind == "ordinary":
            return existing
        if reuse:
            raise AppError("payee_import_reserved", "This bank Payee matches a protected system name. Add a Payee rule for its account or amount, then retry this connection.", 422)
        raise AppError(
            "payee_name_conflict",
            "A payee with that name already exists",
            409,
            {"payee": out(db, existing)},
        )
    payee = Payee(name=display, name_key=key)
    db.add(payee)
    db.flush()
    return payee


def rename(db: Session, payee_id: int, name: str) -> Payee:
    payee = db.get(Payee, payee_id)
    if not payee or payee.kind != "ordinary":
        raise AppError("payee_not_found", "Payee not found", 404)
    display, key = name.strip(), name_key(name)
    existing = db.scalar(
        select(Payee).where(Payee.name_key == key, Payee.id != payee.id)
    )
    if existing:
        raise AppError(
            "payee_name_conflict",
            "A payee with that name already exists",
            409,
            {"payee": out(db, existing)},
        )
    payee.name, payee.name_key = display, key
    return payee


def reference_previews(db: Session, payees: list[Payee], *, now: datetime | None = None) -> list[dict]:
    facts = ledger_projection.payee_reference_facts(db, {payee.id for payee in payees}, now=now)
    owned = {}
    for index, rule in enumerate(stored_rules(db)):
        if rule.payee_id in facts:
            owned.setdefault(rule.payee_id, []).append({
                **rule_data(rule, index + 1), "matching_count": None, "deciding_count": None,
            })
    previews = []
    for payee in payees:
        value = facts[payee.id]
        preview = {
            "payee": out(db, payee, schedule_count=value["schedule_count"]),
            **{key: value[key] for key in (
                "transaction_count", "schedule_count", "displayed_transaction_count",
                "following_transaction_count", "unknown_transaction_count",
            )},
            "rules": owned.get(payee.id, []),
        }
        preview["preview_token"] = hashlib.sha256(json.dumps(
            ["payee-references", preview, value, payee.category_streak_ids], sort_keys=True, default=str,
        ).encode()).hexdigest()
        preview["groups"] = value["groups"]
        previews.append(preview)
    return previews


def unused_deletion_plan(db: Session) -> list[dict]:
    now = datetime.now()
    displayed = ledger_projection.payee_assignment_counts(db, now=now)
    scheduled = set(db.scalars(select(ScheduledTransaction.payee_id)).all())
    candidates = [payee for payee in db.scalars(
        select(Payee).where(Payee.kind == "ordinary").order_by(Payee.name_key, Payee.id)
    ).all() if not displayed.get(payee.id, 0) and payee.id not in scheduled]
    return reference_previews(db, candidates, now=now)


def unused_deletion_preview(plan: list[dict]) -> dict:
    return {
        "payees": [{
            "id": entry["payee"]["id"], "name": entry["payee"]["name"], "rules": entry["rules"],
            "following_transaction_count": entry["following_transaction_count"],
            "unknown_transaction_count": entry["unknown_transaction_count"],
        } for entry in plan],
        "preview_token": hashlib.sha256(json.dumps(
            ["unused-payees", [entry["preview_token"] for entry in plan]],
        ).encode()).hexdigest(),
    }


def references(db: Session, payee_id: int, offset: int = 0) -> dict:
    payee = db.get(Payee, payee_id)
    if payee is None:
        raise AppError("payee_not_found", "Payee not found", 404)
    result = reference_previews(db, [payee])[0]
    groups = result["groups"]
    result.update(groups=groups[offset:offset + 100], total_groups=len(groups), offset=offset,
                  next_offset=offset + 100 if offset + 100 < len(groups) else None)
    return result


def fallback_name(raw: dict) -> str | None:
    value = next(
        (
            value
            for value in (raw.get("merchant_name"), raw.get("name"))
            if isinstance(value, str) and value.strip()
        ),
        None,
    )
    return value.strip()[:35] if value is not None else None


def import_assignment(
    db: Session, raw: dict, transaction: Transaction, evaluator: RuleEvaluator
) -> tuple[int, int | None]:
    result = evaluator.resolve(
        transaction.account_id,
        transaction.amount_cents,
        transaction.description,
        raw.get("merchant_name"),
    )
    payee_id = result["payee_id"]
    if payee_id is None:
        fallback = fallback_name(raw)
        if fallback is None:
            raise AppError("payee_import_missing", "This bank transaction has no usable Payee. Add a Payee rule for its account or amount, then retry this connection.", 422)
        payee = create(db, fallback, reuse=True)
        evaluator.names[payee.id] = payee.name
        payee_id = payee.id
    category_id = result["category_id"]
    if category_id is None:
        category = default_category(db, payee_id)
        category_id = category.id if category else None
    return payee_id, category_id


def require_default_category(db: Session, category_id: int) -> Category:
    category = categories.require_assignable(db, category_id)
    parent = db.get(Category, category.parent_id)
    if parent is None:
        raise AppError(
            "payee_default_category_invalid",
            "Choose an active ordinary subcategory as the payee default.",
            422,
        )
    return category


def set_default_category(
    payee: Payee,
    category_id: int | None,
) -> Payee:
    if payee.kind != "ordinary":
        raise AppError("payee_protected", "Protected Payees cannot have defaults.", 422)
    payee.default_category_id = category_id
    payee.default_category_prompt_dismissed = True
    return payee


def validate_default_category_save(
    db: Session,
    payee: Payee,
    category_id: int | None,
    expected_category_id: int | None,
) -> None:
    if payee.kind != "ordinary":
        raise AppError("payee_protected", "Protected Payees cannot have defaults.", 422)
    if payee.default_category_id != expected_category_id:
        raise AppError(
            "payee_default_category_stale",
            "The payee default category changed. Refresh and compare before saving.",
            409,
        )
    if category_id is not None:
        require_default_category(db, category_id)


def out(db: Session, payee: Payee, *, schedule_count: int | None = None) -> dict:
    return {
        "id": payee.id, "name": payee.name, "kind": payee.kind,
        "default_category_id": payee.default_category_id,
        "remembered_category_id": payee.remembered_category_id,
        "default_category_prompt_dismissed": payee.default_category_prompt_dismissed,
        "schedule_count": schedule_count if schedule_count is not None else db.scalar(
            select(func.count()).select_from(ScheduledTransaction).where(ScheduledTransaction.payee_id == payee.id)
        ),
    }


def list_out(db: Session) -> list[dict]:
    labels = payee_identity.names(db)
    scheduled = dict(db.execute(
        select(ScheduledTransaction.payee_id, func.count()).group_by(ScheduledTransaction.payee_id)
    ).all())
    return [{**out(db, payee, schedule_count=scheduled.get(payee.id, 0)), "name": labels[payee.id]}
            for payee in db.scalars(select(Payee).order_by(Payee.name_key, Payee.id)).all()]


def require_ordinary(db: Session, identifier: int) -> Payee:
    payee = db.get(Payee, identifier)
    if payee is None or payee.kind != "ordinary":
        raise AppError("payee_not_found", "Choose an ordinary saved Payee.", 422)
    return payee


def require_assignable(db: Session, identifier: int) -> Payee:
    payee = db.get(Payee, identifier)
    if payee is None or payee.kind not in ("ordinary", "myself"):
        raise AppError("payee_not_found", "Choose a saved Payee.", 422)
    return payee


def system_payee(db: Session, kind: str) -> Payee:
    names = {"myself": "Myself", "starting_balance": "Starting Balance", "unknown": "Unknown Payee"}
    payee = db.scalar(select(Payee).where(Payee.kind == kind))
    if payee is None:
        name = names[kind]
        payee = Payee(name=name, name_key=name.casefold(), kind=kind)
        db.add(payee)
        db.flush()
    return payee


def initialize_managed_payees(db: Session) -> None:
    for kind in ("myself", "starting_balance", "unknown"):
        system_payee(db, kind)

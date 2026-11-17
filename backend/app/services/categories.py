from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Category, ScheduledTransaction, Transaction, TransactionAllocation
from app.schemas import CategoryCreate, CategoryDelete, CategoryUpdate


def _category(db: Session, category_id: int) -> Category:
    category = db.get(Category, category_id)
    if category is None:
        raise AppError("category_not_found", "Category not found", 404)
    return category


def _name(value: str | None) -> tuple[str, str]:
    if value is None or not value.strip():
        raise AppError("invalid_category_name", "Category name cannot be blank", 422)
    name = value.strip()
    return name, name.casefold()


def _assert_unique_name(
    db: Session, name_key: str, parent_id: int | None, category_id: int | None = None
) -> None:
    parent_filter = (
        Category.parent_id.is_(None)
        if parent_id is None
        else Category.parent_id == parent_id
    )
    statement = select(Category.id).where(
        Category.name_key == name_key,
        parent_filter,
    )
    if category_id is not None:
        statement = statement.where(Category.id != category_id)
    if db.scalar(statement) is not None:
        raise AppError(
            "duplicate_category_name", "A category with that name already exists", 409
        )


def _active_parent(db: Session, parent_id: int) -> Category:
    parent = db.get(Category, parent_id)
    if parent is None:
        raise AppError("category_parent_invalid", "Parent category not found", 422)
    if parent.parent_id is not None:
        raise AppError(
            "category_depth_exceeded", "Categories support only two levels", 422
        )
    if parent.archived:
        raise AppError(
            "category_parent_invalid",
            "Archived categories cannot contain subcategories",
            422,
        )
    return parent


def require_assignable(db: Session, category_id: int) -> Category:
    category = _category(db, category_id)
    parent = (
        _category(db, category.parent_id) if category.parent_id is not None else None
    )
    if category.archived or parent is None or parent.archived:
        raise AppError(
            "category_not_assignable",
            "Choose an active subcategory under an active category",
            422,
        )
    return category


def category_out(
    db: Session, category: Category, transaction_count: int, schedule_count: int = 0, rules: list[dict] | None = None
) -> dict:
    return {
        "id": category.id,
        "name": category.name,
        "parent_id": category.parent_id,
        "archived": category.archived,
        "is_discretionary": category.is_discretionary,
        "transaction_count": transaction_count,
        "schedule_count": schedule_count,
        "rules": rule_references(db, {category.id}) if rules is None else rules,
    }


def _usage_by_category(db: Session, category_ids: set[int]) -> dict[int, set[int]]:
    usage = {category_id: set() for category_id in category_ids}
    if not category_ids:
        return usage
    for category_id, transaction_id in db.execute(
        select(Transaction.category_id, Transaction.id).where(
            Transaction.category_id.in_(category_ids),
            Transaction.plaid_excluded_at.is_(None),
        )
    ):
        usage[category_id].add(transaction_id)
    for category_id, transaction_id in db.execute(
        select(
            TransactionAllocation.category_id, TransactionAllocation.transaction_id
        )
        .join(Transaction, Transaction.id == TransactionAllocation.transaction_id)
        .where(
            TransactionAllocation.category_id.in_(category_ids),
            Transaction.plaid_excluded_at.is_(None),
        )
    ):
        usage[category_id].add(transaction_id)
    return usage


def rule_references(db: Session, category_ids: set[int]) -> list[dict]:
    from app.models import Payee, PayeeRule

    all_rules = db.execute(
        select(PayeeRule, Payee.name).join(Payee).order_by(PayeeRule.position)
    ).all()
    return [
        {"id": rule.id, "position": index + 1, "payee_name": name}
        for index, (rule, name) in enumerate(all_rules)
        if rule.category_id in category_ids
    ]


def list_categories(db: Session) -> list[dict]:
    categories = list(db.scalars(select(Category)).all())
    usage = _usage_by_category(db, {category.id for category in categories})
    schedule_usage = dict(
        db.execute(
            select(ScheduledTransaction.category_id, func.count())
            .where(ScheduledTransaction.category_id.is_not(None))
            .group_by(ScheduledTransaction.category_id)
        ).all()
    )
    from app.models import Payee, PayeeRule
    rule_usage = {category.id: [] for category in categories}
    all_rules = db.execute(
        select(PayeeRule, Payee.name).join(Payee).order_by(PayeeRule.position)
    ).all()
    for index, (rule, name) in enumerate(all_rules):
        if rule.category_id is not None:
            rule_usage[rule.category_id].append({"id": rule.id, "position": index + 1, "payee_name": name})
    children: dict[int, list[Category]] = {}
    for category in categories:
        if category.parent_id is not None:
            children.setdefault(category.parent_id, []).append(category)
    rendered = {
        category.id: category_out(
            db,
            category,
            (
                len(
                    set().union(
                        *(usage[child.id] for child in children.get(category.id, []))
                    )
                )
                if category.parent_id is None
                else len(usage.get(category.id, set()))
            ),
            (
                sum(schedule_usage.get(child.id, 0) for child in children.get(category.id, []))
                if category.parent_id is None
                else schedule_usage.get(category.id, 0)
            ),
            [rule for child in children.get(category.id, []) for rule in rule_usage[child.id]] if category.parent_id is None else rule_usage[category.id],
        )
        for category in categories
    }

    def ordered(values: list[Category]) -> list[Category]:
        return sorted(
            values,
            key=lambda value: (
                rendered[value.id]["archived"],
                rendered[value.id]["name"].casefold(),
                value.id,
            ),
        )

    return [
        {
            **rendered[parent.id],
            "children": [
                rendered[child.id]
                for child in ordered(children.get(parent.id, []))
            ],
        }
        for parent in ordered(
            [category for category in categories if category.parent_id is None]
        )
    ]


def create_category(db: Session, payload: CategoryCreate) -> dict:
    name, name_key = _name(payload.name)
    if payload.parent_id is not None:
        _active_parent(db, payload.parent_id)
    elif payload.is_discretionary is not None:
        raise AppError(
            "category_classification_invalid",
            "Only subcategories have a spending classification",
            422,
        )
    _assert_unique_name(db, name_key, payload.parent_id)
    category = Category(
        name=name,
        name_key=name_key,
        parent_id=payload.parent_id,
        archived=False,
        is_discretionary=payload.is_discretionary,
    )
    db.add(category)
    db.flush()
    return category_out(db, category, 0)


def update_category(db: Session, category_id: int, payload: CategoryUpdate) -> None:
    category = _category(db, category_id)
    fields = payload.model_fields_set
    if not fields:
        raise AppError("category_update_invalid", "Choose a category update", 422)
    invalid_null = (
        ("name" in fields and payload.name is None)
        or ("parent_id" in fields and payload.parent_id is None)
        or ("archived" in fields and payload.archived is None)
    )
    if invalid_null:
        raise AppError(
            "category_update_invalid", "Category updates cannot be null", 422
        )
    if category.archived:
        if fields != {"archived"} or payload.archived is not False:
            raise AppError(
                "category_update_invalid",
                "Archived categories can only be restored",
                422,
            )
        category.archived = False
        return
    if "archived" in fields:
        if payload.archived is not True or len(fields) != 1:
            raise AppError(
                "category_update_invalid", "Active categories can only be archived", 422
            )
        category.archived = True
        archived_ids = [category.id]
        if category.parent_id is None:
            archived_ids.extend(
                db.scalars(select(Category.id).where(Category.parent_id == category.id)).all()
            )
        db.execute(
            update(ScheduledTransaction)
            .where(ScheduledTransaction.category_id.in_(archived_ids))
            .values(category_id=None)
        )
        return
    if "is_discretionary" in fields:
        require_assignable(db, category_id)
    if "parent_id" in fields:
        if category.parent_id is None:
            raise AppError(
                "category_update_invalid", "Parent categories cannot be moved", 422
            )
        _active_parent(db, payload.parent_id)
    name, name_key = (
        _name(payload.name)
        if "name" in fields
        else (category.name, category.name_key)
    )
    parent_id = payload.parent_id if "parent_id" in fields else category.parent_id
    _assert_unique_name(db, name_key, parent_id, category.id)
    category.name = name
    category.name_key = name_key
    category.parent_id = parent_id
    if "is_discretionary" in fields:
        category.is_discretionary = payload.is_discretionary


def delete_category(db: Session, category_id: int, payload: CategoryDelete) -> None:
    category = _category(db, category_id)
    children = db.scalars(
        select(Category).where(Category.parent_id == category.id)
    ).all()
    child_ids = [child.id for child in children]
    deleted_ids = (
        [category.id, *child_ids] if category.parent_id is None else [category.id]
    )
    blockers = rule_references(db, set(deleted_ids))
    if blockers:
        raise AppError("category_used_by_rules", "Edit or delete these rules before deleting their category.", 409, {"rules": blockers})
    if payload.destination_id is not None:
        if payload.destination_id in deleted_ids:
            raise AppError(
                "category_destination_invalid",
                "Choose a destination outside the deleted category branch",
                422,
            )
        try:
            destination = require_assignable(db, payload.destination_id)
        except AppError:
            raise AppError(
                "category_destination_invalid",
                "Choose an active subcategory outside the deleted category branch",
                422,
            ) from None
    db.execute(
        update(Transaction)
        .where(Transaction.category_id.in_(deleted_ids))
        .values(category_id=payload.destination_id)
    )
    db.execute(
        update(TransactionAllocation)
        .where(TransactionAllocation.category_id.in_(deleted_ids))
        .values(category_id=payload.destination_id)
    )
    db.execute(
        update(ScheduledTransaction)
        .where(ScheduledTransaction.category_id.in_(deleted_ids))
        .values(category_id=payload.destination_id)
    )
    for child in children:
        db.delete(child)
    db.flush()
    db.delete(category)
    db.flush()

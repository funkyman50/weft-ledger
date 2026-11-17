from datetime import date

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import PositiveInt
from sqlalchemy.orm import Session

from app.db import read_snapshot
from app.routers.deps import get_command_db, get_db
from app.schemas import (
    PayeeName,
    PayeeDefaultCategoryPreview,
    PayeeDefaultCategoryPreviewOut,
    PayeeDefaultCategorySave,
    PayeeDefaultCategorySuggestion,
    PayeeHistoryPage,
    PayeeOut,
    PayeePreview,
    PayeeRuleTrace,
    PayeePreviewRequest,
    PayeeRuleApply,
    PayeeRuleDelete,
    PayeeRuleMove,
    PayeeRuleSaveRequest,
    PayeeRules,
    PayeeScheduleAssignment,
    PayeeScheduleAssignments,
    PayeeReferences,
    PayeeReplacementPreview,
    PayeeReplacementRequest,
    PayeeDeletionRequest,
    PayeeUnusedDeletionPreview,
    TransactionBulkApply,
    TransactionBulkApplyResult,
    TransactionTargets,
)
from app.services import commands, ledger, ledger_projection, payees, scheduled_transactions

router = APIRouter(prefix="/api/payees", tags=["payees"])


@router.get("", response_model=list[PayeeOut])
def list_payees(db: Session = Depends(get_db)):
    return payees.list_out(db)


@router.get("/assignment-counts", response_model=dict[int, int])
def assignment_counts(db: Session = Depends(get_db)):
    with read_snapshot(db):
        return ledger_projection.payee_assignment_counts(db)


@router.post("/{payee_id:int}/assign", response_model=TransactionBulkApplyResult)
def assign_payee(
    payee_id: PositiveInt, payload: TransactionTargets, request: Request,
    db: Session = Depends(get_command_db),
) -> TransactionBulkApplyResult:
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Assign payee"):
        assignment = TransactionBulkApply(targets=payload.targets, changes={"payee_id": payee_id})
        result = TransactionBulkApplyResult.model_validate(
            ledger.bulk_apply(db, assignment, assign_payee_sources=True)
        )
    return result


@router.post("", status_code=201, response_model=PayeeOut)
def create_payee(
    payload: PayeeName, request: Request, db: Session = Depends(get_command_db)
):
    with commands.ordinary(
        db, request.app.state.ledger_history, history="preserve", label="Payee created."
    ):
        payee = payees.create(db, payload.name)
        db.flush()
        result = PayeeOut.model_validate(payees.out(db, payee))
    return result


@router.patch("/{payee_id:int}", response_model=PayeeOut)
def rename_payee(
    payee_id: int,
    payload: PayeeName,
    request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(
        db,
        request.app.state.ledger_history,
        history="invalidate",
        label="A saved change ended earlier undo history.",
    ):
        payee = payees.rename(db, payee_id, payload.name)
        db.flush()
        result = PayeeOut.model_validate(payees.out(db, payee))
    return result


@router.get("/{payee_id:int}/references", response_model=PayeeReferences)
def payee_references(
    payee_id: int, offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    with read_snapshot(db):
        return PayeeReferences.model_validate(payees.references(db, payee_id, offset)).model_dump()


@router.get("/{payee_id:int}/schedules", response_model=PayeeScheduleAssignments)
def payee_schedules(payee_id: PositiveInt, offset: int = Query(default=0, ge=0), db: Session = Depends(get_db)):
    with read_snapshot(db):
        return PayeeScheduleAssignments.model_validate(scheduled_transactions.payee_assignments(db, payee_id, offset)).model_dump()


@router.post("/{payee_id:int}/schedules/assign", status_code=204, response_class=Response)
def assign_payee_schedules(
    payee_id: PositiveInt, payload: PayeeScheduleAssignment,
    request: Request, db: Session = Depends(get_command_db),
) -> Response:
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Assign schedule payee"):
        scheduled_transactions.assign_payee(db, payee_id, payload)
    return Response(status_code=204)


@router.get("/{payee_id:int}/replacement-preview", response_model=PayeeReplacementPreview)
def replacement_preview(
    payee_id: int, destination_payee_id: PositiveInt,
    offset: int = Query(default=0, ge=0), db: Session = Depends(get_db),
):
    with read_snapshot(db):
        return PayeeReplacementPreview.model_validate(
            ledger.preview_payee_replacement(db, payee_id, destination_payee_id, offset)
        ).model_dump()


@router.post("/{payee_id:int}/replace", status_code=204, response_class=Response)
def replace_payee(
    payee_id: PositiveInt, payload: PayeeReplacementRequest,
    request: Request, db: Session = Depends(get_command_db),
) -> Response:
    with commands.ordinary(
        db, request.app.state.ledger_history, history="invalidate",
        label="Payee replacement ended earlier undo history.",
    ):
        ledger.replace_payee(db, payee_id, payload)
        db.flush()
    return Response(status_code=204)


@router.get("/unused/deletion-preview", response_model=PayeeUnusedDeletionPreview)
def unused_payee_deletion_preview(db: Session = Depends(get_db)):
    with read_snapshot(db):
        return payees.unused_deletion_preview(payees.unused_deletion_plan(db))


@router.delete("/unused", status_code=204, response_class=Response)
def delete_unused_payees(
    payload: PayeeDeletionRequest,
    request: Request,
    db: Session = Depends(get_command_db),
) -> Response:
    with commands.ordinary(
        db,
        request.app.state.ledger_history,
        history="invalidate",
        label="Unused payee deletion ended earlier undo history.",
    ):
        ledger.delete_unused_payees(db, payload.preview_token)
        db.flush()
    return Response(status_code=204)


@router.delete("/{payee_id:int}", status_code=204, response_class=Response)
def delete_payee(
    payee_id: int,
    payload: PayeeDeletionRequest,
    request: Request,
    db: Session = Depends(get_command_db),
) -> Response:
    with commands.ordinary(
        db,
        request.app.state.ledger_history,
        history="invalidate",
        label="Payee deletion ended earlier undo history.",
    ):
        ledger.delete_payee(db, payee_id, payload.preview_token)
        db.flush()
    return Response(status_code=204)


@router.get("/rules", response_model=PayeeRules)
def get_rules(db: Session = Depends(get_db)):
    return ledger.rule_collection(db)


@router.post("/rules", response_model=PayeeRules)
def save_rule(
    payload: PayeeRuleSaveRequest, request: Request, db: Session = Depends(get_command_db)
):
    applying = payload.apply_preview_token is not None
    with commands.ordinary(
        db,
        request.app.state.ledger_history,
        history="capture" if applying else "preserve",
        label="Save and apply payee rule" if applying else "Payee rule saved.",
    ):
        if applying:
            ledger.save_and_apply_payee_rule(db, payload)
        else:
            payees.save_rule(db, payload.rule, payload.expected_rules_token)
        result = PayeeRules.model_validate(ledger.rule_collection(db))
    return result


@router.post("/rules/{rule_id:int}/move", response_model=PayeeRules)
def move_rule(
    rule_id: int,
    payload: PayeeRuleMove,
    request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(
        db,
        request.app.state.ledger_history,
        history="preserve",
        label="Payee rule moved.",
    ):
        payees.move_rule(db, rule_id, payload.direction, payload.expected_rules_token)
        result = PayeeRules.model_validate(ledger.rule_collection(db))
    return result


@router.delete("/rules/{rule_id:int}", response_model=PayeeRules)
def delete_rule(
    rule_id: int,
    payload: PayeeRuleDelete,
    request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(
        db,
        request.app.state.ledger_history,
        history="preserve",
        label="Payee rule deleted.",
    ):
        payees.delete_rule(db, rule_id, payload.expected_rules_token)
        result = PayeeRules.model_validate(ledger.rule_collection(db))
    return result


@router.post(
    "/{payee_id:int}/default-category/preview",
    response_model=PayeeDefaultCategoryPreviewOut,
)
def preview_default_category(
    payee_id: int,
    payload: PayeeDefaultCategoryPreview,
    db: Session = Depends(get_db),
):
    return ledger.preview_default_category(
        db,
        payee_id,
        payload.category_id,
        payload.expected_default_category_id,
    )


@router.put("/{payee_id:int}/default-category", response_model=PayeeOut)
def save_default_category(
    payee_id: int,
    payload: PayeeDefaultCategorySave,
    request: Request,
    db: Session = Depends(get_command_db),
):
    history = "capture" if payload.targets else "preserve"
    with commands.ordinary(
        db,
        request.app.state.ledger_history,
        history=history,
        label="Apply payee default category",
    ):
        payee = ledger.save_default_category(db, payee_id, payload)
        db.flush()
        result = PayeeOut.model_validate(payees.out(db, payee))
    return result


@router.get(
    "/{payee_id:int}/default-category/suggestion",
    response_model=PayeeDefaultCategorySuggestion | None,
)
def default_category_suggestion(
    payee_id: int,
    transaction_id: int,
    category_id: int,
    db: Session = Depends(get_db),
):
    return ledger.default_category_suggestion(db, payee_id, transaction_id, category_id)


@router.get("/transactions", response_model=PayeeHistoryPage)
def history(
    q: str = "",
    account_id: int | None = None,
    payee_id: int | None = None,
    exclude_payee_id: int | None = None,
    before_date: date | None = None,
    before_id: int | None = None,
    before_order: int | None = None,
    db: Session = Depends(get_db),
):
    return ledger.payee_history(
        db, q, account_id, payee_id, exclude_payee_id, before_date, before_id, before_order
    )


@router.get("/rules/trace", response_model=PayeeRuleTrace)
def rule_trace(transaction_id: int, db: Session = Depends(get_db)):
    return ledger.rule_trace(db, transaction_id)


@router.post("/rules/preview", response_model=PayeePreview)
def preview(payload: PayeePreviewRequest, db: Session = Depends(get_db)):
    return ledger.payee_preview(db, payload)


@router.post("/rules/apply", response_model=TransactionBulkApplyResult)
def apply_rule(
    payload: PayeeRuleApply, request: Request, db: Session = Depends(get_command_db)
):
    with commands.ordinary(
        db,
        request.app.state.ledger_history,
        history="capture",
        label="Apply payee rule to history",
    ):
        result = TransactionBulkApplyResult.model_validate(
            ledger.apply_payee_rule(db, payload)
        )
    return result

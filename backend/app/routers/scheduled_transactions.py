from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.db import read_snapshot
from app.routers.deps import get_command_db, get_db
from app.schemas import (
    AccountScopeFilter,
    ScheduleBatch,
    StatusOk,
    ScheduleCommand,
    ScheduleDefinition,
    ScheduleEnterOut,
    SchedulePageOut,
    ScheduleRowOut,
    ScheduleUpdate,
    StatusDeleted,
)
from app.services import commands, scheduled_transactions as schedules


router = APIRouter(prefix="/api/schedules", tags=["schedules"])


@router.post("/batch", response_model=StatusOk)
def batch(payload: ScheduleBatch, request: Request, db: Session = Depends(get_command_db)) -> dict:
    label = {"enter_now": "Scheduled occurrences entered.", "skip": "Scheduled occurrences skipped.", "send_to": "Schedules sent to account.", "update": "Schedules updated."}[payload.action]
    with commands.ordinary(db, request.app.state.ledger_history, history="capture" if payload.action in ("enter_now", "skip") else "preserve", label=label):
        result = schedules.batch(db, payload)
    return result


@router.get("", response_model=SchedulePageOut)
def list_schedules(scope: AccountScopeFilter = Depends(), db: Session = Depends(get_db)) -> dict:
    with read_snapshot(db):
        return schedules.list_schedules(db, scope.account_id, scope.group_name)


@router.get("/recurring-draft/{transaction_id}", response_model=ScheduleDefinition, response_model_exclude_unset=True)
def recurring_draft(transaction_id: int, db: Session = Depends(get_db)) -> dict:
    return schedules.recurring_draft(db, transaction_id)


@router.post("", status_code=201, response_model=ScheduleRowOut)
def create(payload: ScheduleDefinition, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Schedule created."):
        result = schedules.create(db, payload)
    return result


@router.put("/{identifier}", response_model=ScheduleRowOut | None)
def update(identifier: int, payload: ScheduleUpdate, request: Request, db: Session = Depends(get_command_db)) -> dict | None:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Schedule updated."):
        result = schedules.update(db, identifier, payload)
    return result


@router.post("/{identifier}/delete", response_model=StatusDeleted)
def delete(identifier: int, payload: ScheduleCommand, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Schedule deleted."):
        schedules.delete(db, identifier, payload.edit_token)
    return {"status": "deleted"}


@router.post("/{identifier}/skip", response_model=ScheduleRowOut | None)
def skip(identifier: int, payload: ScheduleCommand, request: Request, db: Session = Depends(get_command_db)) -> dict | None:
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Scheduled occurrence skipped"):
        result = schedules.skip(db, identifier, payload.edit_token)
    return result


@router.post("/{identifier}/enter-now", response_model=ScheduleEnterOut, response_model_exclude_unset=True)
def enter_now(identifier: int, payload: ScheduleCommand, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Scheduled occurrence entered"):
        result = schedules.enter_now(db, identifier, payload.edit_token)
    return result

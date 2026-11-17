from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.routers.deps import get_command_db, get_db
from app.schemas import (
    CategoryCreate,
    CategoryDelete,
    CategoryOut,
    CategoryTreeOut,
    CategoryUpdate,
)
from app.services import categories, commands

router = APIRouter(prefix="/api/categories", tags=["categories"])


@router.get("", response_model=list[CategoryTreeOut])
def list_categories(db: Session = Depends(get_db)):
    return categories.list_categories(db)


@router.post("", status_code=201, response_model=CategoryOut)
def create_category(
    payload: CategoryCreate, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        result = CategoryOut.model_validate(categories.create_category(db, payload))
    return result


@router.patch("/{category_id}", response_model=dict[str, bool])
def update_category(
    category_id: int, payload: CategoryUpdate, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        categories.update_category(db, category_id, payload)
        db.flush()
    return {"success": True}


@router.post("/{category_id}/delete", response_model=dict[str, bool])
def delete_category(
    category_id: int, payload: CategoryDelete, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        categories.delete_category(db, category_id, payload)
    return {"success": True}

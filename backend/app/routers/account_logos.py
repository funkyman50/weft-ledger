from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.db import read_snapshot
from app.routers.deps import get_command_db, get_db
from app.services import account_logos, commands

router = APIRouter(prefix="/api/account-logos", tags=["account logos"])


class IconImport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=255)
    data: str = Field(max_length=account_logos.MAX_BASE64_CHARACTERS)


class IconName(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=80)


@router.get("")
def list_icons(db: Session = Depends(get_db)) -> list[dict]:
    with read_snapshot(db):
        return account_logos.list_logos(db)


@router.get("/{identifier}/image")
def icon_image(identifier: str, db: Session = Depends(get_db)) -> Response:
    image = account_logos.get_logo(db, identifier).image
    return Response(image, media_type="image/png", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post("")
def import_icon(payload: IconImport, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Icon imported."):
        result = account_logos.import_logo(db, payload.name, payload.data)
    return result


@router.delete("/{identifier}")
def remove_icon(identifier: str, request: Request, db: Session = Depends(get_command_db)) -> list[dict]:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Unused icon removed."):
        result = account_logos.remove_logo(db, identifier)
    return result


@router.patch("/{identifier}")
def rename_icon(identifier: str, payload: IconName, request: Request, db: Session = Depends(get_command_db)) -> list[dict]:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Icon renamed."):
        result = account_logos.rename_logo(db, identifier, payload.name)
    return result

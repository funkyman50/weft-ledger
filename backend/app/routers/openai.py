from html import escape
import secrets

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from app.errors import AppError
from app.schemas import (
    OpenAIAuthorizationOut,
    OpenAICheckOut,
    OpenAIDisconnectOut,
    OpenAIModelsOut,
    OpenAIStatusOut,
)


def no_cache(response: Response):
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/api/openai", tags=["openai"], dependencies=[Depends(no_cache)])
callback_router = APIRouter()


class RevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: str = Field(min_length=1, max_length=64)


class AuthorizationRequest(RevisionRequest):
    client_id: str | None = Field(default=None, min_length=1, max_length=256)


class SettingsRequest(AuthorizationRequest):
    ai_disabled: bool | None = None
    selected_model: str | None = Field(default=None, min_length=1, max_length=200)
    acknowledge_usage: bool = False


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    attempt_id: str = Field(min_length=1, max_length=64)


@router.get("/status", response_model=OpenAIStatusOut)
def status(request: Request) -> dict:
    return request.app.state.openai_connection.status()


@router.get("/models", response_model=OpenAIModelsOut)
def models(request: Request) -> dict:
    return {"models": request.app.state.openai_connection.models()}


@router.post("/settings", response_model=OpenAIStatusOut)
def settings(payload: SettingsRequest, request: Request) -> dict:
    return request.app.state.openai_connection.update_settings(
        payload.expected_revision, ai_disabled=payload.ai_disabled,
        model=payload.selected_model, set_model="selected_model" in payload.model_fields_set,
        client_id=payload.client_id, acknowledge=payload.acknowledge_usage,
    )


@router.post("/authorize", response_model=OpenAIAuthorizationOut)
def authorize(payload: AuthorizationRequest, request: Request) -> dict:
    return request.app.state.openai_connection.start_authorization(payload.expected_revision, payload.client_id)


@router.post("/authorization/cancel", response_model=OpenAIStatusOut)
def cancel(payload: CancelRequest, request: Request) -> dict:
    return request.app.state.openai_connection.cancel_authorization(payload.attempt_id)


@router.post("/disconnect", response_model=OpenAIDisconnectOut)
def disconnect(payload: RevisionRequest, request: Request) -> dict:
    return request.app.state.openai_connection.disconnect(payload.expected_revision)


@router.post("/check", response_model=OpenAICheckOut)
def check(payload: RevisionRequest, request: Request) -> dict:
    return request.app.state.openai_connection.check_connection(payload.expected_revision)


@callback_router.get("/auth/callback", response_class=HTMLResponse)
def callback(request: Request) -> HTMLResponse:
    query = request.query_params
    try:
        if any(len(query.getlist(key)) > 1 for key in ("state", "code", "client_id", "error")):
            raise AppError("openai_authorization_invalid", "This sign-in callback could not be verified. Return to Weft and start again.", 409)
        result = request.app.state.openai_connection.complete_authorization(query.get("state"), query.get("code"), query.get("client_id"), query.get("error"))
        title = "ChatGPT connected"
        message = "Return to Weft. AI remains under your control in System settings."
        if not result["plan_usage_enabled"]:
            message = "Return to Weft. Sign-in succeeded, but ChatGPT plan usage was not authorized."
        status_code = 200
    except AppError as error:
        title, message, status_code = "ChatGPT connection incomplete", error.message, error.status
    nonce = secrets.token_urlsafe(24)
    return HTMLResponse(
        f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{escape(title)}</title><h1>{escape(title)}</h1><p>{escape(message)}</p><script nonce="{nonce}">history.replaceState(null,"","/auth/callback")</script></html>',
        status_code=status_code,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": f"default-src 'none'; script-src 'nonce-{nonce}'; frame-ancestors 'none'"},
    )

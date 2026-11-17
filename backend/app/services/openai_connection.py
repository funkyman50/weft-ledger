import base64
import hashlib
import json
import os
import secrets
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlencode, urlparse
from uuid import uuid4

import httpx
import jwt
from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.config import Settings
from app.diagnostics import diagnostics
from app.errors import AppError

ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
USAGE_SCOPE = "chatgpt.tokens.use.direct"
TERMINAL_REFRESH_ERRORS = {
    "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
    "refresh_token_invalidated", "refresh_token_reused",
}


class Tokens(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    access_token: str
    refresh_token: str | None
    id_token: str
    expires_at: float
    scopes: list[str]


class Registration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    client_id: str
    subject: str
    email: str | None = None
    tokens: Tokens | None = None
    usage_acknowledged: bool = False


class Installation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    revision: str = Field(default_factory=lambda: str(uuid4()))
    host_id: str = Field(default_factory=lambda: f"urn:uuid:{uuid4()}")
    ai_disabled: bool = True
    selected_model: str | None = None
    active_client_id: str | None = None
    registrations: list[Registration] = Field(default_factory=list)


class ResponseText:
    def __init__(self):
        self.data = []
        self.buffer = bytearray()
        self.received = 0
        self.completed = None
        self.parts = []

    def feed(self, chunk):
        self.received += len(chunk)
        if self.received > 2_000_000:
            raise AppError("openai_output_too_large", "ChatGPT returned too much output. The request did not pass output validation.", 502)
        self.buffer.extend(chunk)
        while (end := self.buffer.find(b"\n")) >= 0:
            line = bytes(self.buffer[:end]).decode("utf-8").rstrip("\r")
            del self.buffer[:end + 1]
            self._line(line)

    def _line(self, line):
        if line.startswith("data:"):
            self.data.append(line[5:].lstrip())
        elif not line and self.data:
            encoded = "\n".join(self.data)
            self.data = []
            if encoded == "[DONE]":
                return
            event = json.loads(encoded)
            kind = event["type"]
            if kind == "response.completed":
                if self.completed is not None:
                    raise ValueError()
                self.completed = event["response"]
            elif kind == "response.output_text.done":
                self.parts.append(event["text"])
            elif kind in {"error", "response.failed", "response.incomplete", "response.refusal.done"}:
                raise AppError("openai_output_failed", "ChatGPT did not complete the requested output. Review plan usage or try another eligible model.", 502)

    def text(self):
        if self.buffer.startswith(b"data:") and self.buffer[5:].strip() == b"[DONE]":
            self.data.append("[DONE]")
            self.buffer.clear()
        if self.data == ["[DONE]"]:
            self.data.clear()
        if self.buffer or self.data or not self.completed or self.completed.get("status") != "completed":
            raise ValueError()
        output = self.completed.get("output", [])
        if any(part.get("type") == "refusal" for item in output for part in item.get("content", [])):
            raise ValueError()
        return "".join(self.parts) if self.parts else "".join(
            part["text"] for item in output if item.get("type") == "message"
            for part in item.get("content", []) if part.get("type") == "output_text"
        )


class OpenAIConnection:
    def __init__(self, settings: Settings):
        self.path = Path(settings.db_path).with_suffix(".openai.enc")
        key = hashlib.sha256((settings.secret + ":openai-connection").encode()).digest()
        self.cipher = Fernet(base64.urlsafe_b64encode(key))
        if not 1 <= settings.openai_callback_port <= 65535:
            raise ValueError("WEFT_OPENAI_CALLBACK_PORT must be a valid TCP port.")
        self.callback_uri = f"http://127.0.0.1:{settings.openai_callback_port}/auth/callback"
        self.lock = threading.RLock()
        self.http = httpx.Client(timeout=20, follow_redirects=False)
        self.installation = None
        self.dirty = False
        self.pending = None
        self.auth_error = None
        self.metadata = None
        self.jwks = None
        self.jwks_at = 0

    def close(self):
        with self.lock:
            self.pending = None
            self.http.close()

    def _load(self):
        if self.installation is None:
            try:
                self.installation = Installation.model_validate_json(self.cipher.decrypt(self.path.read_bytes())) if self.path.exists() else Installation()
            except (OSError, InvalidToken, ValidationError) as error:
                raise AppError("openai_storage_unreadable", "OpenAI settings could not be read. Restore the installation secret and credential file before reconnecting.", 503) from error
        if self.dirty:
            self._persist()
        return self.installation

    def _persist(self):
        self.dirty = True
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=self.path.name + ".", dir=self.path.parent)
            with os.fdopen(descriptor, "wb") as target:
                target.write(self.cipher.encrypt(self.installation.model_dump_json().encode()))
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self.path)
            temporary = None
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            saved = Installation.model_validate_json(self.cipher.decrypt(self.path.read_bytes()))
            if saved != self.installation:
                raise OSError("Credential state differs after save.")
            self.dirty = False
        except (OSError, InvalidToken, ValidationError) as error:
            raise AppError("openai_storage_failed", "The OpenAI settings save could not be confirmed. Read connection status before continuing.", 503) from error
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)

    def _changed(self):
        self.installation.revision = str(uuid4())
        self._persist()

    def _expect(self, revision):
        if self._load().revision != revision:
            raise AppError("openai_settings_stale", "OpenAI settings changed. Read connection status and try again.", 409)

    def _registration(self, client_id=None):
        state = self._load()
        return next((item for item in state.registrations if item.client_id == (client_id or state.active_client_id)), None)

    def _expire_attempt(self):
        if self.pending and self.pending["expires_at"] <= time.time():
            self.pending = None
            self.auth_error = "ChatGPT sign-in expired. Start again."

    def status(self):
        with self.lock:
            state = self._load()
            self._expire_attempt()
            active = self._registration()
            tokens = active.tokens if active else None
            return {
                "revision": state.revision, "ai_disabled": state.ai_disabled,
                "selected_model": state.selected_model, "active_client_id": state.active_client_id,
                "registrations": [{"client_id": item.client_id, "email": item.email, "connected": item.tokens is not None, "verified": bool(item.subject)} for item in state.registrations],
                "connected": tokens is not None,
                "plan_usage_enabled": bool(tokens and USAGE_SCOPE in tokens.scopes),
                "usage_acknowledged": bool(active and active.usage_acknowledged),
                "authorization_pending": bool(self.pending),
                "authorization_attempt": self.pending["id"] if self.pending else None,
                "authorization_error": self.auth_error,
            }


    def _error(self, response):
        try:
            body = response.json()
        except ValueError:
            body = {}
        error = body.get("error") if isinstance(body, dict) else None
        code = error.get("code") if isinstance(error, dict) else error
        code = code if isinstance(code, str) else None
        diagnostics.emit("openai.request_rejected", status=response.status_code, code=code)
        messages = {
            "subscription_sharing_user_not_eligible": "This ChatGPT account or workspace cannot grant model usage to Weft.",
            "subscription_sharing_usage_limit_exceeded": "ChatGPT usage limit reached. Open Manage usage to review the applicable limit.",
            "subscription_sharing_unsupported_capability": "This model or ChatGPT connection does not support the requested output. Choose another eligible model or retry after support changes.",
        }
        if code in TERMINAL_REFRESH_ERRORS:
            return AppError("openai_reconnect_required", "ChatGPT authorization expired or was revoked. Continue with ChatGPT to reconnect.", 409)
        if response.status_code == 401:
            message = "ChatGPT did not accept this authorization. Reconnect and check plan-use permission."
        elif response.status_code == 429:
            message = "ChatGPT usage limit reached. Open Manage usage and try again later."
        elif response.status_code == 403:
            message = "ChatGPT denied model access for this account, workspace or integration."
        else:
            message = "OpenAI could not complete the request. Try again later; no alternate billing source was used."
        return AppError("openai_provider_failed", messages.get(code, message), 502, {
            "provider_status": response.status_code,
            "provider_code": code if isinstance(code, str) and len(code) <= 120 and code.replace("_", "").isalnum() else None,
            "request_id": response.headers.get("x-request-id") or response.headers.get("openai-request-id"),
        })

    def _request(self, method, url, **kwargs):
        try:
            response = self.http.request(method, url, **kwargs)
        except httpx.HTTPError as error:
            raise AppError("openai_unavailable", "OpenAI could not be reached. Read connection status before trying again.", 502) from error
        if not response.is_success:
            raise self._error(response)
        return response

    def _json(self, method, url, **kwargs):
        response = self._request(method, url, **kwargs)
        try:
            body = response.json()
            if not isinstance(body, dict):
                raise ValueError()
            return body
        except ValueError as error:
            raise AppError("openai_invalid_response", "OpenAI returned an unreadable response. Try again later.", 502) from error

    def _discovery(self):
        if self.metadata is None:
            body = self._json("GET", ISSUER + "/.well-known/openid-configuration")
            if body.get("issuer") != ISSUER:
                raise AppError("openai_invalid_issuer", "OpenAI identity discovery could not be verified.", 502)
            for key in ("authorization_endpoint", "token_endpoint", "revocation_endpoint", "jwks_uri"):
                endpoint = urlparse(body.get(key, ""))
                if endpoint.scheme != "https" or endpoint.netloc != "auth.openai.com":
                    raise AppError("openai_invalid_discovery", "OpenAI identity endpoints could not be verified.", 502)
            self.metadata = body
        return self.metadata

    def start_authorization(self, revision, client_id=None):
        with self.lock:
            self._expect(revision)
            self._expire_attempt()
            if self.pending:
                raise AppError("openai_authorization_pending", "Finish or cancel the current ChatGPT sign-in first.", 409)
            account = self._registration(client_id) if client_id else next((item for item in self.installation.registrations if not item.subject), None)
            if client_id and account is None:
                raise AppError("openai_registration_missing", "The selected ChatGPT registration no longer exists.", 409)
            metadata = self._discovery()
            self._persist()
            verifier = secrets.token_urlsafe(64)
            self.pending = {
                "id": str(uuid4()), "state": secrets.token_urlsafe(32), "nonce": secrets.token_urlsafe(32),
                "verifier": verifier, "client_id": account.client_id if account else None,
                "expires_at": time.time() + 600,
            }
            self.auth_error = None
            query = {
                "client_id": account.client_id if account else "dynamic_agent_client",
                "ext_agent_host_id": self.installation.host_id, "redirect_uri": self.callback_uri,
                "response_type": "code", "scope": SCOPES, "resource": RESOURCE,
                "state": self.pending["state"], "nonce": self.pending["nonce"],
                "code_challenge_method": "S256",
                "code_challenge": base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("="),
            }
            if account:
                if account.email:
                    query["login_hint"] = account.email
                if not account.tokens or USAGE_SCOPE not in account.tokens.scopes:
                    query["prompt"] = "consent"
            else:
                query["agent_name_hint"] = "Weft"
            return {"authorization_url": metadata["authorization_endpoint"] + "?" + urlencode(query), "attempt_id": self.pending["id"]}

    def cancel_authorization(self, attempt_id):
        with self.lock:
            self._load()
            if self.pending and self.pending["id"] == attempt_id:
                self.pending = None
                self.auth_error = None
            return self.status()

    def _identity(self, token, client_id, nonce=None):
        try:
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
                raise jwt.InvalidTokenError()
            if not self.jwks or time.time() - self.jwks_at > 3600 or not any(item.get("kid") == header["kid"] for item in self.jwks.get("keys", [])):
                self.jwks = self._json("GET", self._discovery()["jwks_uri"])
                self.jwks_at = time.time()
            key = next(item for item in self.jwks["keys"] if item.get("kid") == header["kid"])
            claims = jwt.decode(token, jwt.PyJWK.from_dict(key).key, algorithms=["RS256"], audience=client_id, issuer=ISSUER, leeway=5, options={"require": ["sub", "exp", "iat", "iss", "aud"]})
            if not isinstance(claims["sub"], str) or not claims["sub"] or nonce is not None and claims.get("nonce") != nonce:
                raise jwt.InvalidTokenError()
            return claims
        except (jwt.PyJWTError, StopIteration, KeyError, ValueError, TypeError) as error:
            raise AppError("openai_identity_invalid", "ChatGPT identity could not be verified. Start sign-in again.", 409) from error

    def _tokens(self, body, previous=None):
        try:
            access = body["access_token"]
            identity = body.get("id_token") or (previous.id_token if previous else None)
            refresh = body.get("refresh_token")
            scope = body.get("scope")
            scopes = scope.split() if isinstance(scope, str) else (previous.scopes if previous else [])
            expiry = body["expires_in"]
            if not isinstance(access, str) or not access or not isinstance(identity, str) or not identity or body.get("token_type", "").casefold() != "bearer" or not isinstance(expiry, (int, float)) or isinstance(expiry, bool) or expiry <= 0:
                raise ValueError()
            if "offline_access" in scopes and (not isinstance(refresh, str) or not refresh):
                raise ValueError()
            return Tokens(access_token=access, refresh_token=refresh, id_token=identity, expires_at=time.time() + expiry, scopes=scopes)
        except (KeyError, ValueError, TypeError, AttributeError, ValidationError) as error:
            raise AppError("openai_tokens_invalid", "ChatGPT returned incomplete credentials. Start sign-in again.", 502) from error

    def complete_authorization(self, state, code, client_id, provider_error):
        with self.lock:
            self._load()
            self._expire_attempt()
            attempt = self.pending
            if not attempt or not state or not secrets.compare_digest(state.encode(), attempt["state"].encode()):
                raise AppError("openai_authorization_invalid", "This ChatGPT sign-in attempt is missing, expired or already used. Return to Weft and start again.", 409)
            self.pending = None
            try:
                if provider_error:
                    raise AppError("openai_authorization_declined", "ChatGPT sign-in was cancelled or denied. Return to Weft to try again.", 409)
                issued = attempt["client_id"] or client_id
                if not code or not issued or not issued.startswith("oaiapp_") or len(issued) > 256 or attempt["client_id"] and client_id and client_id != attempt["client_id"]:
                    raise AppError("openai_registration_invalid", "ChatGPT registration did not match this sign-in. Return to Weft and start again.", 409)
                previous = self._registration(issued)
                if previous is None:
                    self.installation.registrations.append(Registration(client_id=issued, subject=""))
                    self._changed()
                body = self._json("POST", self._discovery()["token_endpoint"], data={
                    "grant_type": "authorization_code", "client_id": issued, "code": code,
                    "code_verifier": attempt["verifier"], "redirect_uri": self.callback_uri, "resource": RESOURCE,
                })
                tokens = self._tokens(body)
                identity = self._identity(tokens.id_token, issued, attempt["nonce"])
                if previous and previous.subject and previous.subject != identity["sub"]:
                    raise AppError("openai_account_mismatch", "ChatGPT returned a different identity for this registration. The saved connection was retained.", 409)
                registration = self._registration(issued)
                registration.subject = identity["sub"]
                registration.email = identity.get("email") if isinstance(identity.get("email"), str) else None
                registration.tokens = tokens
                if self.installation.active_client_id != issued:
                    self.installation.selected_model = None
                self.installation.active_client_id = issued
                self._changed()
                self.auth_error = None
                return self.status()
            except AppError as error:
                self.auth_error = error.message
                raise

    def update_settings(self, revision, *, ai_disabled=None, model=None, set_model=False, client_id=None, acknowledge=False):
        with self.lock:
            self._expect(revision)
            if self.pending:
                raise AppError("openai_authorization_pending", "Finish or cancel ChatGPT sign-in before changing AI settings.", 409)
            active = self._registration(client_id) if client_id else self._registration()
            if client_id:
                if active is None or not active.subject:
                    raise AppError("openai_registration_unverified", "Complete this ChatGPT sign-in before selecting the registration.", 409)
            if set_model:
                if client_id and client_id != self.installation.active_client_id:
                    raise AppError("openai_settings_invalid", "Select the ChatGPT registration before choosing its model.", 422)
                if model is not None and model not in {item["slug"] for item in self.models()}:
                    raise AppError("openai_model_unavailable", "This model is not available for the active ChatGPT registration. Refresh the model list.", 409)
            if acknowledge:
                if not active or not active.tokens or USAGE_SCOPE not in active.tokens.scopes:
                    raise AppError("openai_plan_permission_missing", "Connect ChatGPT with plan-use permission first.", 409)
            before = self.installation.model_copy(deep=True)
            try:
                if ai_disabled is not None:
                    self.installation.ai_disabled = ai_disabled
                if client_id:
                    if self.installation.active_client_id != client_id:
                        self.installation.selected_model = None
                    self.installation.active_client_id = client_id
                if set_model:
                    self.installation.selected_model = model
                if acknowledge:
                    active.usage_acknowledged = True
                self._changed()
            except AppError:
                self.installation = None if self.path.exists() else before
                self.dirty = False
                raise
            return self.status()

    def _access(self):
        active = self._registration()
        if not active or not active.tokens:
            raise AppError("openai_connection_required", "Continue with ChatGPT to connect an account.", 409)
        if USAGE_SCOPE not in active.tokens.scopes:
            raise AppError("openai_plan_permission_missing", "ChatGPT is signed in, but plan usage is not enabled. Continue with ChatGPT to authorize it.", 409)
        if active.tokens.expires_at <= time.time() + 60:
            if not active.tokens.refresh_token:
                raise AppError("openai_reconnect_required", "Continue with ChatGPT to renew this connection.", 409)
            try:
                body = self._json("POST", self._discovery()["token_endpoint"], data={"grant_type": "refresh_token", "client_id": active.client_id, "refresh_token": active.tokens.refresh_token, "resource": RESOURCE})
            except AppError as error:
                if error.code == "openai_reconnect_required":
                    active.tokens = None
                    self._changed()
                raise
            tokens = self._tokens(body, active.tokens)
            if body.get("id_token") and self._identity(tokens.id_token, active.client_id)["sub"] != active.subject:
                raise AppError("openai_account_mismatch", "ChatGPT refresh returned a different identity. Reconnect before continuing.", 409)
            changed_grant = active.tokens.scopes != tokens.scopes
            active.tokens = tokens
            if changed_grant:
                self._changed()
            else:
                self._persist()
        return active.tokens.access_token

    def models(self):
        with self.lock:
            body = self._json("GET", RESOURCE + "/models", headers={"Authorization": "Bearer " + self._access()})
            items = body.get("models")
            if not isinstance(items, list):
                raise AppError("openai_catalog_invalid", "ChatGPT returned an unreadable model catalog.", 502)
            return [{"slug": item["slug"], "display_name": item["display_name"]} for item in items if isinstance(item, dict) and item.get("visibility") == "list" and isinstance(item.get("slug"), str) and isinstance(item.get("display_name"), str)]

    def disconnect(self, revision):
        with self.lock:
            self._expect(revision)
            self.pending = None
            self.auth_error = None
            active = self._registration()
            confirmed = True
            if active and active.tokens and active.tokens.refresh_token:
                try:
                    self._request("POST", self._discovery()["revocation_endpoint"], data={"token": active.tokens.refresh_token, "token_type_hint": "refresh_token", "client_id": active.client_id})
                except AppError:
                    confirmed = False
            if active:
                active.tokens = None
            self._changed()
            return {"state": self.status(), "revocation_confirmed": confirmed}

    def check_connection(self, revision):
        with self.lock:
            self._expect(revision)
            if self.installation.ai_disabled:
                raise AppError("ai_disabled", "Enable AI before checking model access. No request was sent.", 409)
            active = self._registration()
            if not active or not active.usage_acknowledged:
                raise AppError("openai_usage_confirmation_required", "Confirm ChatGPT plan usage before checking the connection.", 409)
            model = self.installation.selected_model
            if not model or model not in {item["slug"] for item in self.models()}:
                raise AppError("openai_model_unavailable", "Choose an available model before checking the connection.", 409)
            headers = {"Authorization": "Bearer " + self._access()}
            payload = {
                "model": model, "store": False, "stream": True,
                "input": [{"role": "user", "content": 'This is synthetic data. Return exactly {"payee":"Example Market"}.'}],
                "text": {"format": {"type": "json_schema", "name": "connection_check", "strict": True, "schema": {"type": "object", "properties": {"payee": {"type": "string"}}, "required": ["payee"], "additionalProperties": False}}},
            }
            parsed = ResponseText()
            started = time.monotonic()
            try:
                with self.http.stream("POST", RESOURCE + "/responses", headers=headers, json=payload) as response:
                    if not response.is_success:
                        response.read()
                        raise self._error(response)
                    for chunk in response.iter_bytes(chunk_size=16384):
                        if time.monotonic() - started > 60:
                            raise AppError("openai_check_timeout", "The connection check timed out. Try again later.", 504)
                        parsed.feed(chunk)
                if json.loads(parsed.text()) != {"payee": "Example Market"}:
                    raise ValueError()
            except AppError as error:
                if error.code == "openai_output_failed":
                    raise AppError("openai_check_failed", "ChatGPT did not complete the synthetic check. Review plan usage or try another eligible model.", 502) from error
                if error.code == "openai_output_too_large":
                    raise AppError("openai_check_too_large", "The synthetic check returned too much output. The connection has not passed its check.", 502) from error
                raise
            except httpx.HTTPError as error:
                raise AppError("openai_check_interrupted", "The connection check was interrupted. Try again later.", 502) from error
            except (ValueError, KeyError, TypeError, AttributeError) as error:
                raise AppError("openai_check_invalid", "ChatGPT did not return completed, valid structured output. The connection has not passed its check.", 502) from error
            return {"model": model, "message": "Connection verified with synthetic data. No ledger data was sent."}

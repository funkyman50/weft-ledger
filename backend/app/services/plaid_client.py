"""The API flow follows Plaid's official Python quickstart.

Source: https://github.com/plaid/quickstart/blob/master/python/server.py
Rotating WEFT_SECRET makes stored access tokens unreadable until the original secret is recovered.
"""

import base64
import hashlib
import json
import time

import certifi
import plaid
from cryptography.fernet import Fernet, InvalidToken
from plaid.api import plaid_api
from plaid.exceptions import ApiException
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.country_code import CountryCode
from plaid.model.institutions_get_request import InstitutionsGetRequest
from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest
from plaid.model.institutions_get_by_id_request_options import (
    InstitutionsGetByIdRequestOptions,
)
from plaid.model.item_get_request import ItemGetRequest
from plaid.model.item_public_token_exchange_request import (
    ItemPublicTokenExchangeRequest,
)
from plaid.model.item_remove_request import ItemRemoveRequest
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_update import LinkTokenCreateRequestUpdate
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from plaid.model.transactions_sync_request_options import TransactionsSyncRequestOptions
from urllib3.exceptions import TimeoutError as TransportTimeout

from app.config import Settings
from app.diagnostics import operation, safe_fields
from app.errors import AppError
from app.services import backup_state, plaid_settings

REQUEST_TIMEOUT_SECONDS = 30


def _remaining_timeout(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise AppError("plaid_timeout", "The bank request took too long. Refresh its status before trying again.", 504)
    return min(REQUEST_TIMEOUT_SECONDS, remaining)


def _fernet(secret: str) -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
    return Fernet(key)


def encrypt_access_token(secret: str, access_token: str) -> str:
    return _fernet(secret).encrypt(access_token.encode()).decode()


def decrypt_access_token(secret: str, access_token_enc: str) -> str:
    try:
        return _fernet(secret).decrypt(access_token_enc.encode()).decode()
    except InvalidToken as exc:
        raise AppError(
            "plaid_local_token_unreadable",
            "Weft cannot recover the original secret used to encrypt this bank connection.",
            409,
        ) from exc


def plaid_error_code(error: Exception) -> str | None:
    if not isinstance(error, ApiException):
        return None
    try:
        value = json.loads(error.body or "{}").get("error_code")
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, str) else None


def plaid_error_type(error: Exception) -> str | None:
    if not isinstance(error, ApiException):
        return None
    try:
        value = json.loads(error.body or "{}").get("error_type")
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, str) else None


def plaid_error_kind(error: Exception) -> str | None:
    code = plaid_error_code(error)
    if code in {
        "ITEM_LOGIN_REQUIRED",
        "ACCESS_NOT_GRANTED",
        "ADDITIONAL_CONSENT_REQUIRED",
    }:
        return "login_required"
    if code == "ITEM_NOT_FOUND":
        return "item_missing"
    if code in {
        "INSTITUTION_DOWN",
        "INSTITUTION_NOT_RESPONDING",
        "INSTITUTION_NOT_AVAILABLE",
        "INTERNAL_SERVER_ERROR",
        "PLANNED_MAINTENANCE",
        "RATE_LIMIT_EXCEEDED",
        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
    } or plaid_error_type(error) == "RATE_LIMIT_EXCEEDED":
        return "temporary"
    return None


class PlaidClient:
    def __init__(self, settings: Settings, db):
        self.settings = settings
        self.credentials = plaid_settings.require_configured(db, settings)
        self.identity = self.credentials.identity
        backup_state.require_bank_activity(settings.db_path)
        host = plaid.Environment.Sandbox if self.credentials.environment == "sandbox" else plaid.Environment.Production
        configuration = plaid.Configuration(
            host=host,
            ssl_ca_cert=certifi.where(),
            api_key={
                "clientId": self.credentials.client_id,
                "secret": self.credentials.secret,
                "plaidVersion": "2020-09-14",
            },
        )
        configuration.retries = False
        self.api = plaid_api.PlaidApi(plaid.ApiClient(configuration))

    def _call(self, method, request, *, page=None, timeout=REQUEST_TIMEOUT_SECONDS):
        backup_state.require_bank_activity(self.settings.db_path)
        with operation(f"plaid.{method}", page=page) as outcome:
            try:
                response = getattr(self.api, method)(request, _request_timeout=timeout)
            except Exception as error:
                if isinstance(error, (TimeoutError, TransportTimeout)):
                    raise AppError("plaid_timeout", "The bank request took too long. Refresh its status before trying again.", 504) from error
                if isinstance(error, ApiException):
                    try:
                        body = json.loads(error.body or "{}")
                        if isinstance(body, dict):
                            outcome.update(safe_fields({
                                "plaid_error_code": body.get("error_code"),
                                "plaid_error_type": body.get("error_type"),
                                "plaid_request_id": body.get("request_id"),
                                "status": error.status,
                            }))
                    except (TypeError, ValueError):
                        pass
                raise
            try:
                outcome.update(safe_fields({"plaid_request_id": response.get("request_id")}))
                if method == "transactions_sync":
                    outcome.update(safe_fields({
                        "added": len(response["added"]), "modified": len(response["modified"]),
                        "removed": len(response["removed"]), "has_more": response["has_more"],
                        "update_status": getattr(response.get("transactions_update_status"), "value", response.get("transactions_update_status")),
                    }))
            except Exception:
                pass
            return response

    def check_credentials(self) -> None:
        try:
            self._call("institutions_get", InstitutionsGetRequest(count=1, offset=0, country_codes=[CountryCode("US")]))
        except AppError:
            raise
        except Exception as error:
            raise AppError("plaid_credentials_check_failed", "Plaid could not verify these saved credentials. Check the Client ID, environment and Secret in your Plaid Dashboard, then try again. No bank connection was created.", 502) from error

    def create_link_token(self) -> str:
        request = LinkTokenCreateRequest(
            products=[Products("transactions")],
            client_name="Weft",
            country_codes=[CountryCode("US")],
            language="en",
            user=LinkTokenCreateRequestUser(
                client_user_id=self.credentials.link_user_id
            ),
            transactions=LinkTokenTransactions(days_requested=730),
        )
        try:
            response = self._call("link_token_create", request)
        except ApiException as exc:
            raise AppError(
                "plaid_link_token_failed",
                "Plaid could not start a bank connection. Check the configured "
                "Plaid credentials and try again.",
                424,
            ) from exc
        return response["link_token"]

    def create_update_link_token(
        self, access_token: str, *, account_selection_enabled: bool = False
    ) -> str:
        request = LinkTokenCreateRequest(
            client_name="Weft",
            country_codes=[CountryCode("US")],
            language="en",
            user=LinkTokenCreateRequestUser(
                client_user_id=self.credentials.link_user_id
            ),
            access_token=access_token,
            update=LinkTokenCreateRequestUpdate(
                account_selection_enabled=account_selection_enabled
            ),
        )
        try:
            response = self._call("link_token_create", request)
        except ApiException as exc:
            kind = plaid_error_kind(exc)
            if kind == "login_required":
                raise AppError(
                    "plaid_repair_action_required",
                    "Bank sign-in or consent needs attention. Start repair again.",
                    424,
                ) from exc
            if kind == "item_missing":
                raise AppError(
                    "plaid_repair_item_missing",
                    "This bank connection no longer exists at Plaid. Disconnect affected local accounts to preserve their history.",
                    424,
                ) from exc
            if kind == "temporary":
                raise AppError(
                    "plaid_repair_temporary",
                    "Plaid could not start bank connection repair because service is temporarily unavailable.",
                    424,
                ) from exc
            raise AppError(
                "plaid_repair_link_token_failed",
                "Plaid could not start bank connection repair.",
                424,
            ) from exc
        return response["link_token"]

    def exchange_public_token(self, public_token: str) -> tuple[str, str]:
        try:
            response = self._call("item_public_token_exchange",
                ItemPublicTokenExchangeRequest(public_token=public_token)
            )
        except AppError as error:
            if error.code == "plaid_timeout":
                raise AppError(
                    "plaid_exchange_outcome_unknown",
                    "The bank link may have been created, but Weft did not receive its credentials. Check the Plaid dashboard before linking again.",
                    504,
                ) from error
            raise
        except ApiException as exc:
            raise AppError(
                "plaid_public_token_exchange_failed",
                "Plaid could not finish this bank connection. Try again.",
                424,
            ) from exc
        return response["item_id"], response["access_token"]

    def remove_item(self, access_token: str) -> None:
        try:
            self._call("item_remove",
                ItemRemoveRequest(access_token=access_token), timeout=4
            )
        except Exception as exc:
            if isinstance(exc, AppError) and exc.code in {"bank_sync_paused", "backup_state_invalid"}:
                raise
            if plaid_error_code(exc) == "ITEM_NOT_FOUND":
                return
            raise AppError(
                "plaid_item_remove_failed",
                "Plaid could not remove this institution connection; try again.",
                424,
            ) from exc

    def institution_details(
        self, access_token: str, institution_id: str | None = None
    ) -> dict:
        deadline = time.monotonic() + REQUEST_TIMEOUT_SECONDS
        institution_name = None
        if not institution_id:
            item = self._call("item_get",
                ItemGetRequest(access_token=access_token), timeout=_remaining_timeout(deadline)
            ).to_dict()["item"]
            institution_id = item.get("institution_id")
            institution_name = item.get("institution_name")
        if not institution_id:
            return {
                "institution_id": None,
                "name": institution_name,
            }
        institution = self._call("institutions_get_by_id",
            InstitutionsGetByIdRequest(
                institution_id=institution_id,
                country_codes=[CountryCode("US")],
                options=InstitutionsGetByIdRequestOptions(
                    include_optional_metadata=False
                ),
            ),
            timeout=_remaining_timeout(deadline),
        ).to_dict()["institution"]
        _remaining_timeout(deadline)
        return {
            "institution_id": institution_id,
            "name": institution.get("name"),
        }

    def sync(
        self, access_token: str, cursor: str
    ) -> tuple[list[dict], list[dict], list[dict], str, str | None]:
        added: list[dict] = []
        modified: list[dict] = []
        removed: list[dict] = []
        has_more = True
        update_status = None
        page = 0
        seen_cursors = {cursor}
        while has_more:
            page += 1
            options = TransactionsSyncRequestOptions(include_original_description=True)
            request = TransactionsSyncRequest(
                access_token=access_token,
                cursor=cursor,
                count=500,
                options=options,
            )
            response = self._call("transactions_sync", request, page=page).to_dict()
            cursor = response["next_cursor"]
            if response["has_more"] and cursor in seen_cursors:
                raise AppError("plaid_sync_stalled", "The bank returned a repeated download cursor. Try refreshing later.", 424)
            seen_cursors.add(cursor)
            added.extend(response["added"])
            modified.extend(response["modified"])
            removed.extend(response["removed"])
            has_more = response["has_more"]
            update_status = response.get("transactions_update_status", update_status)
        return added, modified, removed, cursor, update_status

    def accounts(self, access_token: str) -> list[dict]:
        response = self._call("accounts_get",
            AccountsGetRequest(access_token=access_token)
        ).to_dict()
        return response["accounts"]

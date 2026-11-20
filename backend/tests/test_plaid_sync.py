import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.db import init_db, make_session_factory
from app.models import Account, PlaidAccountLink, PlaidItem, Transaction
from app.routers import ledger_history, plaid
from app.services.database_backup import MaintenanceGate
from app.services.ledger_history import LedgerHistoryManager, install_listeners
from app.services import plaid_settings
from app.services.plaid_client import decrypt_access_token, encrypt_access_token
from app.services.plaid_sync import run_sync


class PlaidSyncTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        database_path = str(Path(temporary.name) / "sync.db")
        engine, session_factory = make_session_factory(database_path)
        self.addCleanup(engine.dispose)
        init_db(engine)
        settings = Settings(
            secret="synthetic-secret", db_path=database_path,
        )
        self.session_factory = session_factory
        self.settings = settings

    def test_sync_persists_fetched_transaction_and_cursor(self):
        session_factory, settings = self.session_factory, self.settings
        with session_factory() as db:
            account = Account(name="Checking", type="checking")
            item = PlaidItem(
                item_id="synthetic-item", client_id_hash="0" * 64, environment="sandbox", institution="Synthetic",
                access_token_enc=encrypt_access_token(settings.secret, "synthetic-token"),
                cursor="before",
            )
            db.add_all([account, item])
            db.flush()
            account_id, item_id = account.id, item.id
            db.add(PlaidAccountLink(
                plaid_item_id=item.id, plaid_account_id="bank-account", account_id=account.id,
            ))
            db.commit()

            client = Mock(spec=["sync", "accounts", "institution_details", "transactions_status"])
            client.transactions_status.return_value = (None, None)
            client.sync.return_value = ([{
                "transaction_id": "bank-transaction", "account_id": "bank-account",
                "date": "2026-10-13", "name": "Purchase", "amount": 25,
                "pending": False,
            }], [], [], "after", "HISTORICAL_UPDATE_COMPLETE")
            client.accounts.return_value = [{
                "account_id": "bank-account",
                "balances": {"current": 100, "available": 100, "iso_currency_code": "USD"},
            }]
            client.institution_details.return_value = None

            result = run_sync(db, client=client, today=date(2026, 10, 13), settings=settings)
            self.assertEqual(result["errors"], [])
            self.assertEqual(result["added"], 1)
            client.sync.assert_called_once_with("synthetic-token", "before")

        with session_factory() as db:
            transaction = db.scalar(select(Transaction).where(
                Transaction.plaid_txn_id == "bank-transaction",
            ))
            self.assertIsNotNone(transaction)
            self.assertEqual(transaction.account_id, account_id)
            self.assertEqual(transaction.amount_cents, -2500)
            self.assertEqual(transaction.status, "cleared")
            self.assertEqual(db.get(PlaidItem, item_id).cursor, "after")
            account = db.get(Account, account_id)
            self.assertEqual(account.plaid_current_balance_cents, 10000)
            self.assertIsNotNone(account.plaid_history_imported_at)
            self.assertIsNotNone(account.starting_balance_initialized_at)

    def test_exchange_returns_success_after_committing_selected_accounts(self):
        app = FastAPI()
        app.include_router(plaid.router)
        app.include_router(ledger_history.router)
        app.state.settings = self.settings
        app.state.session_local = self.session_factory
        app.state.database_gate = MaintenanceGate()
        app.state.ledger_history = LedgerHistoryManager(str(uuid4()))
        install_listeners()
        provider = Mock(spec=["exchange_public_token", "accounts", "institution_details"])
        provider.identity = plaid_settings.load(self.settings).identity
        provider.exchange_public_token.return_value = "synthetic-item", "synthetic-token"
        provider.accounts.return_value = [{"account_id": "bank-one"}, {"account_id": "bank-two"}]
        provider.institution_details.return_value = None
        session_id, request_id = str(uuid4()), str(uuid4())
        with patch.object(plaid, "PlaidClient", return_value=provider), TestClient(app, raise_server_exceptions=False) as client:
            state = client.get("/api/ledger-history", headers={"X-Ledger-Session": session_id}).json()
            response = client.post("/api/plaid/exchange", json={
                "public_token": "synthetic-public-token", "institution": "Synthetic",
                "configuration_identity": plaid_settings.load(self.settings).identity_token,
                "accounts": {
                    "bank-one": {"name": "Checking", "type": "checking"},
                    "bank-two": {"name": "Savings", "type": "savings"},
                },
            }, headers={
                "X-Ledger-Session": session_id, "X-Ledger-Request": request_id,
                "X-Ledger-Sequence": "1", "X-Ledger-Epoch": state["epoch"],
            })
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(response.json(), {"status": "connected"})
            outcome = client.get("/api/ledger-history", headers={"X-Ledger-Session": session_id}, params={
                "request_id": request_id, "request_sequence": 1, "epoch": state["epoch"],
                "request_session": session_id, "request_generation": state["database_generation"],
            }).json()["outcome"]
            self.assertEqual(outcome["status"], "committed")
        with self.session_factory() as db:
            item = db.scalar(select(PlaidItem))
            self.assertEqual(decrypt_access_token(self.settings.secret, item.access_token_enc), "synthetic-token")
            linked = db.execute(select(PlaidAccountLink.plaid_account_id, Account.name)
                .join(Account, PlaidAccountLink.account_id == Account.id)
                .where(PlaidAccountLink.plaid_item_id == item.id)).all()
            self.assertEqual(set(linked), {("bank-one", "Checking"), ("bank-two", "Savings")})

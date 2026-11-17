import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from app.db import init_db, make_session_factory
from app.models import (
    Account,
    PlaidAccountLink,
    PlaidItem,
    Transaction,
    TransactionMatch,
)
from app.schemas import LedgerFilter, Target
from app.services import commands, ledger, ledger_history, ledger_projection, payees
from app.services import transaction_matching as matching
from sqlalchemy import select


class TransactionReconciliationHandlerTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        database_path = Path(self.temporary_directory.name) / "reconciliation.db"
        self.engine, self.session_local = make_session_factory(str(database_path))
        init_db(self.engine)
        self.db = self.session_local()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.temporary_directory.cleanup()

    def _account(self, name):
        account = Account(name=name, type="checking")
        self.db.add(account)
        self.db.flush()
        return account

    def _manual(self, account, when=date(2026, 9, 1)):
        transaction = Transaction(
            account_id=account.id,
            date=when,
            description="Manual entry",
            payee_id=payees.system_payee(self.db, "myself").id,
            amount_cents=-2500,
            status="uncleared",
            approved=True,
            source="manual",
        )
        self.db.add(transaction)
        self.db.flush()
        return transaction

    def _plaid(self, account, identifier, when=date(2026, 9, 8)):
        if account.plaid_history_imported_at is None:
            initialized_at = datetime.now()
            account.plaid_history_imported_at = initialized_at
            account.starting_balance_initialized_at = initialized_at
            self.db.add(
                Transaction(
                    account_id=account.id,
                    date=when - timedelta(days=1),
                    description="Starting Balance",
                    payee_id=payees.system_payee(self.db, "starting_balance").id,
                    amount_cents=0,
                    status="cleared",
                    approved=True,
                    source="starting_balance",
                )
            )
        transaction = Transaction(
            account_id=account.id,
            date=when,
            description="Bank entry",
            payee_id=payees.system_payee(self.db, "myself").id,
            amount_cents=-2500,
            status="cleared",
            approved=False,
            source="plaid",
            plaid_txn_id=identifier,
            plaid_raw={"name": "Bank entry"},
        )
        self.db.add(transaction)
        self.db.flush()
        return transaction

    def _link(self, account):
        item = PlaidItem(client_id_hash="0" * 64, environment="sandbox", item_id=f"fixture-{account.id}", access_token_enc="synthetic-not-a-token", institution="Synthetic")
        self.db.add(item)
        self.db.flush()
        self.db.add(PlaidAccountLink(plaid_item_id=item.id, plaid_account_id=f"fixture-{account.id}", account_id=account.id))
        self.db.flush()

    def _move(self, transaction, destination):
        ledger.bulk_move(
            self.db,
            [Target(id=transaction.id, edit_token=ledger_projection.row(self.db, transaction)["edit_token"])],
            destination.id,
        )
        self.db.commit()

    def test_move_reconciles_destination_without_existing_suggestion(self):
        source = self._account("Source")
        destination = self._account("Destination")
        manual = self._manual(source)
        destination_bank = self._plaid(destination, "destination-bank")
        self.db.commit()

        self._move(manual, destination)

        relation = self.db.scalar(
            select(TransactionMatch).where(
                TransactionMatch.feed_transaction_id == destination_bank.id,
                TransactionMatch.history_transaction_id == manual.id,
            )
        )
        self.assertIsNotNone(relation)
        self.assertEqual(relation.state, "suggested")

    def test_move_removes_old_suggestion_and_reconciles_destination(self):
        source = self._account("Source")
        destination = self._account("Destination")
        manual = self._manual(source)
        source_bank = self._plaid(source, "source-bank")
        destination_bank = self._plaid(destination, "destination-bank")
        matching.reconcile(self.db, {source.id}, allow_automatic=True, expire_stale=True)
        self.db.commit()

        self._move(manual, destination)

        old_relation = self.db.scalar(
            select(TransactionMatch).where(
                TransactionMatch.feed_transaction_id == source_bank.id,
                TransactionMatch.history_transaction_id == manual.id,
            )
        )
        new_relation = self.db.scalar(
            select(TransactionMatch).where(
                TransactionMatch.feed_transaction_id == destination_bank.id,
                TransactionMatch.history_transaction_id == manual.id,
            )
        )
        self.assertIsNone(old_relation)
        self.assertEqual(
            {
                relation.feed_transaction.account_id
                for relation in self.db.scalars(
                    select(TransactionMatch).where(
                        TransactionMatch.history_transaction_id == manual.id
                    )
                ).all()
            },
            {destination.id},
        )
        self.assertIsNotNone(new_relation)
        self.assertEqual(new_relation.state, "suggested")

    def test_unmatch_immediately_suggests_the_only_in_window_alternative(self):
        account = self._account("Checking")
        manual = self._manual(account)
        original_bank = self._plaid(account, "original-bank", date(2026, 8, 1))
        alternative_bank = self._plaid(account, "alternative-bank")
        self._link(account)
        original_relation = matching.accept(
            self.db,
            original_bank,
            manual,
            {
                **{field: "feed" for field in ledger_projection.SOURCE_FIELDS},
                "context_token": matching.context_token(
                    self.db, original_bank, manual
                ),
            },
        )
        self.db.commit()

        matching.unmatch(self.db, original_relation)
        self.db.flush()
        matching.reconcile(self.db, {account.id}, allow_automatic=True, expire_stale=True)
        self.db.commit()

        alternative_relation = self.db.scalar(
            select(TransactionMatch).where(
                TransactionMatch.feed_transaction_id == alternative_bank.id,
                TransactionMatch.history_transaction_id == manual.id,
            )
        )
        self.assertIsNotNone(alternative_relation)
        self.assertEqual(alternative_relation.state, "suggested")

    def test_undo_redo_restores_detached_bank_clearance_and_balances(self):
        account = self._account("Detached bank")
        transaction = self._plaid(account, "detached-bank")
        transaction.status = "uncleared"
        transaction.provider_lifecycle_detached_at = datetime.now()
        self.db.commit()
        account_id = account.id
        transaction_id = transaction.id

        manager = ledger_history.LedgerHistoryManager("00000000-0000-0000-0000-000000000001")
        ledger_history.install_listeners()

        def metadata(request_id, sequence):
            with manager.locked_page("clearance-session", create=True) as page:
                return ledger_history.PageRequest(session="clearance-session", epoch=page.epoch, request_id=request_id, sequence=sequence)

        def history_state():
            with manager.locked_page("clearance-session") as page:
                return manager.state(page)

        def fresh_session():
            self.db.close()
            self.db = self.session_local()
            ledger_history.write_context(self.db).command = True

        ledger_history.write_context(self.db).command = True
        ledger_history.write_context(self.db).request = metadata("clearance", 1)
        with commands.ordinary(self.db, manager, history="capture", label="Clearance change"):
            txn = self.db.get(Transaction, transaction_id)
            ledger_projection.require_action(self.db, txn, "clearance")
            txn.status = "cleared"
            self.db.flush()

        fresh_session()
        self.assertEqual(self.db.get(Transaction, transaction_id).status, "cleared")
        self.assertEqual(ledger_projection.balances(self.db, account_id)["cleared_balance_cents"], -2500)
        self.assertEqual(ledger_projection.balances(self.db, account_id)["uncleared_balance_cents"], 0)
        state = history_state()
        undo_id = state["undo"]["id"]

        ledger_history.write_context(self.db).request = metadata("undo", 2)
        commands.replay(
            self.db, manager, action_id=undo_id, expected_revision=state["revision"], direction="undo"
        )

        fresh_session()
        self.assertEqual(self.db.get(Transaction, transaction_id).status, "uncleared")
        self.assertEqual(ledger_projection.balances(self.db, account_id)["cleared_balance_cents"], 0)
        self.assertEqual(ledger_projection.balances(self.db, account_id)["uncleared_balance_cents"], -2500)
        state = history_state()

        ledger_history.write_context(self.db).request = metadata("redo", 3)
        commands.replay(
            self.db, manager, action_id=undo_id, expected_revision=state["revision"], direction="redo"
        )

        fresh_session()
        self.assertEqual(self.db.get(Transaction, transaction_id).status, "cleared")
        self.assertEqual(ledger_projection.balances(self.db, account_id)["cleared_balance_cents"], -2500)
        self.assertEqual(ledger_projection.balances(self.db, account_id)["uncleared_balance_cents"], 0)

    def test_expired_pending_original_has_consistent_current_projection(self):
        account = self._account("Expired pending")
        self._link(account)
        manual = self._manual(account)
        bank = self._plaid(account, "expiring-bank")
        bank.status = "pending"
        bank.plaid_removed_at = datetime.now() - timedelta(days=1)
        relation = TransactionMatch(
            feed_transaction_id=bank.id, history_transaction_id=manual.id,
            state="matched", matched_by="user",
            **{field: "history" for field in ledger_projection.SOURCE_FIELDS},
        )
        self.db.add(relation)
        self.db.commit()
        self.assertNotIn(manual.id, {row["id"] for row in ledger_projection.read_page(self.db, LedgerFilter(account_id=account.id))["rows"]})

        class AfterGrace(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime.now(tz) + timedelta(days=20)

        with patch("app.services.ledger_projection.datetime", AfterGrace):
            page = ledger_projection.read_page(self.db, LedgerFilter(account_id=account.id))
            projected = next(row for row in page["rows"] if row["id"] == manual.id)
            single = ledger_projection.row(self.db, manual)
            selection = next(row for row in ledger_projection.read_selection(self.db, LedgerFilter(account_id=account.id)) if row["id"] == manual.id)
            for field in ("edit_token", "allowed_actions", "editable_fields"):
                self.assertEqual(projected[field], single[field])
                self.assertEqual(projected[field], selection[field])
            self.assertIsNone(single["match"])
            self.assertIn("edit", single["allowed_actions"])
            self.assertNotIn(bank.id, {row["id"] for row in page["rows"]})
        self.assertEqual(relation.state, "matched")


if __name__ == "__main__":
    unittest.main()

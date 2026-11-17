import threading
from contextlib import contextmanager
from datetime import datetime, timedelta
from uuid import uuid4

from apscheduler.jobstores.base import JobLookupError
from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import select

from app.errors import AppError
from app.diagnostics import current_diagnostic_id, diagnostics, operation
from app.models import Account, AccountConversionAttempt, PlaidAccountLink
from app.config import Settings
from app.services import account_conversion, backup_state, commands, scheduled_transactions
from app.services.plaid_client import PlaidClient
from app.services.plaid_sync import run_sync, sync_state, status as sync_status


class PlaidSyncJobs:
    def __init__(self, session_factory, settings: Settings):
        self.session_factory = session_factory
        self.settings = settings
        self.scheduler = BackgroundScheduler()
        self._lock = threading.Lock()
        self._runner_lock = threading.Lock()
        self._pending: dict[int, int] = {}
        self._active: dict[object, set[int] | None] = {}
        self._stopping = False
        self._entry_refresh_pending = False

    def start(self) -> None:
        self.scheduler.add_job(
            self.run,
            "interval",
            hours=6,
            next_run_time=datetime.now(),
            id="plaid_sync_tick",
            coalesce=True,
            max_instances=1,
            misfire_grace_time=None,
        )
        self.scheduler.start()
        diagnostics.emit("jobs.started")
        session = self.session_factory()
        try:
            attempt_ids = list(session.scalars(
                select(AccountConversionAttempt.id).where(
                    AccountConversionAttempt.state == "fetching"
                )
            ).all())
        finally:
            session.close()
        for attempt_id in attempt_ids:
            self.enqueue_conversion(attempt_id)

    def _completed(self, incomplete: set[int], scope: set[int] | None) -> None:
        with self._lock:
            if self._stopping:
                return
            # Full syncs start a fresh ten-follow-up budget; scoped follow-ups consume it.
            for item_id in (set(self._pending) | incomplete if scope is None else scope):
                job_id = f"plaid_initial_{item_id}"
                attempts = 0 if scope is None else self._pending.get(item_id, 0) + 1
                if item_id in incomplete and attempts < 10:
                    self._pending[item_id] = attempts
                    diagnostics.emit("job.sync_followup", item_id=item_id, followup=attempts)
                    self.scheduler.add_job(
                        self.run,
                        "date",
                        run_date=datetime.now() + timedelta(minutes=1),
                        args=[{item_id}],
                        id=job_id,
                        replace_existing=True,
                    )
                else:
                    self._pending.pop(item_id, None)
                    try:
                        self.scheduler.remove_job(job_id)
                    except JobLookupError:
                        pass

    def initial_import_account_ids(self, db) -> list[int]:
        if backup_state.bank_sync_paused(self.settings.db_path):
            return []
        with self._lock:
            scopes = list(self._active.values())
            item_ids = set(self._pending)
            for scope in scopes:
                if scope is not None:
                    item_ids.update(scope)
        statement = (
            select(Account.id)
            .join(PlaidAccountLink, PlaidAccountLink.account_id == Account.id)
            .where(Account.plaid_history_imported_at.is_(None))
        )
        if not any(scope is None for scope in scopes):
            statement = statement.where(PlaidAccountLink.plaid_item_id.in_(item_ids))
        return list(db.scalars(statement.distinct()).all())

    def run(self, item_ids: set[int] | None = None, *, db=None, client=None) -> dict:
        with operation("job.sync", job_run_id=str(uuid4())) as outcome:
            run_id = object()
            session = db if db is not None else self.session_factory()
            with self._lock:
                self._active[run_id] = item_ids
            try:
                with self._runner_lock:
                    with self._lock:
                        if self._stopping:
                            return {
                                "last_sync": None,
                                "added": 0,
                                "matched": 0,
                                "suggested": 0,
                                "queued": 0,
                                "errors": [],
                                "initial_import_account_ids": [],
                            }
                    entered, entry_issues = self._enter_due()
                    try:
                        if not backup_state.bank_sync_paused(self.settings.db_path):
                            run_sync(
                                session,
                                settings=self.settings,
                                client=client,
                                item_ids=item_ids,
                                on_complete=lambda incomplete: self._completed(incomplete, item_ids),
                            )
                    finally:
                        session.rollback()
                        self._publish_entry(entered, entry_issues)
                    session.expire_all()
                    result = sync_status(session)
                    result["bank_sync_paused"] = backup_state.bank_sync_paused(self.settings.db_path)
            finally:
                with self._lock:
                    self._active.pop(run_id, None)
                if db is None:
                    session.close()
            if db is not None:
                result["initial_import_account_ids"] = self.initial_import_account_ids(db)
            outcome.update(added=result["added"], matched=result["matched"], suggested=result["suggested"], queued=result["queued"], error_count=len(result["errors"]), state="partial" if result["errors"] else "complete")
            return result

    def _enter_due(self):
        session = self.session_factory()
        try:
            with commands.background(session):
                return scheduled_transactions.enter_due(session)
        except Exception as error:
            diagnostics.emit("schedule.batch_failed", "error", error=error, code="schedule_entry_failed")
            return 0, [{"kind": "schedule_entry", "message": "Scheduled transactions could not be entered. Retry a refresh; no failed occurrence has advanced.", "account_ids": [], "missing_account_ids": []}]
        finally:
            session.close()

    def _publish_entry(self, entered, issues):
        entered = bool(entered) or self._entry_refresh_pending
        session = self.session_factory()
        try:
            with commands.background(session):
                state = sync_state(session)
                old = [issue for issue in state.errors if issue["kind"] == "schedule_entry"]
                if entered or old != issues:
                    state.schedule_revision += 1
                state.errors = [issue for issue in state.errors if issue["kind"] != "schedule_entry"] + issues
        except Exception as error:
            self._entry_refresh_pending = entered
            diagnostics.emit("schedule.status_failed", "error", error=error, code="schedule_status_failed")
        else:
            self._entry_refresh_pending = False
        finally:
            session.close()

    def enqueue_conversion(self, attempt_id: str) -> None:
        with self._lock:
            if self._stopping:
                return
            self.scheduler.add_job(
                self.run_conversion,
                "date",
                run_date=datetime.now(),
                args=[attempt_id, 0, current_diagnostic_id()],
                id=f"plaid_conversion_{attempt_id}",
                replace_existing=True,
            )
            diagnostics.emit("job.conversion_queued", attempt_id=attempt_id)

    def commit_conversion(
        self,
        db,
        attempt_id: str,
        preview_token: str,
        acknowledge_late_history: bool,
        acknowledge_pending_overlap: bool,
        client,
        secret: str,
    ) -> dict:
        with self._runner_lock:
            before = account_conversion.final_check_facts(db, attempt_id)
            account_conversion.fetch(
                db,
                attempt_id,
                client,
                secret,
                preserve_review=True,
            )
            return account_conversion.commit(
                db,
                attempt_id,
                preview_token,
                acknowledge_late_history,
                acknowledge_pending_overlap,
                account_conversion.final_check_stale_detail(
                    before,
                    account_conversion.final_check_facts(db, attempt_id),
                ),
            )

    def run_conversion(self, attempt_id: str, followup: int = 0, diagnostic_id: str | None = None) -> None:
        with operation("job.conversion", job_run_id=str(uuid4()), attempt_id=attempt_id, diagnostic_id=diagnostic_id, followup=followup) as outcome:
            session = self.session_factory()
            try:
                with self._runner_lock:
                    with self._lock:
                        if self._stopping:
                            return
                    result = account_conversion.fetch(
                        session,
                        attempt_id,
                        PlaidClient(self.settings, session),
                        self.settings.secret,
                    )
                outcome["state"] = result["state"]
                if result["state"] == "fetching" and followup < 10:
                    with self._lock:
                        if not self._stopping:
                            self.scheduler.add_job(
                                self.run_conversion,
                                "date",
                                run_date=datetime.now() + timedelta(minutes=1),
                                args=[attempt_id, followup + 1, diagnostic_id],
                                id=f"plaid_conversion_{attempt_id}",
                                replace_existing=True,
                            )
                            diagnostics.emit("job.conversion_followup", followup=followup + 1)
                elif result["state"] == "fetching":
                    attempt = session.get(AccountConversionAttempt, attempt_id)
                    if attempt is not None and attempt.state == "fetching":
                        attempt.state = "failed"
                        attempt.error = "The bank is still preparing older history. Choose Refresh to continue."
                        attempt.updated_at = datetime.now()
                        session.commit()
                        outcome["state"] = "failed"
                        diagnostics.emit("job.conversion_exhausted", "warning", state="failed", followup=followup)
            finally:
                session.close()

    def shutdown(self) -> None:
        with self._lock:
            self._stopping = True
        if self.scheduler.running:
            self.scheduler.shutdown()
        diagnostics.emit("jobs.stopped")

    def stop_for_maintenance(self) -> None:
        with self._lock:
            self._stopping = True
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)

    @contextmanager
    def maintenance(self, timeout=30):
        if not self._runner_lock.acquire(timeout=timeout):
            raise AppError("restore_busy", "Plaid work did not pause in time. Retry shortly.", 409)
        try:
            yield
        finally:
            self._runner_lock.release()

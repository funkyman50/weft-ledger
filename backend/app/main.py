from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.auth import LocalBrowserAdmission, PasswordStore, require_session, set_session_cookie
from app.config import get_settings
from app.db import database_generation, init_db, make_session_factory
from app.schema_admission import SCHEMA_REVISION
from app.diagnostics import DiagnosticMiddleware, configure_diagnostics, diagnostics, operation
from app.errors import AppError, register_error_handlers
from app.routers import (
    accounts,
    account_logos,
    categories,
    payees,
    plaid,
    transactions,
    ledger_history,
    account_conversion,
    system,
    scheduled_transactions,
    openai,
    loans,
)
from app.services.database_backup import MaintenanceGate
from app.services.ledger_history import LedgerHistoryManager, install_listeners
from app.services.jobs import PlaidSyncJobs
from app.services.openai_connection import OpenAIConnection
from app.services import backup_state, rule_regex

STATIC_DIR = Path(__file__).parent / "static"


class LoginRequest(BaseModel):
    password: str = Field(max_length=4096)


def create_app() -> FastAPI:
    settings = get_settings()
    password_store = PasswordStore(settings.db_path)
    password_store.initialize()
    configure_diagnostics(settings.db_path, settings.log_dir)
    engine, session_local = make_session_factory(settings.db_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        with operation("app.startup"):
            backup_state.load(settings.db_path)
            init_db(engine)
            app.state.ledger_history = LedgerHistoryManager(database_generation(Path(settings.db_path)))
            scheduler = PlaidSyncJobs(session_local, settings)
            app.state.plaid_sync_jobs = scheduler
            scheduler.start()
            diagnostics.emit("app.ready", schema_revision=SCHEMA_REVISION)
        try:
            yield
        finally:
            with operation("app.shutdown"):
                app.state.openai_connection.close()
                scheduler.shutdown()
                rule_regex.close()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.state.password_store = password_store
    app.state.engine = engine
    app.state.session_local = session_local
    app.state.database_gate = MaintenanceGate()
    app.state.openai_connection = OpenAIConnection(settings)
    install_listeners()

    register_error_handlers(app)
    app.add_middleware(system.UploadLimit)
    app.add_middleware(LocalBrowserAdmission)
    app.add_middleware(DiagnosticMiddleware)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.post("/login")
    def login(payload: LoginRequest, response: Response):
        state = password_store.login(payload.password)
        set_session_cookie(response, settings, state.revision)
        return {"status": "ok"}

    session_dependency = Depends(require_session)

    app.include_router(accounts.router, dependencies=[session_dependency])
    app.include_router(account_logos.router, dependencies=[session_dependency])
    app.include_router(categories.router, dependencies=[session_dependency])
    app.include_router(payees.router, dependencies=[session_dependency])
    app.include_router(transactions.router, dependencies=[session_dependency])
    app.include_router(transactions.exports_router, dependencies=[session_dependency])
    app.include_router(transactions.matches_router, dependencies=[session_dependency])
    app.include_router(ledger_history.router, dependencies=[session_dependency])
    app.include_router(plaid.router, dependencies=[session_dependency])
    app.include_router(account_conversion.router, dependencies=[session_dependency])
    app.include_router(system.router, dependencies=[session_dependency])
    app.include_router(scheduled_transactions.router, dependencies=[session_dependency])
    app.include_router(loans.router, dependencies=[session_dependency])
    app.include_router(openai.router, dependencies=[session_dependency])
    app.include_router(openai.callback_router)

    static_dir = STATIC_DIR
    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

        @app.exception_handler(404)
        async def spa_fallback(request: Request, exc):
            if request.url.path.startswith("/api/"):
                return JSONResponse(status_code=404, content={"detail": "Not Found"})
            return FileResponse(static_dir / "index.html")

    return app


app = create_app()

import json
import logging
import os
import re
import sqlite3
import sys
import threading
import time
from collections import OrderedDict, deque
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from uuid import UUID, uuid4

from starlette.responses import JSONResponse
from starlette.staticfiles import StaticFiles


MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_EVENT_BYTES = 8192
LIFECYCLE_RULE_VERSION = 11
_context = ContextVar("diagnostics", default={})
_numeric_fields = {
    "status", "duration_ms", "item_id", "followup", "page", "added", "modified",
    "removed", "matched", "suggested", "queued", "error_count", "item_count",
    "schema_revision", "account_count",
}
_uuid_fields = {"diagnostic_id", "ledger_request_id", "job_run_id", "attempt_id", "database_generation"}
_symbol_fields = {"operation", "outcome", "state", "code", "plaid_error_code", "plaid_error_type", "update_status", "logger", "method", "phase", "workflow", "decision", "reason", "association_kind", "transaction_status", "previous_status", "payee_source", "category_source", "memo_source", "flag_source", "description_source"}
_integer_fields = {"account_id", "transaction_id", "candidate_id", "relationship_id", "representative_id", "partner_representative_id", "other_transaction_id", "other_candidate_id", "rule_version", "candidate_count", "peer_count", "date_distance", "blocked_count", "sample_count", "omitted_count", "restored_fields", "preserved_fields", "neighborhood_count"}
_boolean_fields = {"has_more", "preserve_review", "history_complete", "initialized", "amount_equal", "inverse_amount", "provider_evidence", "destination_evidence", "currency_equal", "clearance_handoff", "amount_changed", "date_changed", "returned", "source_removed"}


def valid_uuid(value):
    try:
        return str(UUID(value)) if isinstance(value, str) else None
    except ValueError:
        return None


def safe_fields(fields):
    result = {}
    for key, value in fields.items():
        if key in _uuid_fields and (identifier := valid_uuid(value)):
            result[key] = identifier
        elif key in _integer_fields and isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2**63 - 1:
            result[key] = value
        elif key in _numeric_fields and isinstance(value, (int, float)) and not isinstance(value, bool):
            result[key] = round(value, 2)
        elif key in _symbol_fields and isinstance(value, str) and re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_.-]{0,95}", value):
            result[key] = value
        elif key == "plaid_request_id" and isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", value):
            result[key] = value
        elif key == "route" and isinstance(value, str) and re.fullmatch(r"/[a-zA-Z0-9_/{ }:.\-]*", value):
            result[key] = value[:200]
        elif key in _boolean_fields and isinstance(value, bool):
            result[key] = value
    return result


def exception_fields(error):
    chain = []
    seen = set()
    while error is not None and id(error) not in seen and len(chain) < 5:
        seen.add(id(error))
        frames = []
        traceback = error.__traceback__
        while traceback is not None:
            code = traceback.tb_frame.f_code
            frames.append({"file": Path(code.co_filename).name[:100], "function": code.co_name[:100], "line": traceback.tb_lineno})
            traceback = traceback.tb_next
        entry = {"type": type(error).__name__[:100], "frames": frames[-12:]}
        entry.update(safe_fields({"code": getattr(error, "code", None), "status": getattr(error, "status", None)}))
        if isinstance(error, sqlite3.Error):
            entry["sqlite_errorcode"] = getattr(error, "sqlite_errorcode", None)
            entry["sqlite_errorname"] = getattr(error, "sqlite_errorname", None)
        if isinstance(error, OSError):
            entry["errno"] = error.errno
        chain.append(entry)
        error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
    return {"exceptions": chain}


def stored_event(value):
    if not isinstance(value, dict) or not valid_uuid(value.get("event_id")) or not valid_uuid(value.get("boot_id")):
        return None
    if value.get("level") not in ("info", "warning", "error") or not isinstance(value.get("pid"), int):
        return None
    if not isinstance(value.get("event"), str) or not re.fullmatch(r"[a-z][a-z0-9_.]{0,95}", value["event"]):
        return None
    try:
        datetime.fromisoformat(value["time"])
    except (KeyError, TypeError, ValueError):
        return None
    result = {key: value[key] for key in ("time", "event_id", "boot_id", "pid", "level", "event")}
    result.update(safe_fields(value))
    exceptions = []
    for error in value.get("exceptions", [])[:5] if isinstance(value.get("exceptions"), list) else []:
        if not isinstance(error, dict) or not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,99}", str(error.get("type", ""))):
            continue
        frames = []
        for frame in error.get("frames", [])[-12:] if isinstance(error.get("frames"), list) else []:
            if isinstance(frame, dict) and isinstance(frame.get("line"), int) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", str(frame.get("file", ""))) and re.fullmatch(r"[a-zA-Z0-9_<>]{1,100}", str(frame.get("function", ""))):
                frames.append({key: frame[key] for key in ("file", "function", "line")})
        entry = {"type": error["type"], "frames": frames, **safe_fields(error)}
        for key in ("sqlite_errorcode", "errno"):
            if isinstance(error.get(key), int):
                entry[key] = error[key]
        if isinstance(error.get("sqlite_errorname"), str) and re.fullmatch(r"SQLITE_[A-Z_]{1,80}", error["sqlite_errorname"]):
            entry["sqlite_errorname"] = error["sqlite_errorname"]
        exceptions.append(entry)
    if exceptions:
        result["exceptions"] = exceptions
    return result


class PrivateRotatingHandler(RotatingFileHandler):
    def _open(self):
        descriptor = os.open(self.baseFilename, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.fchmod(descriptor, 0o600)
        return os.fdopen(descriptor, self.mode, encoding=self.encoding)

    def handleError(self, record):
        raise


class Diagnostics:
    def __init__(self):
        self.lock = threading.RLock()
        self.recent = deque(maxlen=1500)
        self.important = deque(maxlen=500)
        self.boot_id = str(uuid4())
        self.started_at = datetime.now(UTC).isoformat()
        self.handler = None
        self.directory = None
        self.storage_available = False
        self.storage_warning = False
        self.lifecycle_summaries = OrderedDict()

    def configure(self, directory):
        with self.lock:
            if self.handler is not None:
                try:
                    self.handler.close()
                except OSError:
                    pass
            self.handler = None
            self.directory = Path(directory)
            self.storage_available = False

    def _storage(self):
        if self.handler is None:
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.directory.chmod(0o700)
            for path in self.directory.glob("events.jsonl*"):
                path.chmod(0o600)
            self.handler = PrivateRotatingHandler(self.directory / "events.jsonl", maxBytes=MAX_FILE_BYTES, backupCount=3, encoding="utf-8", delay=True)
            self.handler.setFormatter(logging.Formatter("%(message)s"))

    def emit(self, event, level="info", error=None, **fields):
        try:
            value = {
                "time": datetime.now(UTC).isoformat(), "event_id": str(uuid4()),
                "boot_id": self.boot_id, "pid": os.getpid(), "level": level,
                "event": event, **safe_fields({**_context.get(), **fields}),
            }
            if error is not None:
                value.update(exception_fields(error))
            line = json.dumps(value, separators=(",", ":"), allow_nan=False)
            if len(line.encode()) > MAX_EVENT_BYTES:
                value.pop("exceptions", None)
                line = json.dumps(value, separators=(",", ":"))
            with self.lock:
                (self.important if level in {"warning", "error"} else self.recent).append(value)
                try:
                    sys.stderr.write(line + "\n")
                except (OSError, ValueError):
                    pass
                if self.directory is not None:
                    try:
                        self._storage()
                        record = logging.LogRecord("weft", logging.INFO, "", 0, line, (), None)
                        self.handler.emit(record)
                        self.storage_available = True
                        self.storage_warning = False
                    except Exception:
                        self.storage_available = False
                        if self.handler is not None:
                            try:
                                self.handler.close()
                            except OSError:
                                pass
                        self.handler = None
                        if not self.storage_warning:
                            self.storage_warning = True
                            try:
                                sys.stderr.write('{"level":"warning","event":"diagnostics.storage_unavailable"}\n')
                            except (OSError, ValueError):
                                pass
        except Exception:
            pass

    def publish_lifecycle(self, events, blocks, omitted, generation):
        for fields in events:
            self.emit("lifecycle.decision", **fields)
        for fields in blocks.values():
            key = (fields.get("database_generation"), fields["workflow"], fields.get("account_id"), fields["reason"])
            signature = {key: value for key, value in fields.items() if key not in {"diagnostic_id", "ledger_request_id", "job_run_id"}}
            with self.lock:
                previous = self.lifecycle_summaries.get(key)
                if previous == signature:
                    self.lifecycle_summaries.move_to_end(key)
                    continue
                self.emit("lifecycle.blocked_summary", **fields)
                self.lifecycle_summaries[key] = signature
                self.lifecycle_summaries.move_to_end(key)
                if len(self.lifecycle_summaries) > 1000:
                    self.lifecycle_summaries.popitem(last=False)
        if omitted:
            sample = events[0] if events else next(iter(blocks.values()), {})
            correlation = {key: value for key, value in sample.items() if key in _uuid_fields or key == "item_id"}
            self.emit("lifecycle.omitted", **{**correlation, "database_generation": generation, "omitted_count": omitted})

    def report(self):
        recent = deque(maxlen=1500)
        important = deque(maxlen=500)
        readable = True
        with ExitStack() as files:
            streams = []
            with self.lock:
                memory = [*self.recent, *self.important]
                available = self.storage_available
                if self.directory is not None:
                    for suffix in (".3", ".2", ".1", ""):
                        path = self.directory / f"events.jsonl{suffix}"
                        try:
                            source = files.enter_context(path.open("rb"))
                            streams.append((source, min(MAX_FILE_BYTES, os.fstat(source.fileno()).st_size)))
                        except FileNotFoundError:
                            pass
                        except OSError:
                            readable = False
            for source, remaining in streams:
                while remaining > 0:
                    try:
                        line = source.readline(min(remaining, MAX_EVENT_BYTES + 1))
                    except OSError:
                        readable = False
                        break
                    remaining -= len(line)
                    if not line:
                        break
                    if len(line) > MAX_EVENT_BYTES or not line.endswith(b"\n"):
                        continue
                    try:
                        entry = stored_event(json.loads(line))
                        if entry is not None:
                            (important if entry["level"] in {"warning", "error"} else recent).append(entry)
                    except (ValueError, UnicodeError):
                        continue
        entries = {entry["event_id"]: entry for entry in [*recent, *important, *memory]}
        ordered = sorted(entries.values(), key=lambda entry: entry["time"])
        ordinary = [entry for entry in ordered if entry["level"] not in {"warning", "error"}][-1500:]
        significant = [entry for entry in ordered if entry["level"] in {"warning", "error"}][-500:]
        return {
            "boot_id": self.boot_id, "started_at": self.started_at,
            "storage": "available" if available and readable else "unavailable",
            "limits": {"file_bytes": MAX_FILE_BYTES, "file_count": 4, "ordinary_events": 1500, "warning_error_events": 500},
            "events": sorted([*ordinary, *significant], key=lambda entry: entry["time"]),
        }


diagnostics = Diagnostics()


def lifecycle_fields(workflow, decision, reason, **fields):
    return safe_fields({**_context.get(), **fields, "workflow": workflow, "decision": decision, "reason": reason, "rule_version": LIFECYCLE_RULE_VERSION})


class SafeLogHandler(logging.Handler):
    def emit(self, record):
        if record.levelno < logging.WARNING:
            return
        category = next((name for name in ("uvicorn", "apscheduler", "sqlalchemy") if record.name.startswith(name)), "other")
        diagnostics.emit("runtime.log", "error" if record.levelno >= logging.ERROR else "warning", error=record.exc_info[1] if record.exc_info else None, logger=category)


def configure_diagnostics(db_path, log_dir=None):
    diagnostics.configure(Path(log_dir) if log_dir else Path(db_path).parent / "logs" / Path(db_path).name)
    logging.basicConfig(level=logging.INFO, handlers=[SafeLogHandler()], force=True)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "uvicorn.asgi", "apscheduler", "sqlalchemy"):
        logger = logging.getLogger(name)
        logger.handlers = []
        logger.propagate = True


@contextmanager
def diagnostic_context(**fields):
    token = _context.set({**_context.get(), **safe_fields(fields)})
    try:
        yield
    finally:
        _context.reset(token)


def current_diagnostic_id():
    return _context.get().get("diagnostic_id")


@contextmanager
def operation(name, **fields):
    started = time.perf_counter()
    outcome = {}
    with diagnostic_context(**fields):
        diagnostics.emit("operation.started", operation=name)
        try:
            yield outcome
        except Exception as error:
            outcome.setdefault("code", getattr(error, "code", None))
            diagnostics.emit("operation.failed", "error", error=error, operation=name, duration_ms=(time.perf_counter() - started) * 1000, **outcome)
            raise
        else:
            diagnostics.emit("operation.completed", "warning" if outcome.get("state") in {"failed", "partial"} else "info", operation=name, duration_ms=(time.perf_counter() - started) * 1000, **outcome)


class DiagnosticMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        identifier = valid_uuid(headers.get(b"x-diagnostic-id", b"").decode("latin-1")) or str(uuid4())
        ledger_identifier = valid_uuid(headers.get(b"x-ledger-request", b"").decode("latin-1"))
        scope.setdefault("state", {})["diagnostic_id"] = identifier
        started = time.perf_counter()
        status = 499
        response_started = False
        failed = False
        interrupted = False

        async def correlated_send(message):
            nonlocal status, response_started
            if message["type"] == "http.response.start":
                status = message["status"]
                response_started = True
                message = {**message, "headers": [(key, value) for key, value in message.get("headers", []) if key.lower() != b"x-diagnostic-id"] + [(b"x-diagnostic-id", identifier.encode())]}
            await send(message)

        with diagnostic_context(diagnostic_id=identifier, ledger_request_id=ledger_identifier):
            try:
                await self.app(scope, receive, correlated_send)
            except Exception as error:
                failed = True
                diagnostics.emit("http.unexpected_error", "error", error=error, status=500, phase="response_started" if response_started else "handler")
                if response_started:
                    interrupted = True
                    raise RuntimeError("Response interrupted; consult local diagnostics.") from None
                response = JSONResponse({"error": {"code": "internal_error", "message": "An unexpected error occurred. Download diagnostics from System settings before trying again.", "detail": None}}, status_code=500)
                await response(scope, receive, correlated_send)
            finally:
                route = scope.get("route")
                duration = (time.perf_counter() - started) * 1000
                diagnostics.emit("http.completed", "error" if failed or status >= 500 else "warning" if status >= 400 or duration >= 1000 else "info", method=scope["method"], route=getattr(route, "path", "/static" if isinstance(scope.get("endpoint"), StaticFiles) else "/unmatched"), status=status, duration_ms=duration, outcome="response_interrupted" if interrupted else "returned")

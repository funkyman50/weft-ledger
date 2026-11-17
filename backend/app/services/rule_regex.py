import atexit
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import threading
import time


SEARCH_SECONDS = 0.1
OPERATION_SECONDS = 2.0
TRANSPORT_SECONDS = 2.0
_lock = threading.Lock()
_process: subprocess.Popen | None = None


class EvaluationLimit(Exception):
    pass


class BudgetExhausted(Exception):
    pass


class EvaluatorUnavailable(Exception):
    pass


def _stop() -> None:
    global _process
    process, _process = _process, None
    if process is not None:
        try:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=TRANSPORT_SECONDS)
        finally:
            process.stdin.close()
            process.stdout.close()


def close() -> None:
    with _lock:
        _stop()


def _exchange(pattern: str, text: str, budget: float) -> tuple[bool, float]:
    global _process
    deadline = time.monotonic() + TRANSPORT_SECONDS
    if _process is not None and _process.poll() is not None:
        _stop()
    if _process is None:
        _process = subprocess.Popen(
            [sys.executable, "-I", "-u", str(Path(__file__).resolve())],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={},
            close_fds=True,
            bufsize=0,
        )
        os.set_blocking(_process.stdin.fileno(), False)
        os.set_blocking(_process.stdout.fileno(), False)
    pending = memoryview(json.dumps([pattern, text, budget]).encode() + b"\n")
    while pending:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([], [_process.stdin], [], remaining)[1]:
            raise EvaluatorUnavailable
        try:
            pending = pending[os.write(_process.stdin.fileno(), pending):]
        except BlockingIOError:
            continue
    response = bytearray()
    while not response.endswith(b"\n"):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([_process.stdout], [], [], remaining)[0]:
            raise EvaluatorUnavailable
        chunk = os.read(_process.stdout.fileno(), 128)
        if not chunk or len(response) + len(chunk) > 128:
            raise EvaluatorUnavailable
        response.extend(chunk)
    result, elapsed = json.loads(response)
    if not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or elapsed < 0:
        raise EvaluatorUnavailable
    if result == "limit":
        if budget <= SEARCH_SECONDS:
            raise BudgetExhausted
        raise EvaluationLimit
    if type(result) is not bool:
        raise EvaluatorUnavailable
    return result, elapsed


class EvaluationBudget:
    def __init__(self):
        self.remaining = OPERATION_SECONDS
        self.failed = False

    def search(self, pattern: str, text: str) -> bool:
        if self.failed:
            raise EvaluatorUnavailable
        if self.remaining <= 0:
            raise BudgetExhausted
        acquired = _lock.acquire(timeout=TRANSPORT_SECONDS)
        try:
            if not acquired:
                self.failed = True
                raise EvaluatorUnavailable
            try:
                result, elapsed = _exchange(pattern, text, self.remaining)
                self.remaining -= elapsed
                if self.remaining <= 0:
                    raise BudgetExhausted
                return result
            except (EvaluationLimit, BudgetExhausted):
                self.failed = True
                _stop()
                raise
            except (OSError, ValueError, EvaluatorUnavailable) as error:
                self.failed = True
                _stop()
                raise EvaluatorUnavailable from error
        finally:
            if acquired:
                _lock.release()


def _expired(_signum, _frame):
    raise EvaluationLimit


def _serve() -> None:
    signal.signal(signal.SIGALRM, _expired)
    for line in sys.stdin.buffer:
        start = time.monotonic()
        try:
            pattern, text, budget = json.loads(line)
            start = time.monotonic()
            signal.setitimer(signal.ITIMER_REAL, min(SEARCH_SECONDS, budget))
            result = re.search(pattern, text, re.IGNORECASE) is not None
            signal.setitimer(signal.ITIMER_REAL, 0)
        except EvaluationLimit:
            signal.setitimer(signal.ITIMER_REAL, 0)
            result = "limit"
        except Exception:
            signal.setitimer(signal.ITIMER_REAL, 0)
            result = "unavailable"
        print(json.dumps([result, time.monotonic() - start]), flush=True)


if __name__ == "__main__":
    _serve()
else:
    atexit.register(close)

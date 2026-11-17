import base64
import json

from app.errors import AppError


def encode(value: tuple[int, str, int], *, source_id: int, scope: str, kind: str, destination_id: int | None = None) -> str:
    raw = json.dumps({"v": value, "source": source_id, "scope": scope, "kind": kind, "destination": destination_id}).encode()
    return base64.urlsafe_b64encode(raw).decode()


def decode(value: str, *, source_id: int, scope: str, kind: str, destination_id: int | None = None) -> tuple[int, str, int]:
    try:
        raw = json.loads(base64.urlsafe_b64decode(value.encode()))
        if raw["source"] != source_id or raw["scope"] != scope or raw["kind"] != kind or raw.get("destination") != destination_id:
            raise ValueError
        distance, when, identifier = raw["v"]
        return int(distance), str(when), int(identifier)
    except Exception as error:
        raise AppError(f"{kind}_cursor_invalid", "This candidate search cursor is invalid.", 422) from error

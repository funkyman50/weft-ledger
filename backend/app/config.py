import os
import re
from dataclasses import dataclass


@dataclass
class Settings:
    secret: str
    db_path: str
    log_dir: str | None = None
    openai_callback_port: int = 8000
    plaid_read_only: bool = False


def validate_installation_secret(secret: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", secret):
        raise ValueError("WEFT_SECRET must be a machine-generated 32-byte key encoded as 64 lowercase hexadecimal characters. Preserve existing keys and data; see the credential requirements in docs/OPERATIONS.md.")


def get_settings() -> Settings:
    secret = os.environ.get("WEFT_SECRET", "")
    validate_installation_secret(secret)
    return Settings(
        secret=secret,
        db_path=os.environ["WEFT_DB_PATH"],
        log_dir=os.environ.get("WEFT_LOG_DIR") or None,
        openai_callback_port=int(os.environ.get("WEFT_OPENAI_CALLBACK_PORT", "8000")),
        plaid_read_only=os.environ.get("WEFT_PLAID_READ_ONLY") == "1",
    )

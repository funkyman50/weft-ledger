from datetime import datetime
from decimal import Decimal, InvalidOperation

from app.errors import AppError
from app.models import AccountBalanceObservation
from app.services.account_initialization import MAX_SAFE_CENTS


def balance_cents(value, liability=False):
    if value is None:
        return None
    try:
        decimal = Decimal(str(value))
        if not decimal.is_finite():
            raise ValueError
        amount = int(round(decimal * 100))
        if abs(amount) > MAX_SAFE_CENTS:
            raise ValueError
    except (InvalidOperation, ValueError, OverflowError) as exc:
        raise AppError(
            "plaid_balance_invalid", "The bank supplied an invalid balance.", 502
        ) from exc
    return -amount if liability else amount


def record(db, account, link, values, recorded_at):
    supplied = values.get("last_updated_datetime")
    if isinstance(supplied, str):
        try:
            supplied = datetime.fromisoformat(supplied.replace("Z", "+00:00"))
        except ValueError:
            supplied = None
    if supplied is not None and supplied.tzinfo is not None:
        supplied = supplied.astimezone().replace(tzinfo=None)
    currency = values.get("iso_currency_code")
    observation = AccountBalanceObservation(
        account_id=account.id,
        feed_key=link.balance_history_key,
        current_balance_cents=balance_cents(
            values.get("current"), account.type in ("credit", "loan")
        ),
        currency_code=currency if isinstance(currency, str) else None,
        recorded_at=recorded_at,
        provider_updated_at=supplied,
    )
    db.add(observation)
    return observation

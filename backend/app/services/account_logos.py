import base64
import hashlib
from io import BytesIO

from PIL import Image, ImageOps
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Account, AccountLogo

MAX_PIXELS = 4_000_000
MAX_FILE_BYTES = MAX_PIXELS * 4 + 1024 * 1024
MAX_BASE64_CHARACTERS = 4 * ((MAX_FILE_BYTES + 2) // 3)
MAX_UPLOAD_BYTES = MAX_BASE64_CHARACTERS + 4096
MAX_IMAGE_BYTES = 256 * 1024
ICON_SIZE = 128


class InvalidIcon(ValueError):
    pass


def normalize_image(data: bytes) -> bytes:
    if not data:
        raise ValueError("Choose a nonempty image.")
    try:
        with Image.open(BytesIO(data), formats=["PNG", "JPEG", "WEBP"]) as source:
            if source.width * source.height > MAX_PIXELS:
                raise InvalidIcon("Images must contain at most 4 million pixels.")
            if getattr(source, "n_frames", 1) != 1:
                raise InvalidIcon("Choose a still image, without animation.")
            image = ImageOps.contain(ImageOps.exif_transpose(source).convert("RGBA"), (ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)
            tile = Image.new("RGBA", (ICON_SIZE, ICON_SIZE))
            tile.paste(image, ((ICON_SIZE - image.width) // 2, (ICON_SIZE - image.height) // 2))
            output = BytesIO()
            tile.save(output, format="PNG")
            result = output.getvalue()
            if len(result) > MAX_IMAGE_BYTES:
                raise InvalidIcon("The converted icon is too large.")
            return result
    except InvalidIcon:
        raise
    except Exception as error:
        raise ValueError("Choose a readable PNG, JPEG or WebP image.") from error


def validate_saved_library(connection) -> None:
    for name, digest, data in connection.execute("SELECT name, digest, image FROM account_logos"):
        if not name.strip() or not name.isprintable() or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("The saved icon library contains an invalid image or label.")
        try:
            with Image.open(BytesIO(data), formats=["PNG"]) as image:
                if image.size != (ICON_SIZE, ICON_SIZE) or getattr(image, "n_frames", 1) != 1 or image.mode != "RGBA":
                    raise InvalidIcon("The saved icon library contains an unsupported image.")
                image.load()
        except InvalidIcon:
            raise
        except Exception as error:
            raise ValueError("The saved icon library contains an unreadable image.") from error


def list_logos(db: Session) -> list[dict]:
    usage = select(Account.logo_id, func.count().label("count")).where(Account.logo_id.is_not(None)).group_by(Account.logo_id).subquery()
    return [
        {"id": identifier, "name": name, "use_count": count or 0}
        for identifier, name, count in db.execute(
            select(AccountLogo.id, AccountLogo.name, usage.c.count)
            .outerjoin(usage, usage.c.logo_id == AccountLogo.id)
            .order_by(func.lower(AccountLogo.name), AccountLogo.id)
        )
    ]


def get_logo(db: Session, identifier: str) -> AccountLogo:
    logo = db.get(AccountLogo, identifier)
    if logo is None:
        raise AppError("account_logo_missing", "This icon is no longer in the library. Choose another icon or Use default.", 404)
    return logo


def validate_selection(db: Session, identifier: str | None) -> None:
    if identifier is not None:
        get_logo(db, identifier)


def _label(filename: str) -> str:
    basename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    stem = basename.rsplit(".", 1)[0] if "." in basename else basename
    return "".join(character for character in stem if character.isprintable()).strip()[:80] or "Imported icon"


def import_logo(db: Session, name: str, encoded: str) -> dict:
    try:
        data = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise AppError("account_logo_invalid", "This image could not be read. Choose the file again.", 422) from error
    if len(data) > MAX_FILE_BYTES:
        raise AppError("account_logo_upload_too_large", "This image is too large to process. Try a smaller copy.", 413)
    try:
        image = normalize_image(data)
    except ValueError as error:
        raise AppError("account_logo_invalid", str(error), 422) from error
    digest = hashlib.sha256(image).hexdigest()
    logo = db.scalar(select(AccountLogo).where(AccountLogo.digest == digest).order_by(AccountLogo.id).limit(1))
    reused = logo is not None
    if logo is None:
        logo = AccountLogo(id=digest, name=_label(name), digest=digest, image=image)
        db.add(logo)
        db.flush()
    count = db.scalar(select(func.count(Account.id)).where(Account.logo_id == logo.id))
    return {"logo": {"id": logo.id, "name": logo.name, "use_count": count}, "reused": reused}


def rename_logo(db: Session, identifier: str, name: str) -> list[dict]:
    name = name.strip()
    if not name or len(name) > 80 or not name.isprintable():
        raise AppError("account_logo_name_invalid", "Use 1–80 printable characters for the icon name.", 422)
    logo = get_logo(db, identifier)
    logo.name = name
    db.flush()
    return list_logos(db)


def remove_logo(db: Session, identifier: str) -> list[dict]:
    logo = get_logo(db, identifier)
    if db.scalar(select(Account.id).where(Account.logo_id == identifier).limit(1)) is not None:
        raise AppError("account_logo_in_use", "This icon is used by an account. Change that account's icon before removing it.", 409)
    db.delete(logo)
    db.flush()
    return list_logos(db)

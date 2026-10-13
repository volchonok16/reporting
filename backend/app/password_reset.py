"""Самостоятельный сброс пароля org_user: код на почту учётки."""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.org_models import ORG_USER_STATUS_ACTIVE, Employee, OrgPasswordReset, OrgUser
from app.org_password import hash_password, verify_password
from app.password_reset_mail import MailNotConfigured, MailSendError, send_reset_code

CODE_TTL = timedelta(minutes=15)
REQUEST_WINDOW = timedelta(hours=1)
REQUEST_LIMIT = 5
MIN_PASSWORD_LENGTH = 8
ACCOUNT_MISSING = "Учётная запись с таким логином не найдена."
CODE_SENT = "Код отправлен на почту."
CODE_BAD = "Код неверный или истёк."


class PasswordResetError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _normalize_login(value: str) -> str:
    return value.strip().casefold()


def _active_user(db: Session, email: str) -> OrgUser | None:
    normalized = _normalize_login(email)
    if not normalized:
        return None
    return db.scalar(
        select(OrgUser).where(
            func.lower(OrgUser.email) == normalized,
            OrgUser.status == ORG_USER_STATUS_ACTIVE,
        )
    )


def _digits(code: str) -> str:
    return "".join(ch for ch in code if ch.isdigit())


def _open_code(db: Session, user: OrgUser, digits: str) -> OrgPasswordReset | None:
    now = datetime.now(timezone.utc)
    rows = db.scalars(
        select(OrgPasswordReset)
        .where(
            OrgPasswordReset.org_user_id == user.id,
            OrgPasswordReset.consumed_at.is_(None),
            OrgPasswordReset.expires_at > now,
        )
        .order_by(OrgPasswordReset.created_at.desc())
        .limit(5)
    ).all()
    return next((row for row in rows if verify_password(digits, row.code_hash)), None)


def request_password_reset(db: Session, email: str) -> str:
    normalized = _normalize_login(email)
    if not normalized or "@" not in normalized:
        raise PasswordResetError("Укажите почту учётной записи.")

    user = _active_user(db, normalized)
    if user is None or not user.password_hash:
        raise PasswordResetError(ACCOUNT_MISSING, status_code=404)

    since = datetime.now(timezone.utc) - REQUEST_WINDOW
    recent = db.scalar(
        select(func.count())
        .select_from(OrgPasswordReset)
        .where(OrgPasswordReset.org_user_id == user.id, OrgPasswordReset.created_at >= since)
    )
    if int(recent or 0) >= REQUEST_LIMIT:
        raise PasswordResetError("Слишком много запросов. Попробуйте через час.", status_code=429)

    code = generate_code()
    now = datetime.now(timezone.utc)
    db.execute(
        update(OrgPasswordReset)
        .where(OrgPasswordReset.org_user_id == user.id, OrgPasswordReset.consumed_at.is_(None))
        .values(consumed_at=now)
    )
    db.add(
        OrgPasswordReset(
            org_user_id=user.id,
            code_hash=hash_password(code),
            expires_at=now + CODE_TTL,
        )
    )
    db.commit()
    try:
        send_reset_code(to_email=user.email, code=code)
    except MailNotConfigured as exc:
        raise PasswordResetError("Отправка почты не настроена.", status_code=503) from exc
    except MailSendError as exc:
        raise PasswordResetError("Не удалось отправить письмо. Попробуйте позже.", status_code=502) from exc
    return CODE_SENT


def verify_reset_code(db: Session, *, email: str, code: str) -> None:
    digits = _digits(code)
    if len(digits) != 6:
        raise PasswordResetError("Введите шестизначный код из письма.")
    user = _active_user(db, email)
    if user is None or _open_code(db, user, digits) is None:
        raise PasswordResetError(CODE_BAD)


def confirm_password_reset(
    db: Session,
    *,
    email: str,
    code: str,
    new_login: str,
    new_password: str,
    new_password_repeat: str,
) -> str:
    digits = _digits(code)
    if len(digits) != 6:
        raise PasswordResetError("Введите шестизначный код из письма.")
    password = new_password.strip()
    if password != new_password_repeat.strip():
        raise PasswordResetError("Пароли не совпадают.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordResetError("Новый пароль должен быть не короче 8 символов.")
    login = new_login.strip()
    if "@" not in login:
        raise PasswordResetError("Укажите новый логин — почту учётной записи.")

    user = _active_user(db, email)
    if user is None:
        raise PasswordResetError(CODE_BAD)

    match = _open_code(db, user, digits)
    if match is None:
        raise PasswordResetError(CODE_BAD)

    taken = db.scalar(
        select(OrgUser.id).where(
            func.lower(OrgUser.email) == login.casefold(),
            OrgUser.id != user.id,
        )
    )
    if taken is not None:
        raise PasswordResetError("Логин уже занят.")

    old_login = user.email
    user.email = login
    user.password_hash = hash_password(password)
    user.must_change_password = False
    employee = db.scalar(select(Employee).where(Employee.user_id == user.id))
    if employee is not None and (employee.email or "").strip().casefold() == old_login.strip().casefold():
        employee.email = login
    now = datetime.now(timezone.utc)
    match.consumed_at = now
    db.execute(
        update(OrgPasswordReset)
        .where(
            OrgPasswordReset.org_user_id == user.id,
            OrgPasswordReset.id != match.id,
            OrgPasswordReset.consumed_at.is_(None),
        )
        .values(consumed_at=now)
    )
    db.commit()
    return login

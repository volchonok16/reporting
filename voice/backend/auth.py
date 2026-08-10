from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from typing import Any

from .config import Settings
from .errors import AppError
from .models import (
    PasswordChangeRequest,
    UserCreateRequest,
    UserUpdateRequest,
)
from .storage import Registry, opaque_id


PASSWORD_ITERATIONS = 310_000
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass(frozen=True, slots=True)
class AuthUser:
    id: str
    email: str
    role: str
    can_access_master: bool
    is_active: bool

    @property
    def is_superuser(self) -> bool:
        return self.role == "superuser"

    def payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "email": self.email,
            "role": self.role,
            "canAccessMaster": self.is_superuser or self.can_access_master,
            "isActive": self.is_active,
        }


def _normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not EMAIL_PATTERN.fullmatch(email):
        raise AppError("INVALID_EMAIL", "Укажите корректную почту")
    return email


def _password_hash(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS,
    ).hex()


def _validate_password(password: str) -> None:
    if len(password) < 8:
        raise AppError(
            "WEAK_PASSWORD",
            "Пароль должен содержать не менее 8 символов",
        )
    if not any(char.isalpha() for char in password) or not any(
        char.isdigit() for char in password
    ):
        raise AppError(
            "WEAK_PASSWORD",
            "Пароль должен содержать буквы и цифры",
        )


class AuthService:
    def __init__(self, config: Settings, registry: Registry):
        self.config = config
        self.database_path = registry.database_path
        self._lock = threading.RLock()
        self._initialize()
        self._bootstrap_superuser()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS auth_users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    password_salt TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('superuser', 'standard')),
                    can_access_master INTEGER NOT NULL DEFAULT 0,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    last_seen_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES auth_users(id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS auth_sessions_user
                    ON auth_sessions(user_id, expires_at);
                """
            )

    @staticmethod
    def _user_from_row(row: sqlite3.Row) -> AuthUser:
        return AuthUser(
            id=str(row["id"]),
            email=str(row["email"]),
            role=str(row["role"]),
            can_access_master=bool(row["can_access_master"]),
            is_active=bool(row["is_active"]),
        )

    def _bootstrap_superuser(self) -> None:
        email = _normalize_email(self.config.auth_bootstrap_email)
        password = self.config.auth_bootstrap_password
        _validate_password(password)
        with self._lock, self._connect() as connection:
            existing = connection.execute(
                "SELECT id FROM auth_users WHERE email = ?",
                (email,),
            ).fetchone()
            if existing is not None:
                return
            now = time.time()
            salt = secrets.token_bytes(16)
            connection.execute(
                """
                INSERT INTO auth_users(
                    id, email, password_hash, password_salt, role,
                    can_access_master, is_active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'superuser', 1, 1, ?, ?)
                """,
                (
                    opaque_id(),
                    email,
                    _password_hash(password, salt),
                    salt.hex(),
                    now,
                    now,
                ),
            )

    def _issue_session(self, connection: sqlite3.Connection, user_id: str) -> tuple[str, float]:
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = time.time()
        expires_at = now + self.config.auth_session_seconds
        connection.execute(
            """
            INSERT INTO auth_sessions(
                token_hash, user_id, created_at, last_seen_at, expires_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (token_hash, user_id, now, now, expires_at),
        )
        connection.execute(
            "DELETE FROM auth_sessions WHERE expires_at <= ?",
            (now,),
        )
        return token, expires_at

    def login(self, email: str, password: str) -> dict[str, Any]:
        normalized_email = _normalize_email(email)
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM auth_users WHERE email = ?",
                (normalized_email,),
            ).fetchone()
            if row is None or not bool(row["is_active"]):
                raise AppError(
                    "INVALID_CREDENTIALS",
                    "Неверная почта или пароль",
                    status_code=401,
                )
            expected = str(row["password_hash"])
            actual = _password_hash(
                password,
                bytes.fromhex(str(row["password_salt"])),
            )
            if not hmac.compare_digest(expected, actual):
                raise AppError(
                    "INVALID_CREDENTIALS",
                    "Неверная почта или пароль",
                    status_code=401,
                )
            token, expires_at = self._issue_session(connection, str(row["id"]))
            return {
                "token": token,
                "expiresAt": expires_at,
                "user": self._user_from_row(row).payload(),
            }

    def login_with_reporting_sso(self, *, email: str, is_admin: bool) -> dict[str, Any]:
        """Вход по SSO reporting: один логин, без пароля карусели."""
        normalized_email = _normalize_email(email)
        role = "superuser" if is_admin else "standard"
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM auth_users WHERE email = ?",
                (normalized_email,),
            ).fetchone()
            now = time.time()
            if row is None:
                salt = secrets.token_bytes(16)
                # Пароль случайный — вход только через reporting SSO
                random_password = secrets.token_urlsafe(24) + "Aa1"
                user_id = opaque_id()
                connection.execute(
                    """
                    INSERT INTO auth_users(
                        id, email, password_hash, password_salt, role,
                        can_access_master, is_active, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
                    """,
                    (
                        user_id,
                        normalized_email,
                        _password_hash(random_password, salt),
                        salt.hex(),
                        role,
                        now,
                        now,
                    ),
                )
            else:
                user_id = str(row["id"])
                if not bool(row["is_active"]):
                    raise AppError(
                        "INVALID_CREDENTIALS",
                        "Учётная запись отключена",
                        status_code=401,
                    )
                connection.execute(
                    """
                    UPDATE auth_users
                    SET role = ?,
                        can_access_master = 1,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (role, now, user_id),
                )
            row = connection.execute(
                "SELECT * FROM auth_users WHERE id = ?",
                (user_id,),
            ).fetchone()
            assert row is not None
            token, expires_at = self._issue_session(connection, user_id)
            return {
                "token": token,
                "expiresAt": expires_at,
                "user": self._user_from_row(row).payload(),
            }

    def authenticate(self, token: str | None) -> AuthUser:
        if not token:
            raise AppError(
                "AUTH_REQUIRED",
                "Необходимо войти в приложение",
                status_code=401,
            )
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute(
                "DELETE FROM auth_sessions WHERE expires_at <= ?",
                (now,),
            )
            row = connection.execute(
                """
                SELECT user.*
                FROM auth_sessions AS session
                JOIN auth_users AS user ON user.id = session.user_id
                WHERE session.token_hash = ?
                  AND session.expires_at > ?
                  AND user.is_active = 1
                """,
                (token_hash, now),
            ).fetchone()
            if row is None:
                raise AppError(
                    "AUTH_REQUIRED",
                    "Сессия истекла. Войдите снова",
                    status_code=401,
                )
            connection.execute(
                """
                UPDATE auth_sessions
                SET last_seen_at = ?
                WHERE token_hash = ?
                """,
                (now, token_hash),
            )
            return self._user_from_row(row)

    def logout(self, token: str) -> None:
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with self._lock, self._connect() as connection:
            connection.execute(
                "DELETE FROM auth_sessions WHERE token_hash = ?",
                (token_hash,),
            )

    def list_users(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            return [
                self._user_from_row(row).payload()
                for row in connection.execute(
                    """
                    SELECT * FROM auth_users
                    ORDER BY
                        CASE role WHEN 'superuser' THEN 0 ELSE 1 END,
                        email COLLATE NOCASE
                    """
                )
            ]

    def create_user(self, body: UserCreateRequest) -> dict[str, Any]:
        email = _normalize_email(body.email)
        _validate_password(body.password)
        now = time.time()
        salt = secrets.token_bytes(16)
        can_access_master = body.canAccessMaster or body.role == "superuser"
        with self._lock, self._connect() as connection:
            try:
                user_id = opaque_id()
                connection.execute(
                    """
                    INSERT INTO auth_users(
                        id, email, password_hash, password_salt, role,
                        can_access_master, is_active, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        user_id,
                        email,
                        _password_hash(body.password, salt),
                        salt.hex(),
                        body.role,
                        int(can_access_master),
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise AppError(
                    "USER_EXISTS",
                    "Пользователь с такой почтой уже существует",
                    status_code=409,
                ) from exc
            row = connection.execute(
                "SELECT * FROM auth_users WHERE id = ?",
                (user_id,),
            ).fetchone()
            assert row is not None
            return self._user_from_row(row).payload()

    def update_user(
        self,
        user_id: str,
        body: UserUpdateRequest,
        *,
        actor_id: str,
    ) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM auth_users WHERE id = ?",
                (user_id,),
            ).fetchone()
            if row is None:
                raise AppError(
                    "USER_NOT_FOUND",
                    "Пользователь не найден",
                    status_code=404,
                )
            next_role = body.role or str(row["role"])
            next_active = (
                body.isActive
                if body.isActive is not None
                else bool(row["is_active"])
            )
            if user_id == actor_id and (
                next_role != "superuser" or not next_active
            ):
                raise AppError(
                    "CANNOT_RESTRICT_SELF",
                    "Нельзя снять собственные права суперюзера",
                )
            next_master = (
                body.canAccessMaster
                if body.canAccessMaster is not None
                else bool(row["can_access_master"])
            )
            if next_role == "superuser":
                next_master = True
            fields: list[str] = [
                "role = ?",
                "can_access_master = ?",
                "is_active = ?",
                "updated_at = ?",
            ]
            values: list[Any] = [
                next_role,
                int(next_master),
                int(next_active),
                time.time(),
            ]
            if body.password is not None:
                _validate_password(body.password)
                salt = secrets.token_bytes(16)
                fields.extend(["password_hash = ?", "password_salt = ?"])
                values.extend(
                    [
                        _password_hash(body.password, salt),
                        salt.hex(),
                    ]
                )
            values.append(user_id)
            connection.execute(
                f"UPDATE auth_users SET {', '.join(fields)} WHERE id = ?",
                values,
            )
            if not next_active or body.password is not None:
                connection.execute(
                    "DELETE FROM auth_sessions WHERE user_id = ?",
                    (user_id,),
                )
            updated = connection.execute(
                "SELECT * FROM auth_users WHERE id = ?",
                (user_id,),
            ).fetchone()
            assert updated is not None
            return self._user_from_row(updated).payload()

    def change_password(
        self,
        user: AuthUser,
        body: PasswordChangeRequest,
        token: str,
    ) -> None:
        _validate_password(body.newPassword)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM auth_users WHERE id = ?",
                (user.id,),
            ).fetchone()
            assert row is not None
            actual = _password_hash(
                body.currentPassword,
                bytes.fromhex(str(row["password_salt"])),
            )
            if not hmac.compare_digest(str(row["password_hash"]), actual):
                raise AppError(
                    "INVALID_CURRENT_PASSWORD",
                    "Текущий пароль указан неверно",
                )
            salt = secrets.token_bytes(16)
            connection.execute(
                """
                UPDATE auth_users
                SET password_hash = ?, password_salt = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    _password_hash(body.newPassword, salt),
                    salt.hex(),
                    time.time(),
                    user.id,
                ),
            )
            connection.execute(
                """
                DELETE FROM auth_sessions
                WHERE user_id = ? AND token_hash <> ?
                """,
                (user.id, token_hash),
            )

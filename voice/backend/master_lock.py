from __future__ import annotations

import hashlib
import threading
import time
from typing import Any

from .auth import AuthService, AuthUser
from .errors import AppError
from .pg_db import PgConnection, PgRow, configure as configure_master_db, connect as pg_connect
from .reporting_sso import verify_voice_session_token
from .storage import Registry


class MasterLockService:
    """Persistent exclusive edit lock for the master database (Postgres)."""

    def __init__(
        self,
        registry: Registry,
        auth_service: AuthService,
        database_url: str | None = None,
    ):
        self.registry = registry
        self.auth_service = auth_service
        self._database_url = database_url
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> PgConnection:
        if self._database_url:
            configure_master_db(self._database_url)
        else:
            configure_master_db()
        return pg_connect()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("SELECT 1 FROM master_edit_lock WHERE id = 1")

    @staticmethod
    def _token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def _payload(
        row: PgRow | None,
        current_user: AuthUser,
        current_session_hash: str,
    ) -> dict[str, Any]:
        if row is None:
            return {
                "locked": False,
                "ownedByCurrentUser": False,
                "ownedByCurrentSession": False,
                "owner": None,
                "acquiredAt": None,
                "notification": None,
            }
        owner_id = str(row["owner_user_id"])
        owned_by_current_user = owner_id == current_user.id
        owned_by_current_session = (
            owned_by_current_user
            and str(row["owner_session_hash"]) == current_session_hash
        )
        notification = None
        if (
            owned_by_current_user
            and int(row["notification_sequence"] or 0) > 0
            and row["notification_kind"]
            and row["notification_created_at"] is not None
        ):
            notification = {
                "id": (
                    f"{int(float(row['acquired_at']) * 1000)}:"
                    f"{int(row['notification_sequence'])}"
                ),
                "kind": str(row["notification_kind"]),
                "requester": {
                    "id": str(row["notification_requester_id"] or ""),
                    "email": str(row["notification_requester_email"] or ""),
                },
                "createdAt": float(row["notification_created_at"]),
            }
        return {
            "locked": True,
            "ownedByCurrentUser": owned_by_current_user,
            "ownedByCurrentSession": owned_by_current_session,
            "owner": {
                "id": owner_id,
                "email": str(row["owner_email"]),
            },
            "acquiredAt": float(row["acquired_at"]),
            "notification": notification,
        }

    def _auth_owner_valid(
        self,
        owner_user_id: str,
        owner_session_hash: str,
        owner_session_expires_at: float | None,
        owner_email: str,
    ) -> tuple[bool, str]:
        if owner_session_expires_at is not None and time.time() > float(
            owner_session_expires_at
        ):
            return False, ""
        if owner_email:
            return True, owner_email
        return False, ""

    def _owner_row(self, connection: PgConnection) -> PgRow | None:
        row = connection.execute(
            """
            SELECT
                owner_user_id,
                owner_session_hash,
                owner_email,
                acquired_at,
                owner_session_expires_at,
                notification_sequence,
                notification_kind,
                notification_requester_id,
                notification_requester_email,
                notification_created_at
            FROM master_edit_lock
            WHERE id = 1
            """
        ).fetchone()
        if row is None:
            return None
        ok, email = self._auth_owner_valid(
            str(row["owner_user_id"]),
            str(row["owner_session_hash"]),
            row["owner_session_expires_at"],
            str(row["owner_email"] or ""),
        )
        if not ok:
            connection.execute("DELETE FROM master_edit_lock WHERE id = 1")
            return None
        if email and email != str(row["owner_email"] or ""):
            connection.execute(
                "UPDATE master_edit_lock SET owner_email = ? WHERE id = 1",
                (email,),
            )
            row["owner_email"] = email
        return row

    def status(
        self,
        current_user: AuthUser,
        token: str,
    ) -> dict[str, Any]:
        session_hash = self._token_hash(token)
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            return self._payload(
                self._owner_row(connection),
                current_user,
                session_hash,
            )

    def acquire(
        self,
        current_user: AuthUser,
        token: str,
    ) -> dict[str, Any]:
        session_hash = self._token_hash(token)
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._owner_row(connection)
            if row is not None:
                if str(row["owner_session_hash"]) == session_hash:
                    return self._payload(row, current_user, session_hash)
                if str(row["owner_user_id"]) == current_user.id:
                    connection.execute(
                        """
                        UPDATE master_edit_lock
                        SET owner_session_hash = ?,
                            owner_email = ?,
                            notification_sequence = 0,
                            notification_kind = NULL,
                            notification_requester_id = NULL,
                            notification_requester_email = NULL,
                            notification_created_at = NULL
                        WHERE id = 1
                        """,
                        (session_hash, current_user.email),
                    )
                    reclaimed = self._owner_row(connection)
                    assert reclaimed is not None
                    return self._payload(
                        reclaimed, current_user, session_hash
                    )
                raise AppError(
                    "MASTER_LOCKED",
                    (
                        "Мастер-файл занят пользователем "
                        f"{row['owner_email']}"
                    ),
                    status_code=423,
                )
            session_exp = self.auth_service.session_expires_at(token)
            if session_exp is None:
                try:
                    session_exp = float(verify_voice_session_token(token).get("exp") or 0)
                except ValueError:
                    session_exp = None
            connection.execute(
                """
                INSERT INTO master_edit_lock(
                    id, owner_user_id, owner_session_hash, owner_email,
                    acquired_at, owner_session_expires_at
                ) VALUES (1, ?, ?, ?, ?, ?)
                """,
                (
                    current_user.id,
                    session_hash,
                    current_user.email,
                    time.time(),
                    session_exp,
                ),
            )
            acquired = self._owner_row(connection)
            assert acquired is not None
            return self._payload(acquired, current_user, session_hash)

    def release(
        self,
        current_user: AuthUser,
        token: str,
        *,
        force: bool = False,
    ) -> dict[str, Any]:
        session_hash = self._token_hash(token)
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._owner_row(connection)
            if row is None:
                return self._payload(None, current_user, session_hash)
            same_user = str(row["owner_user_id"]) == current_user.id
            if not same_user and not (force and current_user.is_superuser):
                raise AppError(
                    "MASTER_LOCKED",
                    (
                        "Мастер-файл занят пользователем "
                        f"{row['owner_email']}"
                    ),
                    status_code=423,
                )
            connection.execute("DELETE FROM master_edit_lock WHERE id = 1")
            return self._payload(None, current_user, session_hash)

    def notify_owner(
        self,
        current_user: AuthUser,
        token: str,
        kind: str,
    ) -> dict[str, Any]:
        if kind not in {"reminder", "upload_attempt"}:
            raise AppError(
                "INVALID_LOCK_NOTIFICATION",
                "Неизвестный тип уведомления",
            )
        session_hash = self._token_hash(token)
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._owner_row(connection)
            if row is None:
                raise AppError(
                    "MASTER_LOCK_FREE",
                    "Мастер-файл уже свободен",
                    status_code=409,
                )
            if str(row["owner_user_id"]) == current_user.id:
                raise AppError(
                    "MASTER_LOCK_OWNED",
                    (
                        "Мастер-файл уже занят вами. "
                        "Нажмите «Перехватить» или «Освободить»."
                    ),
                    status_code=409,
                )
            sequence = int(row["notification_sequence"] or 0) + 1
            created_at = time.time()
            connection.execute(
                """
                UPDATE master_edit_lock
                SET notification_sequence = ?, notification_kind = ?,
                    notification_requester_id = ?,
                    notification_requester_email = ?,
                    notification_created_at = ?
                WHERE id = 1
                """,
                (
                    sequence,
                    kind,
                    current_user.id,
                    current_user.email,
                    created_at,
                ),
            )
            return {
                "notified": True,
                "owner": {
                    "id": str(row["owner_user_id"]),
                    "email": str(row["owner_email"]),
                },
                "notificationId": (
                    f"{int(float(row['acquired_at']) * 1000)}:{sequence}"
                ),
                "createdAt": created_at,
                "delivery": "in_app_master_page",
                "message": (
                    "Напоминание появится у владельца на странице мастер-файла, "
                    "если у него открыт Voice. Отдельного колокольчика в портале нет."
                ),
            }

    def require_owner(
        self,
        current_user: AuthUser,
        token: str,
    ) -> None:
        session_hash = self._token_hash(token)
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._owner_row(connection)
            if row is None:
                raise AppError(
                    "MASTER_LOCK_REQUIRED",
                    "Сначала займите мастер-файл",
                    status_code=423,
                )
            if str(row["owner_session_hash"]) == session_hash:
                return
            if str(row["owner_user_id"]) == current_user.id:
                raise AppError(
                    "MASTER_LOCK_RECLAIM_REQUIRED",
                    (
                        "Мастер-файл занят вами в другой сессии. "
                        "Нажмите «Перехватить», чтобы продолжить здесь."
                    ),
                    status_code=423,
                )
            raise AppError(
                "MASTER_LOCKED",
                (
                    "Мастер-файл занят пользователем "
                    f"{row['owner_email']}"
                ),
                status_code=423,
            )

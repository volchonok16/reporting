from __future__ import annotations

import hashlib
import sqlite3
from dataclasses import replace

import pytest

from backend.auth import AuthService
from backend.config import settings
from backend.errors import AppError
from backend.master_lock import MasterLockService
from backend.models import UserCreateRequest
from backend.storage import Registry


def test_master_lock_is_exclusive_and_persists(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    auth = AuthService(config, registry)
    lock = MasterLockService(registry)

    owner_login = auth.login(
        config.auth_bootstrap_email,
        config.auth_bootstrap_password,
    )
    owner_token = owner_login["token"]
    owner = auth.authenticate(owner_token)
    other_payload = auth.create_user(
        UserCreateRequest(
            email="editor@example.test",
            password="Editor-2026!",
            role="standard",
            canAccessMaster=True,
        )
    )
    other_login = auth.login(other_payload["email"], "Editor-2026!")
    other_token = other_login["token"]
    other = auth.authenticate(other_token)

    assert lock.status(owner, owner_token) == {
        "locked": False,
        "ownedByCurrentUser": False,
        "owner": None,
        "acquiredAt": None,
        "notification": None,
    }

    acquired = lock.acquire(owner, owner_token)
    assert acquired["locked"] is True
    assert acquired["ownedByCurrentUser"] is True
    assert acquired["owner"]["email"] == owner.email

    restarted_service = MasterLockService(registry)
    occupied = restarted_service.status(other, other_token)
    assert occupied["locked"] is True
    assert occupied["ownedByCurrentUser"] is False
    assert occupied["owner"]["email"] == owner.email
    assert occupied["acquiredAt"] == acquired["acquiredAt"]
    notified = restarted_service.notify_owner(
        other, other_token, "reminder"
    )
    assert notified["notified"] is True
    owner_notification = restarted_service.status(owner, owner_token)[
        "notification"
    ]
    assert owner_notification["kind"] == "reminder"
    assert owner_notification["requester"]["email"] == other.email
    upload_notification = restarted_service.notify_owner(
        other, other_token, "upload_attempt"
    )
    assert upload_notification["notificationId"] != notified["notificationId"]
    assert restarted_service.status(owner, owner_token)["notification"][
        "kind"
    ] == "upload_attempt"

    second_owner_login = auth.login(
        config.auth_bootstrap_email,
        config.auth_bootstrap_password,
    )
    second_owner_token = second_owner_login["token"]
    second_owner = auth.authenticate(second_owner_token)
    assert (
        restarted_service.status(second_owner, second_owner_token)[
            "ownedByCurrentUser"
        ]
        is False
    )

    with pytest.raises(AppError) as acquire_error:
        restarted_service.acquire(other, other_token)
    assert acquire_error.value.code == "MASTER_LOCKED"
    assert acquire_error.value.status_code == 423
    assert owner.email in acquire_error.value.message

    with pytest.raises(AppError) as action_error:
        restarted_service.require_owner(other, other_token)
    assert action_error.value.code == "MASTER_LOCKED"
    restarted_service.require_owner(owner, owner_token)

    with pytest.raises(AppError) as release_error:
        restarted_service.release(other, other_token)
    assert release_error.value.code == "MASTER_LOCKED"

    auth.logout(owner_token)
    released_after_logout = restarted_service.status(other, other_token)
    assert released_after_logout["locked"] is False

    acquired_by_other = restarted_service.acquire(other, other_token)
    assert acquired_by_other["ownedByCurrentUser"] is True
    other_session_hash = hashlib.sha256(other_token.encode()).hexdigest()
    with sqlite3.connect(registry.database_path) as connection:
        connection.execute(
            "UPDATE auth_sessions SET expires_at = 0 WHERE token_hash = ?",
            (other_session_hash,),
        )
    released_after_expiry = restarted_service.status(
        second_owner,
        second_owner_token,
    )
    assert released_after_expiry["locked"] is False

    with pytest.raises(AppError) as missing_lock:
        restarted_service.require_owner(second_owner, second_owner_token)
    assert missing_lock.value.code == "MASTER_LOCK_REQUIRED"

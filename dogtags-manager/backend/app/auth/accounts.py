import hashlib
import secrets
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from argon2.low_level import Type
from sqlalchemy import select, text

from app.models import Session, User, utcnow

PERMISSIONS = ("case.read", "case.edit", "package.approve", "profile.override")
ALLOWED_PERMISSIONS = (*PERMISSIONS, "rules.publish")
PASSWORD_MAX_LENGTH = 1024
password_hasher = PasswordHasher(type=Type.ID)
_dummy_hash = password_hasher.hash(secrets.token_urlsafe(32))


def token_digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def local_operator(db):
    """Keep the existing workspace owner; bootstrap an empty installation once."""
    statement = select(User).where(User.active.is_(True)).order_by(User.created_at, User.id).limit(1)
    user = db.scalar(statement)
    if user is None:
        db.execute(text('SELECT pg_advisory_xact_lock(74109281)'))
        user = db.scalar(statement)
        if user is None:
            user = create_account(db, 'local-' + secrets.token_hex(8), secrets.token_urlsafe(48),
                                  permissions=ALLOWED_PERMISSIONS)
            db.commit()
    return user


def create_account(db, username, password, permissions=PERMISSIONS):
    if not username or len(username) > 120 or not password or len(password) > PASSWORD_MAX_LENGTH:
        raise ValueError("The account name and password must match the login contract.")
    if not set(permissions).issubset(ALLOWED_PERMISSIONS):
        raise ValueError("Unknown account permission.")
    user = User(username=username, password_hash=password_hasher.hash(password), permissions=list(permissions))
    db.add(user)
    db.flush()
    return user


def verify_password(user, password):
    try:
        valid = password_hasher.verify(user.password_hash if user else _dummy_hash, password)
        return bool(user and user.active and valid)
    except (VerificationError, InvalidHashError):
        return False


def new_session(db, settings, user_id=None):
    token = secrets.token_urlsafe(48)
    session = Session(token_digest=token_digest(token), csrf_token=secrets.token_urlsafe(32), user_id=user_id,
                      expires_at=utcnow() + timedelta(seconds=(settings.session_seconds if user_id
                                                              else settings.challenge_seconds)))
    db.add(session)
    db.flush()
    return session, token


def set_session_cookie(response, token, settings, secure, authenticated):
    response.set_cookie(settings.cookie_name, token, httponly=True, samesite="strict", secure=secure,
                        max_age=settings.session_seconds if authenticated else settings.challenge_seconds,
                        path="/")

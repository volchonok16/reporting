"""Initialize persistent installation secrets, then load them only in consumer processes."""
from __future__ import annotations

import fcntl
import os
from pathlib import Path
import secrets
import stat
import sys
import tempfile


class SecretError(Exception):
    pass


def read_secret(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
                raise SecretError("Secret must be a private regular file.")
            value = stream.read(65537)
    except OSError:
        raise SecretError("Cannot read the installation secret.") from None
    if not value or len(value) > 65536 or any(c in value for c in "\r\n\0"):
        raise SecretError("Installation secret is empty or invalid.")
    return value


def initialize(postgres_dir, rabbitmq_dir, postgres_data, rabbitmq_data, *,
               postgres_password=None, rabbitmq_password=None, uid=10001, gid=10001):
    entries = (
        (Path(postgres_dir), postgres_password, (Path(postgres_data) / "PG_VERSION").exists(),
         "REPORTING_DOGTAGS_POSTGRES_PASSWORD"),
        (Path(rabbitmq_dir), rabbitmq_password, (Path(rabbitmq_data) / "mnesia").exists(),
         "REPORTING_DOGTAGS_RABBITMQ_PASSWORD"),
    )
    # Lock both volumes in a fixed order; concurrent starts cannot generate different credentials.
    from contextlib import ExitStack
    with ExitStack() as locks:
        pending = []
        for directory, configured, existing_data, setting in entries:
            if directory.is_symlink():
                raise SecretError("Secret directory must not be a symlink.")
            directory.mkdir(parents=True, exist_ok=True)
            os.chown(directory, uid, gid)
            directory.chmod(0o700)
            lock_fd = os.open(directory / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            lock = locks.enter_context(os.fdopen(lock_fd, "a"))
            fcntl.flock(lock, fcntl.LOCK_EX)
            target = directory / "password"
            if target.exists() or target.is_symlink():
                stored = read_secret(target)
                if configured and not secrets.compare_digest(configured.encode(), stored.encode()):
                    raise SecretError(setting + " differs from the saved secret; automatic rotation is refused.")
                continue
            if existing_data and not configured:
                raise SecretError("Existing data needs its original " + setting + " for one-time import.")
            value = configured or secrets.token_urlsafe(48)
            if any(c in value for c in "\r\n\0"):
                raise SecretError(setting + " contains unsupported line breaks.")
            pending.append((target, value))
        # Validate every existing installation before writing either new credential.
        for target, value in pending:
            descriptor, temporary = tempfile.mkstemp(dir=target.parent, prefix=".password-")
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    os.fchown(stream.fileno(), uid, gid)
                    os.fchmod(stream.fileno(), 0o400)
                    stream.write(value)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.link(temporary, target, follow_symlinks=False)
                directory_fd = os.open(target.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            finally:
                os.unlink(temporary)


def main():
    try:
        mode, *command = sys.argv[1:]
        if mode == "init":
            initialize(
                "/run/dogtags-postgres", "/run/dogtags-rabbitmq",
                "/existing-postgres", "/existing-rabbitmq",
                postgres_password=os.environ.get("REPORTING_DOGTAGS_POSTGRES_PASSWORD"),
                rabbitmq_password=os.environ.get("REPORTING_DOGTAGS_RABBITMQ_PASSWORD"),
            )
            print("Dogtags installation secrets are ready.")
        elif mode == "run" and command:
            environment = os.environ.copy()
            for key in ("POSTGRES_PASSWORD", "RABBITMQ_PASSWORD"):
                if path := environment.pop(key + "_FILE", None):
                    environment[key] = read_secret(path)
            if environment.get("APP_ORIGIN"):
                environment["APP_ORIGIN"] = environment["APP_ORIGIN"].rstrip("/")
            os.execvpe(command[0], command, environment)
        else:
            raise SecretError("Expected init or run followed by a command.")
    except (SecretError, OSError) as error:
        # Never print environment, command contents or secret values.
        message = str(error) if isinstance(error, SecretError) else "Installation secret setup failed."
        print(message, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

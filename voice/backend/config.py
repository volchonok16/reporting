from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = int(raw)
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    data_dir: Path
    cors_origins: tuple[str, ...]
    max_upload_bytes: int
    max_master_rows: int
    max_archive_members: int
    max_uncompressed_bytes: int
    max_compression_ratio: int
    job_workers: int
    object_ttl_seconds: int
    cleanup_interval_seconds: int
    preview_limit: int
    auth_bootstrap_email: str
    auth_bootstrap_password: str
    auth_session_seconds: int

    @classmethod
    def from_env(cls) -> "Settings":
        data_dir = Path(
            os.getenv(
                "CAROUSEL_DATA_DIR",
                str(Path(tempfile.gettempdir()) / "carousel-ab-backend"),
            )
        ).resolve()
        return cls(
            data_dir=data_dir,
            cors_origins=tuple(
                origin.strip()
                for origin in os.getenv(
                    "CAROUSEL_CORS_ORIGINS",
                    "http://localhost:3000,http://localhost:5173",
                ).split(",")
                if origin.strip()
            ),
            max_upload_bytes=_positive_int(
                "CAROUSEL_MAX_UPLOAD_BYTES", 8 * 1024 * 1024 * 1024
            ),
            max_master_rows=_positive_int(
                "CAROUSEL_MAX_MASTER_ROWS", 20_000_000
            ),
            max_archive_members=_positive_int("CAROUSEL_MAX_ARCHIVE_MEMBERS", 20_000),
            max_uncompressed_bytes=_positive_int(
                "CAROUSEL_MAX_UNCOMPRESSED_BYTES", 2 * 1024 * 1024 * 1024
            ),
            max_compression_ratio=_positive_int(
                "CAROUSEL_MAX_COMPRESSION_RATIO", 200
            ),
            job_workers=_positive_int("CAROUSEL_JOB_WORKERS", 2),
            object_ttl_seconds=_positive_int(
                "CAROUSEL_OBJECT_TTL_SECONDS", 24 * 60 * 60
            ),
            cleanup_interval_seconds=_positive_int(
                "CAROUSEL_CLEANUP_INTERVAL_SECONDS", 5 * 60
            ),
            preview_limit=_positive_int("CAROUSEL_PREVIEW_LIMIT", 100),
            auth_bootstrap_email=(
                os.getenv("CAROUSEL_AUTH_BOOTSTRAP_EMAIL") or "admin@t2.local"
            ).strip().lower(),
            auth_bootstrap_password=(
                os.getenv("CAROUSEL_AUTH_BOOTSTRAP_PASSWORD") or "T2-Admin-2026!"
            ),
            auth_session_seconds=_positive_int(
                "CAROUSEL_AUTH_SESSION_SECONDS",
                12 * 60 * 60,
            ),
        )


settings = Settings.from_env()

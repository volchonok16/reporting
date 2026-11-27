import os
from dataclasses import dataclass, field
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from sqlalchemy import URL


def loopback_host(host: str | None) -> bool:
    if host == "localhost":
        return True
    try:
        return ip_address(host or "").is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Settings:
    database_url: str | URL = field(repr=False)
    storage_root: Path = Path("runtime/artifacts")
    origins: tuple[str, ...] = ("http://127.0.0.1:8000",)
    timezone: str = "Europe/Moscow"
    max_upload_bytes: int = 256 * 1024 * 1024
    excel_max_uncompressed_bytes: int = 1024 * 1024 * 1024
    excel_max_members: int = 10000
    excel_max_cells: int = 20_000_000
    excel_max_shared_strings_bytes: int = 64 * 1024 * 1024
    multipart_overhead_bytes: int = 1024 * 1024
    session_seconds: int = 12 * 60 * 60
    challenge_seconds: int = 10 * 60
    cookie_name: str = "dogtags_session"
    local_access: bool = True
    dataset_memory_limit: str = "1GiB"
    dataset_threads: int = 1
    broker_url: str | None = field(default=None, repr=False)
    processing_queue: str = "dogtags.processing"
    scratch_root: Path = Path("runtime/scratch")
    scratch_min_free_bytes: int = 64 * 1024 * 1024
    scratch_reservation_bytes: int = 1024 * 1024 * 1024
    page_size: int = 500
    max_page_size: int = 500
    lease_seconds: float = 60
    heartbeat_seconds: float = 10
    max_job_attempts: int = 3
    retry_backoff_seconds: float = 10
    recovery_interval_seconds: float = 10
    broker_timeout_seconds: float = 5

    def __post_init__(self):
        ZoneInfo(self.timezone)
        if self.max_upload_bytes <= 0 or self.multipart_overhead_bytes <= 0:
            raise ValueError("Upload limits must be positive.")
        if min(self.excel_max_uncompressed_bytes, self.excel_max_members, self.excel_max_cells,
               self.excel_max_shared_strings_bytes) <= 0:
            raise ValueError("Excel resource limits must be positive.")
        if self.dataset_threads < 1:
            raise ValueError("Dataset threads must be positive.")
        if (not 1 <= self.page_size <= self.max_page_size or self.max_page_size > 1000
                or self.scratch_min_free_bytes < 0 or self.scratch_reservation_bytes <= 0
                or self.max_job_attempts < 1
                or not 0 < self.heartbeat_seconds < self.lease_seconds
                or min(self.retry_backoff_seconds, self.recovery_interval_seconds,
                       self.broker_timeout_seconds) <= 0):
            raise ValueError("Processing limits and intervals must be positive and bounded.")
        for origin in self.origins:
            parsed = urlsplit(origin)
            if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                    or parsed.path or parsed.query or parsed.fragment or parsed.username
                    or (parsed.scheme == "http" and not loopback_host(parsed.hostname))):
                raise ValueError("Origins must be explicit HTTPS or loopback HTTP origins.")

    @classmethod
    def from_environment(cls):
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            database_url = URL.create(
                "postgresql+psycopg", username=os.environ.get("POSTGRES_USER", "dogtags"),
                password=os.environ.get("POSTGRES_PASSWORD"),
                host=os.environ.get("POSTGRES_HOST", "127.0.0.1"),
                port=int(os.environ.get("POSTGRES_PORT", "5432")),
                database=os.environ.get("POSTGRES_DB", "dogtags"),
            )
        origins = tuple(filter(None, (
            os.environ.get("APP_ORIGIN", "http://127.0.0.1:8000"),
            os.environ.get("DEV_ORIGIN"),
        )))
        broker_url = os.environ.get("BROKER_URL")
        if not broker_url and os.environ.get("RABBITMQ_PASSWORD"):
            from urllib.parse import quote
            broker_url = ("amqp://" + quote(os.environ.get("RABBITMQ_USER", "guest"), safe="") + ":"
                          + quote(os.environ["RABBITMQ_PASSWORD"], safe="") + "@"
                          + os.environ.get("RABBITMQ_HOST", "127.0.0.1") + ":"
                          + os.environ.get("RABBITMQ_PORT", "5672") + "//")
        return cls(database_url=database_url, origins=origins,
                   storage_root=Path(os.environ.get("STORAGE_ROOT", "runtime/artifacts")),
                   broker_url=broker_url,
                   processing_queue=os.environ.get("PROCESSING_QUEUE", "dogtags.processing"),
                   scratch_root=Path(os.environ.get("SCRATCH_ROOT", "runtime/scratch")),
                   scratch_min_free_bytes=int(os.environ.get("SCRATCH_MIN_FREE_BYTES", str(64 * 1024 * 1024))),
                   scratch_reservation_bytes=int(os.environ.get("SCRATCH_RESERVATION_BYTES", str(1024**3))),
                   page_size=int(os.environ.get("PAGE_SIZE", "500")),
                   max_page_size=int(os.environ.get("MAX_PAGE_SIZE", "500")),
                   lease_seconds=float(os.environ.get("LEASE_SECONDS", "60")),
                   heartbeat_seconds=float(os.environ.get("HEARTBEAT_SECONDS", "10")),
                   max_job_attempts=int(os.environ.get("MAX_JOB_ATTEMPTS", "3")),
                   retry_backoff_seconds=float(os.environ.get("RETRY_BACKOFF_SECONDS", "10")),
                   recovery_interval_seconds=float(os.environ.get("RECOVERY_INTERVAL_SECONDS", "10")),
                   broker_timeout_seconds=float(os.environ.get("BROKER_TIMEOUT_SECONDS", "5")),
                   timezone=os.environ.get("APP_TIMEZONE", "Europe/Moscow"),
                   dataset_memory_limit=os.environ.get("DATASET_MEMORY_LIMIT", "1GiB"),
                   excel_max_uncompressed_bytes=int(os.environ.get("EXCEL_MAX_UNCOMPRESSED_BYTES", str(1024 * 1024 * 1024))),
                   excel_max_members=int(os.environ.get("EXCEL_MAX_MEMBERS", "10000")),
                   excel_max_cells=int(os.environ.get("EXCEL_MAX_CELLS", "20000000")),
                   excel_max_shared_strings_bytes=int(os.environ.get("EXCEL_MAX_SHARED_STRINGS_BYTES", str(64 * 1024 * 1024))),
                   dataset_threads=int(os.environ.get("DATASET_THREADS", "1")),
                   max_upload_bytes=int(os.environ.get("MAX_UPLOAD_BYTES", str(256 * 1024 * 1024))))

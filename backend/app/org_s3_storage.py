import logging
from functools import lru_cache

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.config import settings

logger = logging.getLogger(__name__)


@lru_cache
def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.minio_endpoint,
        aws_access_key_id=settings.minio_access_key,
        aws_secret_access_key=settings.minio_secret_key,
        region_name=settings.minio_region,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def minio_configured() -> bool:
    return bool(
        settings.minio_endpoint.strip()
        and settings.minio_access_key.strip()
        and settings.minio_secret_key.strip()
    )


def ensure_bucket(bucket: str) -> None:
    """Создаёт bucket при отсутствии (для приватных вложений и т.п.)."""
    name = bucket.strip()
    if not name:
        return
    client = _s3_client()
    try:
        client.head_bucket(Bucket=name)
    except ClientError:
        try:
            client.create_bucket(Bucket=name)
        except ClientError as exc:
            # Гонка: bucket уже создан другим процессом
            try:
                client.head_bucket(Bucket=name)
            except ClientError:
                logger.warning("MinIO ensure_bucket failed for %s: %s", name, exc)
                raise


def put_object(
    key: str,
    body: bytes,
    content_type: str,
    *,
    bucket: str | None = None,
) -> None:
    bucket_name = (bucket or settings.minio_bucket).strip()
    _s3_client().put_object(
        Bucket=bucket_name,
        Key=key.lstrip("/"),
        Body=body,
        ContentType=content_type,
    )


def delete_object(key: str, *, bucket: str | None = None) -> None:
    bucket_name = (bucket or settings.minio_bucket).strip()
    try:
        _s3_client().delete_object(
            Bucket=bucket_name,
            Key=key.lstrip("/"),
        )
    except ClientError as exc:
        logger.warning("MinIO delete failed for %s/%s: %s", bucket_name, key, exc)


def get_object_bytes(key: str, *, bucket: str | None = None) -> tuple[bytes, str] | None:
    bucket_name = (bucket or settings.minio_bucket).strip()
    try:
        response = _s3_client().get_object(
            Bucket=bucket_name,
            Key=key.lstrip("/"),
        )
    except ClientError:
        return None
    body = response["Body"].read()
    content_type = response.get("ContentType") or "application/octet-stream"
    return body, content_type


def public_url(key: str) -> str:
    normalized = key.lstrip("/")
    public_base = settings.minio_public_url.strip().rstrip("/")
    if public_base and not any(
        token in public_base.lower() for token in ("localhost", "127.0.0.1", "://minio")
    ):
        return f"{public_base}/{settings.minio_bucket}/{normalized}"
    return f"/api/org/photos/{normalized}"

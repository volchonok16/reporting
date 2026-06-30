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


def put_object(key: str, body: bytes, content_type: str) -> None:
    _s3_client().put_object(
        Bucket=settings.minio_bucket,
        Key=key.lstrip("/"),
        Body=body,
        ContentType=content_type,
    )


def delete_object(key: str) -> None:
    try:
        _s3_client().delete_object(
            Bucket=settings.minio_bucket,
            Key=key.lstrip("/"),
        )
    except ClientError as exc:
        logger.warning("MinIO delete failed for %s: %s", key, exc)


def get_object_bytes(key: str) -> tuple[bytes, str] | None:
    try:
        response = _s3_client().get_object(
            Bucket=settings.minio_bucket,
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

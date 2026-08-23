"""Mount Voice (carousel) FastAPI app into reporting backend at /voice-api."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = logging.getLogger(__name__)

_voice_job_service = None


def integrate_voice(app: FastAPI) -> None:
    """Mount carousel API and register job executor lifecycle hooks."""
    global _voice_job_service
    from carousel.main import app as voice_app
    from carousel.main import job_service

    app.mount("/voice-api", voice_app)
    _voice_job_service = job_service
    logger.info("Voice API mounted at /voice-api")


def start_voice_jobs() -> None:
    if _voice_job_service is not None:
        _voice_job_service.start()
        logger.info("Voice job executor started")


def stop_voice_jobs() -> None:
    if _voice_job_service is not None:
        _voice_job_service.shutdown()
        logger.info("Voice job executor stopped")

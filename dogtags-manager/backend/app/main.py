from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import external_attempts, registry, returns, processing_settings, whitemav
from app.api import approvals, artifacts, cases, changes, downloads, intakes, operations, processing, review, revisions, session, sources
from app.api.schemas import ERROR_RESPONSES
from app.db import make_engine, make_session_factory
from app.errors import install_error_handlers
from app.middleware import IngressMiddleware
from app.settings import Settings
from app.storage import LocalStorage


def create_app(settings=None, *, engine=None):
    settings = settings or Settings.from_environment()
    app = FastAPI(title="DOGTAGS MANAGER", version="0.1.0")
    app.state.settings = settings
    app.state.engine = engine or make_engine(settings.database_url)
    app.state.sessions = make_session_factory(app.state.engine)
    app.state.storage = LocalStorage(settings.storage_root)
    install_error_handlers(app)
    app.add_middleware(IngressMiddleware, settings=settings)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.origins), allow_credentials=True,
                       allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type", "X-CSRF-Token", "X-Operation-ID"])
    for router in (session.router, whitemav.router, processing_settings.router, cases.router, sources.router, intakes.router, operations.router, revisions.router,
                   review.router, changes.router, external_attempts.router, registry.router, returns.router, artifacts.router, processing.router, approvals.router, downloads.router):
        app.include_router(router, responses=ERROR_RESPONSES)
    if not settings.local_access:
        app.include_router(session.authenticated_router, responses=ERROR_RESPONSES)

    @app.get("/api/health")
    def health():
        return {"service": "DOGTAGS MANAGER", "status": "ok"}

    web = Path(__file__).resolve().parents[2] / "frontend/dist"
    if web.exists():
        app.mount("/", StaticFiles(directory=web, html=True), name="web")
    return app


app = create_app()

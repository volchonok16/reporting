from datetime import date, datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, SmallInteger, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class AuthSession(Base):
    __tablename__ = "auth_session"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SourceSystem(Base):
    __tablename__ = "source_system"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)


class Team(Base):
    __tablename__ = "team"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class ZniBoard(Base):
    __tablename__ = "zni_board"

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    alias: Mapped[str] = mapped_column(String(255), nullable=False)
    board_name: Mapped[str] = mapped_column(String(255), nullable=False)
    area_path: Mapped[str] = mapped_column(String(500), nullable=False)
    sync_tags: Mapped[str] = mapped_column(Text, nullable=False, default="")
    other_tags: Mapped[str] = mapped_column(Text, nullable=False, default="")
    exclude_sync_tags: Mapped[str] = mapped_column(Text, nullable=False, default="")
    exclude_sync_states: Mapped[str] = mapped_column(Text, nullable=False, default="")
    error_sync_tags: Mapped[str] = mapped_column(Text, nullable=False, default="")
    project: Mapped[str] = mapped_column(String(128), nullable=False)
    project_id: Mapped[str] = mapped_column(String(64), nullable=False)
    team_id: Mapped[str] = mapped_column(String(64), nullable=False)
    launching_soon_states: Mapped[str] = mapped_column(Text, nullable=False, default="")
    launching_soon_triage_values: Mapped[str] = mapped_column(Text, nullable=False, default="")
    launched_states: Mapped[str] = mapped_column(Text, nullable=False, default="")
    in_progress_states: Mapped[str] = mapped_column(Text, nullable=False, default="Development")
    incident_error_area_path: Mapped[str | None] = mapped_column(String(500))
    incident_error_sync_tags: Mapped[str] = mapped_column(Text, nullable=False, default="")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Project(Base):
    __tablename__ = "project"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source_system_id: Mapped[int] = mapped_column(SmallInteger, ForeignKey("source_system.id"), nullable=False)
    external_key: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    team_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("team.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Task(Base):
    __tablename__ = "task"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source_system_id: Mapped[int] = mapped_column(SmallInteger, ForeignKey("source_system.id"), nullable=False)
    external_id: Mapped[str] = mapped_column(String(255), nullable=False)
    external_url: Mapped[str | None] = mapped_column(Text)
    project_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("project.id"), nullable=False)
    team_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("team.id"))
    parent_task_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("task.id"))
    title: Mapped[str] = mapped_column(String(1000), nullable=False)
    task_type: Mapped[str | None] = mapped_column(String(64))
    source_status: Mapped[str | None] = mapped_column(String(255))
    source_team: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    start_date: Mapped[date | None] = mapped_column(Date)
    release_date: Mapped[date | None] = mapped_column(Date)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    extra_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ZniExternalData(Base):
    __tablename__ = "zni_external_data"

    task_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("task.id", ondelete="CASCADE"), primary_key=True)
    priority: Mapped[str | None] = mapped_column(String(255))
    commercial_effect: Mapped[str | None] = mapped_column(Text)
    actual_period: Mapped[str | None] = mapped_column(String(128))
    desired_date: Mapped[date | None] = mapped_column(Date)
    desired_quarter: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SyncRun(Base):
    __tablename__ = "sync_run"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source_system_id: Mapped[int] = mapped_column(SmallInteger, ForeignKey("source_system.id"), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(32), default="running")
    records_fetched: Mapped[int | None] = mapped_column(Integer)
    records_upserted: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(Text)
    parameters_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

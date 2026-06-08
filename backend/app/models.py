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


class Project(Base):
    __tablename__ = "project"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source_system_id: Mapped[int] = mapped_column(SmallInteger, ForeignKey("source_system.id"), nullable=False)
    external_key: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    team_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("team.id"))


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

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class YouJailBoard(Base):
    __tablename__ = "youjail_board"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailProject(Base):
    __tablename__ = "youjail_project"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    repo_path: Mapped[str | None] = mapped_column(Text)
    context_md: Mapped[str] = mapped_column(Text, default="")
    instructions_md: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailTaskType(Base):
    __tablename__ = "youjail_task_type"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    instructions_md: Mapped[str] = mapped_column(Text, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailColumn(Base):
    __tablename__ = "youjail_column"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    board_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_board.id"), nullable=False)
    column_key: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(128), nullable=False)
    tone: Mapped[str] = mapped_column(String(32), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)


class YouJailCard(Base):
    __tablename__ = "youjail_card"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    board_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_board.id"), nullable=False)
    column_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_column.id"), nullable=False)
    card_number: Mapped[int] = mapped_column(Integer, nullable=False)
    project_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("youjail_project.id"))
    task_type_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("youjail_task_type.id"))
    title: Mapped[str] = mapped_column(String(1000), nullable=False)
    description_md: Mapped[str] = mapped_column(Text, default="")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    executor: Mapped[str] = mapped_column(String(64), default="manual")
    worktree_path: Mapped[str | None] = mapped_column(Text)
    worktree_branch: Mapped[str | None] = mapped_column(String(255))
    execution_status: Mapped[str] = mapped_column(String(32), default="idle")
    assignee_employee_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("employee.id", ondelete="SET NULL"))
    created_by: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailAttachment(Base):
    __tablename__ = "youjail_attachment"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    card_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_card.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(128))
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailExecution(Base):
    __tablename__ = "youjail_execution"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    card_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_card.id"), nullable=False)
    executor: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="running")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exit_code: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(Text)
    worktree_path: Mapped[str | None] = mapped_column(Text)


class YouJailExecutionLog(Base):
    __tablename__ = "youjail_execution_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    execution_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_execution.id"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    stream: Mapped[str] = mapped_column(String(16), default="stdout")
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailTeam(Base):
    __tablename__ = "youjail_team"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailTeamMember(Base):
    __tablename__ = "youjail_team_member"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    team_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_team.id"), nullable=False)
    employee_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("employee.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(32), default="member")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailBoardTeam(Base):
    __tablename__ = "youjail_board_team"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    board_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_board.id"), nullable=False)
    team_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_team.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailTag(Base):
    __tablename__ = "youjail_tag"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    color: Mapped[str | None] = mapped_column(String(7))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class YouJailCardTag(Base):
    __tablename__ = "youjail_card_tag"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    card_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_card.id"), nullable=False)
    tag_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("youjail_tag.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

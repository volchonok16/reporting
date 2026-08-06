from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Boolean, Date, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

BOOKING_MODE_DAILY = "daily"
BOOKING_MODE_PERIOD = "period"

PROJECT_STATUS_NEW = "new"
PROJECT_STATUS_IN_PROGRESS = "in_progress"
PROJECT_STATUS_COMPLETED = "completed"
PROJECT_STATUSES = {PROJECT_STATUS_NEW, PROJECT_STATUS_IN_PROGRESS, PROJECT_STATUS_COMPLETED}


class PlanningProjectComplexity(Base):
    __tablename__ = "planning_project_complexity"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class PlanningCustomerDepartment(Base):
    __tablename__ = "planning_customer_department"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class ProductionCalendarDay(Base):
    __tablename__ = "production_calendar_day"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    is_working_day: Mapped[bool] = mapped_column(Boolean, nullable=False)
    title: Mapped[str | None] = mapped_column(String(255))
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class PlanningProject(Base):
    __tablename__ = "planning_project"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_number: Mapped[str] = mapped_column(String(64), nullable=False)
    request_name: Mapped[str] = mapped_column(String(512), nullable=False)
    request_url: Mapped[str | None] = mapped_column(String(1024))
    complexity_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("planning_project_complexity.id", ondelete="SET NULL")
    )
    customer_employee_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("employee.id", ondelete="SET NULL")
    )
    customer_name: Mapped[str | None] = mapped_column(String(255))
    customer_department_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("planning_customer_department.id", ondelete="SET NULL")
    )
    planned_start_date: Mapped[date | None] = mapped_column(Date)
    actual_start_date: Mapped[date | None] = mapped_column(Date)
    planned_end_date: Mapped[date | None] = mapped_column(Date)
    actual_end_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(32), default=PROJECT_STATUS_NEW, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_org_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("org_user.id", ondelete="SET NULL")
    )
    created_by_label: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    complexity: Mapped[PlanningProjectComplexity | None] = relationship()
    customer_employee: Mapped["Employee | None"] = relationship(foreign_keys=[customer_employee_id])
    customer_department: Mapped[PlanningCustomerDepartment | None] = relationship()
    allocations: Mapped[list["PlanningAllocation"]] = relationship(
        back_populates="project",
        passive_deletes=True,
    )
    executors: Mapped[list["PlanningProjectExecutor"]] = relationship(
        back_populates="project",
        passive_deletes=True,
        cascade="all, delete-orphan",
    )


class PlanningProjectExecutor(Base):
    __tablename__ = "planning_project_executor"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("planning_project.id", ondelete="CASCADE"), nullable=False
    )
    employee_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("employee.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    project: Mapped[PlanningProject] = relationship(back_populates="executors")
    employee: Mapped["Employee"] = relationship(foreign_keys=[employee_id])


class PlanningAllocation(Base):
    __tablename__ = "planning_allocation"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("planning_project.id", ondelete="CASCADE"), nullable=False
    )
    employee_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("employee.id", ondelete="CASCADE"), nullable=False
    )
    allocation_start_date: Mapped[date] = mapped_column(Date, nullable=False)
    allocation_end_date: Mapped[date] = mapped_column(Date, nullable=False)
    booking_mode: Mapped[str] = mapped_column(String(16), default=BOOKING_MODE_PERIOD, nullable=False)
    planned_hours_per_day: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    created_by_org_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("org_user.id", ondelete="SET NULL")
    )
    created_by_label: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    project: Mapped[PlanningProject] = relationship(back_populates="allocations")
    employee: Mapped["Employee"] = relationship(foreign_keys=[employee_id])
    days: Mapped[list["PlanningAllocationDay"]] = relationship(
        back_populates="allocation",
        passive_deletes=True,
        cascade="all, delete-orphan",
    )


class PlanningAllocationDay(Base):
    __tablename__ = "planning_allocation_day"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    allocation_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("planning_allocation.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    planned_hours: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("0"), nullable=False)
    actual_hours: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("0"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    allocation: Mapped[PlanningAllocation] = relationship(back_populates="days")


# Avoid circular imports at runtime — only for type checkers
from app.org_models import Employee  # noqa: E402

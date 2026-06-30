from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Boolean, Date, ForeignKey, Integer, Numeric, SmallInteger, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

ORG_USER_ROLE_USER = 10
ORG_USER_ROLE_ADMIN = 100
ORG_USER_STATUS_DELETED = 0
ORG_USER_STATUS_INACTIVE = 9
ORG_USER_STATUS_ACTIVE = 10


class OrgUser(Base):
    __tablename__ = "org_user"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[int] = mapped_column(SmallInteger, default=ORG_USER_ROLE_USER, nullable=False)
    status: Mapped[int] = mapped_column(SmallInteger, default=ORG_USER_STATUS_ACTIVE, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    employee: Mapped["Employee | None"] = relationship(back_populates="user", uselist=False)


class JobPosition(Base):
    __tablename__ = "job_position"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class TeamRole(Base):
    __tablename__ = "team_role"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class ExpertiseDirection(Base):
    __tablename__ = "expertise_direction"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class Employee(Base):
    __tablename__ = "employee"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("org_user.id", ondelete="SET NULL"))
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255))
    position_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("job_position.id", ondelete="SET NULL"))
    position: Mapped[str | None] = mapped_column(String(255))
    manager_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("employee.id", ondelete="SET NULL"))
    photo_path: Mapped[str | None] = mapped_column(String(512))
    daily_work_hours: Mapped[Decimal] = mapped_column(Numeric(4, 2), default=Decimal("8"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_organization_head: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    user: Mapped[OrgUser | None] = relationship(back_populates="employee")
    job_position: Mapped[JobPosition | None] = relationship()
    manager: Mapped["Employee | None"] = relationship(
        remote_side=[id],
        foreign_keys=[manager_id],
    )
    department_members: Mapped[list["DepartmentMember"]] = relationship(
        back_populates="employee",
        foreign_keys="DepartmentMember.employee_id",
    )
    expertises: Mapped[list["EmployeeExpertise"]] = relationship(back_populates="employee")
    time_off_days: Mapped[list["EmployeeTimeOffDay"]] = relationship(
        back_populates="employee",
        foreign_keys="EmployeeTimeOffDay.employee_id",
    )
    office_days: Mapped[list["EmployeeOfficeDay"]] = relationship(
        foreign_keys="EmployeeOfficeDay.employee_id",
    )
    workspace_bookings: Mapped[list["WorkspaceBooking"]] = relationship(
        back_populates="employee",
        foreign_keys="WorkspaceBooking.employee_id",
    )


class WorkspacePlace(Base):
    __tablename__ = "workspace_place"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    bookings: Mapped[list["WorkspaceBooking"]] = relationship(back_populates="place")


class WorkspaceBooking(Base):
    __tablename__ = "workspace_booking"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    place_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("workspace_place.id", ondelete="CASCADE"), nullable=False
    )
    employee_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("employee.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    place: Mapped[WorkspacePlace] = relationship(back_populates="bookings")
    employee: Mapped[Employee] = relationship(
        back_populates="workspace_bookings",
        foreign_keys=[employee_id],
    )


class EmployeeTimeOffDay(Base):
    __tablename__ = "employee_time_off_day"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    employee_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("employee.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    employee: Mapped[Employee] = relationship(
        back_populates="time_off_days",
        foreign_keys=[employee_id],
    )


class EmployeeOfficeDay(Base):
    __tablename__ = "employee_office_day"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    employee_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("employee.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class EmployeeExpertise(Base):
    __tablename__ = "employee_expertise"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    employee_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("employee.id", ondelete="CASCADE"), nullable=False)
    expertise_direction_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("expertise_direction.id", ondelete="CASCADE"), nullable=False
    )
    level: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    employee: Mapped[Employee] = relationship(back_populates="expertises")
    direction: Mapped[ExpertiseDirection] = relationship()


class Department(Base):
    __tablename__ = "department"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    head_employee_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("employee.id", ondelete="SET NULL")
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    head: Mapped[Employee | None] = relationship(foreign_keys=[head_employee_id])
    members: Mapped[list["DepartmentMember"]] = relationship(back_populates="department")


class DepartmentMember(Base):
    __tablename__ = "department_member"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    department_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("department.id", ondelete="CASCADE"), nullable=False
    )
    employee_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("employee.id", ondelete="CASCADE"), nullable=False
    )
    team_role_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("team_role.id", ondelete="SET NULL"))
    position: Mapped[str | None] = mapped_column(String(255))
    manager_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("employee.id", ondelete="SET NULL"))
    email: Mapped[str | None] = mapped_column(String(255))
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    department: Mapped[Department] = relationship(back_populates="members")
    employee: Mapped[Employee] = relationship(back_populates="department_members", foreign_keys=[employee_id])
    manager: Mapped[Employee | None] = relationship(foreign_keys=[manager_id])
    team_role: Mapped[TeamRole | None] = relationship()

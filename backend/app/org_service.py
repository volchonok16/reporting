from __future__ import annotations

from decimal import Decimal

from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, joinedload

from app.org_chart_service import build_company_chart, build_department_tree, tree_to_dict
from app.org_models import (
    ORG_USER_ROLE_ADMIN,
    ORG_USER_ROLE_USER,
    ORG_USER_STATUS_ACTIVE,
    ORG_USER_STATUS_DELETED,
    ORG_USER_STATUS_INACTIVE,
    Department,
    DepartmentMember,
    Employee,
    EmployeeExpertise,
    ExpertiseDirection,
    JobPosition,
    OrgUser,
    TeamRole,
)
from app.org_password import hash_password, verify_password
from app.org_photo_service import delete_photo_file, photo_public_url, save_employee_photo
from app.org_schemas import (
    DepartmentIn,
    DepartmentMemberIn,
    DepartmentMemberOut,
    DepartmentMemberUpdateIn,
    DepartmentOut,
    EmployeeBriefOut,
    EmployeeDepartmentBriefOut,
    EmployeeDepartmentMembershipOut,
    EmployeeDetailOut,
    EmployeeExpertiseIn,
    EmployeeExpertiseOut,
    EmployeeHeadedDepartmentOut,
    EmployeeIn,
    EmployeeOut,
    EmployeeUpdateIn,
    ExpertiseDirectionIn,
    ExpertiseDirectionOut,
    JobPositionIn,
    JobPositionOut,
    OrgChartOut,
    OrgUserBriefOut,
    OrgUserIn,
    OrgUserOut,
    OrgUserUpdateIn,
    PasswordChangeIn,
    ProfileOut,
    ProfileUpdateIn,
    SelectOptionOut,
    TeamRoleIn,
    TeamRoleOut,
)


def _user_role_label(role: int) -> str:
    return "admin" if role == ORG_USER_ROLE_ADMIN else "user"


def _user_status_label(status: int) -> str:
    if status == ORG_USER_STATUS_DELETED:
        return "deleted"
    if status == ORG_USER_STATUS_INACTIVE:
        return "inactive"
    return "active"


def _employee_out(db: Session, emp: Employee) -> EmployeeOut:
    manager_name = None
    if emp.manager_id:
        manager = db.get(Employee, emp.manager_id)
        manager_name = manager.full_name if manager else None
    user_out = None
    if emp.user:
        user_out = OrgUserBriefOut(
            id=emp.user.id,
            email=emp.user.email,
            role=_user_role_label(emp.user.role),  # type: ignore[arg-type]
            status=_user_status_label(emp.user.status),  # type: ignore[arg-type]
        )
    expertises = [
        EmployeeExpertiseOut(
            id=ex.id,
            directionId=ex.expertise_direction_id,
            directionName=ex.direction.name if ex.direction else "",
            level=ex.level,
        )
        for ex in emp.expertises
    ]
    departments = [
        EmployeeDepartmentBriefOut(
            departmentId=m.department_id,
            departmentName=m.department.name if m.department else "",
        )
        for m in sorted(emp.department_members, key=lambda item: (item.sort_order, item.id))
    ] if emp.department_members else []
    return EmployeeOut(
        id=emp.id,
        fullName=emp.full_name,
        email=emp.email,
        positionId=emp.position_id,
        position=emp.position,
        managerId=emp.manager_id,
        managerName=manager_name,
        photoUrl=photo_public_url(emp.photo_path),
        dailyWorkHours=emp.daily_work_hours,
        isActive=emp.is_active,
        isOrganizationHead=emp.is_organization_head,
        user=user_out,
        expertises=expertises,
        departments=departments,
    )


def _sync_employee_departments(db: Session, employee_id: int, department_ids: list[int]) -> None:
    unique_ids = list(dict.fromkeys(department_ids))
    for dept_id in unique_ids:
        dept = db.get(Department, dept_id)
        if dept is None:
            raise HTTPException(status_code=404, detail=f"Отдел {dept_id} не найден.")

    current = db.scalars(
        select(DepartmentMember).where(DepartmentMember.employee_id == employee_id)
    ).all()
    current_ids = {m.department_id for m in current}
    target_ids = set(unique_ids)

    for member in current:
        if member.department_id in target_ids:
            continue
        dept = db.get(Department, member.department_id)
        if dept and dept.head_employee_id == employee_id:
            raise HTTPException(
                status_code=400,
                detail=f"Нельзя исключить сотрудника из отдела «{dept.name}»: он назначен руководителем отдела.",
            )
        db.delete(member)

    for dept_id in unique_ids:
        if dept_id in current_ids:
            continue
        db.add(
            DepartmentMember(
                department_id=dept_id,
                employee_id=employee_id,
                sort_order=0,
            )
        )


def _department_out(db: Session, dept: Department) -> DepartmentOut:
    head_name = dept.head.full_name if dept.head else None
    count = db.scalar(
        select(func.count()).select_from(DepartmentMember).where(DepartmentMember.department_id == dept.id)
    )
    return DepartmentOut(
        id=dept.id,
        name=dept.name,
        description=dept.description,
        headEmployeeId=dept.head_employee_id,
        headEmployeeName=head_name,
        sortOrder=dept.sort_order,
        isActive=dept.is_active,
        memberCount=int(count or 0),
    )


def _member_out(member: DepartmentMember) -> DepartmentMemberOut:
    emp = member.employee
    display_position = member.position or (emp.position if emp else None)
    if not display_position and emp and emp.job_position:
        display_position = emp.job_position.name
    display_email = member.email or (emp.email if emp else None)
    return DepartmentMemberOut(
        id=member.id,
        departmentId=member.department_id,
        employeeId=member.employee_id,
        employeeName=emp.full_name if emp else "",
        teamRoleId=member.team_role_id,
        teamRoleName=member.team_role.name if member.team_role else None,
        position=member.position,
        displayPosition=display_position,
        managerId=member.manager_id,
        managerName=member.manager.full_name if member.manager else (emp.manager.full_name if emp and emp.manager else None),
        email=member.email,
        displayEmail=display_email,
        sortOrder=member.sort_order,
        photoUrl=photo_public_url(emp.photo_path) if emp else None,
    )


def _sync_position_name(db: Session, emp: Employee) -> None:
    if emp.position_id:
        pos = db.get(JobPosition, emp.position_id)
        emp.position = pos.name if pos else None
    else:
        emp.position = None


def _ensure_single_org_head(db: Session, employee_id: int) -> None:
    db.execute(
        update(Employee)
        .where(Employee.id != employee_id, Employee.is_organization_head.is_(True))
        .values(is_organization_head=False)
    )


def _ensure_head_is_member(db: Session, dept: Department) -> None:
    if dept.head_employee_id is None:
        return
    existing = db.scalar(
        select(DepartmentMember).where(
            DepartmentMember.department_id == dept.id,
            DepartmentMember.employee_id == dept.head_employee_id,
        )
    )
    if existing:
        return
    db.add(
        DepartmentMember(
            department_id=dept.id,
            employee_id=dept.head_employee_id,
            sort_order=0,
        )
    )


def _validate_manager_cycle(db: Session, employee_id: int, manager_id: int | None) -> None:
    if manager_id is None:
        return
    if manager_id == employee_id:
        raise HTTPException(status_code=400, detail="Сотрудник не может быть руководителем сам себе.")
    visited = {employee_id}
    current = manager_id
    while current:
        if current in visited:
            raise HTTPException(status_code=400, detail="Нельзя назначить руководителя: циклическая подчинённость.")
        visited.add(current)
        mgr = db.get(Employee, current)
        current = mgr.manager_id if mgr else None


def _create_org_user(db: Session, *, email: str, password: str, is_admin: bool) -> OrgUser:
    normalized = email.strip().casefold()
    if not normalized:
        raise HTTPException(status_code=400, detail="Email обязателен для учётной записи.")
    existing = db.scalar(select(OrgUser).where(func.lower(OrgUser.email) == normalized))
    if existing:
        raise HTTPException(status_code=400, detail="Пользователь с таким email уже существует.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Пароль должен быть не короче 8 символов.")
    user = OrgUser(
        email=normalized,
        password_hash=hash_password(password),
        role=ORG_USER_ROLE_ADMIN if is_admin else ORG_USER_ROLE_USER,
        status=ORG_USER_STATUS_ACTIVE,
    )
    db.add(user)
    db.flush()
    return user


def list_job_positions(db: Session) -> list[JobPositionOut]:
    rows = db.scalars(select(JobPosition).order_by(JobPosition.sort_order, JobPosition.name)).all()
    return [
        JobPositionOut(id=r.id, name=r.name, sortOrder=r.sort_order, isActive=r.is_active) for r in rows
    ]


def create_job_position(db: Session, data: JobPositionIn) -> JobPositionOut:
    row = JobPosition(name=data.name.strip(), sort_order=data.sortOrder, is_active=data.isActive)
    db.add(row)
    db.commit()
    db.refresh(row)
    return JobPositionOut(id=row.id, name=row.name, sortOrder=row.sort_order, isActive=row.is_active)


def list_team_roles(db: Session) -> list[TeamRoleOut]:
    rows = db.scalars(select(TeamRole).order_by(TeamRole.sort_order, TeamRole.name)).all()
    return [TeamRoleOut(id=r.id, name=r.name, sortOrder=r.sort_order, isActive=r.is_active) for r in rows]


def create_team_role(db: Session, data: TeamRoleIn) -> TeamRoleOut:
    row = TeamRole(name=data.name.strip(), sort_order=data.sortOrder, is_active=data.isActive)
    db.add(row)
    db.commit()
    db.refresh(row)
    return TeamRoleOut(id=row.id, name=row.name, sortOrder=row.sort_order, isActive=row.is_active)


def list_expertise_directions(db: Session) -> list[ExpertiseDirectionOut]:
    rows = db.scalars(
        select(ExpertiseDirection).order_by(ExpertiseDirection.sort_order, ExpertiseDirection.name)
    ).all()
    return [
        ExpertiseDirectionOut(
            id=r.id, name=r.name, description=r.description, sortOrder=r.sort_order, isActive=r.is_active
        )
        for r in rows
    ]


def create_expertise_direction(db: Session, data: ExpertiseDirectionIn) -> ExpertiseDirectionOut:
    row = ExpertiseDirection(
        name=data.name.strip(),
        description=data.description,
        sort_order=data.sortOrder,
        is_active=data.isActive,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return ExpertiseDirectionOut(
        id=row.id, name=row.name, description=row.description, sortOrder=row.sort_order, isActive=row.is_active
    )


def list_employee_options(db: Session) -> list[SelectOptionOut]:
    rows = db.scalars(
        select(Employee).where(Employee.is_active.is_(True)).order_by(Employee.full_name)
    ).all()
    return [SelectOptionOut(id=r.id, name=r.full_name) for r in rows]


def list_employees(db: Session) -> list[EmployeeOut]:
    rows = db.scalars(
        select(Employee)
        .options(
            joinedload(Employee.user),
            joinedload(Employee.job_position),
            joinedload(Employee.expertises).joinedload(EmployeeExpertise.direction),
            joinedload(Employee.department_members).joinedload(DepartmentMember.department),
        )
        .order_by(Employee.full_name)
    ).unique().all()
    return [_employee_out(db, r) for r in rows]


def get_employee(db: Session, employee_id: int) -> EmployeeDetailOut:
    emp = db.scalar(
        select(Employee)
        .options(
            joinedload(Employee.user),
            joinedload(Employee.manager),
            joinedload(Employee.job_position),
            joinedload(Employee.expertises).joinedload(EmployeeExpertise.direction),
            joinedload(Employee.department_members)
            .joinedload(DepartmentMember.department),
            joinedload(Employee.department_members)
            .joinedload(DepartmentMember.manager),
            joinedload(Employee.department_members)
            .joinedload(DepartmentMember.team_role),
        )
        .where(Employee.id == employee_id)
    )
    if emp is None:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")

    base = _employee_out(db, emp)
    subordinates = db.scalars(
        select(Employee)
        .where(Employee.manager_id == employee_id, Employee.is_active.is_(True))
        .order_by(Employee.full_name)
    ).all()
    member_department_ids = {m.department_id for m in emp.department_members}
    headed = db.scalars(
        select(Department)
        .where(Department.head_employee_id == employee_id, Department.is_active.is_(True))
        .order_by(Department.sort_order, Department.name)
    ).all()

    return EmployeeDetailOut(
        **base.model_dump(),
        subordinates=[
            EmployeeBriefOut(id=s.id, fullName=s.full_name, position=s.position) for s in subordinates
        ],
        departments=[
            EmployeeDepartmentMembershipOut(
                departmentId=m.department_id,
                departmentName=m.department.name if m.department else "",
                teamRoleName=m.team_role.name if m.team_role else None,
                displayPosition=_member_out(m).displayPosition,
                managerName=_member_out(m).managerName,
                displayEmail=_member_out(m).displayEmail,
            )
            for m in sorted(emp.department_members, key=lambda item: (item.sort_order, item.id))
        ],
        headedDepartments=[
            EmployeeHeadedDepartmentOut(id=d.id, name=d.name)
            for d in headed
            if d.id not in member_department_ids
        ],
    )


def create_employee(db: Session, data: EmployeeIn) -> EmployeeOut:
    _validate_manager_cycle(db, 0, data.managerId)
    emp = Employee(
        full_name=data.fullName.strip(),
        email=data.email.strip() if data.email else None,
        position_id=data.positionId,
        manager_id=data.managerId,
        daily_work_hours=data.dailyWorkHours,
        is_active=data.isActive,
        is_organization_head=data.isOrganizationHead,
    )
    _sync_position_name(db, emp)
    db.add(emp)
    db.flush()
    if data.isOrganizationHead:
        _ensure_single_org_head(db, emp.id)
    if data.createUserAccount:
        if not data.email:
            raise HTTPException(status_code=400, detail="Для учётной записи нужен email сотрудника.")
        if not data.userPassword or len(data.userPassword) < 8:
            raise HTTPException(status_code=400, detail="Пароль для входа должен быть не короче 8 символов.")
        user = _create_org_user(
            db, email=data.email, password=data.userPassword, is_admin=data.userIsAdmin
        )
        emp.user_id = user.id
    if data.departmentIds:
        _sync_employee_departments(db, emp.id, data.departmentIds)
    db.commit()
    return get_employee(db, emp.id)


def update_employee(db: Session, employee_id: int, data: EmployeeUpdateIn) -> EmployeeOut:
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")
    if data.fullName is not None:
        emp.full_name = data.fullName.strip()
    if data.email is not None:
        emp.email = data.email.strip() or None
        if emp.user and emp.email:
            emp.user.email = emp.email.strip().casefold()
    if data.positionId is not None:
        emp.position_id = data.positionId or None
    if data.managerId is not None:
        _validate_manager_cycle(db, employee_id, data.managerId)
        emp.manager_id = data.managerId
    if data.dailyWorkHours is not None:
        emp.daily_work_hours = data.dailyWorkHours
    if data.isActive is not None:
        emp.is_active = data.isActive
    if data.isOrganizationHead is not None:
        emp.is_organization_head = data.isOrganizationHead
        if data.isOrganizationHead:
            _ensure_single_org_head(db, employee_id)
    if data.userIsAdmin is not None and emp.user:
        emp.user.role = ORG_USER_ROLE_ADMIN if data.userIsAdmin else ORG_USER_ROLE_USER
    if data.userPassword and emp.user:
        if len(data.userPassword) < 8:
            raise HTTPException(status_code=400, detail="Пароль должен быть не короче 8 символов.")
        emp.user.password_hash = hash_password(data.userPassword)
    _sync_position_name(db, emp)
    if data.departmentIds is not None:
        _sync_employee_departments(db, employee_id, data.departmentIds)
    db.commit()
    return get_employee(db, employee_id)


def delete_employee(db: Session, employee_id: int) -> None:
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")
    delete_photo_file(emp.photo_path)
    db.delete(emp)
    db.commit()


async def upload_employee_photo(db: Session, employee_id: int, file: UploadFile) -> EmployeeOut:
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")
    delete_photo_file(emp.photo_path)
    emp.photo_path = await save_employee_photo(employee_id, file)
    db.commit()
    return get_employee(db, employee_id)


def add_employee_expertise(db: Session, employee_id: int, data: EmployeeExpertiseIn) -> EmployeeOut:
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")
    direction = db.get(ExpertiseDirection, data.expertiseDirectionId)
    if direction is None:
        raise HTTPException(status_code=404, detail="Направление экспертизы не найдено.")
    existing = db.scalar(
        select(EmployeeExpertise).where(
            EmployeeExpertise.employee_id == employee_id,
            EmployeeExpertise.expertise_direction_id == data.expertiseDirectionId,
        )
    )
    if existing:
        raise HTTPException(status_code=400, detail="Экспертиза уже добавлена.")
    db.add(
        EmployeeExpertise(
            employee_id=employee_id,
            expertise_direction_id=data.expertiseDirectionId,
            level=data.level,
        )
    )
    db.commit()
    return get_employee(db, employee_id)


def delete_employee_expertise(db: Session, employee_id: int, expertise_id: int) -> EmployeeOut:
    row = db.get(EmployeeExpertise, expertise_id)
    if row is None or row.employee_id != employee_id:
        raise HTTPException(status_code=404, detail="Экспертиза не найдена.")
    db.delete(row)
    db.commit()
    return get_employee(db, employee_id)


def list_departments(db: Session) -> list[DepartmentOut]:
    rows = db.scalars(
        select(Department).options(joinedload(Department.head)).order_by(Department.sort_order, Department.name)
    ).unique().all()
    return [_department_out(db, d) for d in rows]


def get_department(db: Session, department_id: int) -> DepartmentOut:
    dept = db.scalar(
        select(Department).options(joinedload(Department.head)).where(Department.id == department_id)
    )
    if dept is None:
        raise HTTPException(status_code=404, detail="Отдел не найден.")
    return _department_out(db, dept)


def create_department(db: Session, data: DepartmentIn) -> DepartmentOut:
    dept = Department(
        name=data.name.strip(),
        description=data.description,
        head_employee_id=data.headEmployeeId,
        sort_order=data.sortOrder,
        is_active=data.isActive,
    )
    db.add(dept)
    db.flush()
    _ensure_head_is_member(db, dept)
    db.commit()
    return get_department(db, dept.id)


def update_department(db: Session, department_id: int, data: DepartmentIn) -> DepartmentOut:
    dept = db.get(Department, department_id)
    if dept is None:
        raise HTTPException(status_code=404, detail="Отдел не найден.")
    dept.name = data.name.strip()
    dept.description = data.description
    dept.head_employee_id = data.headEmployeeId
    dept.sort_order = data.sortOrder
    dept.is_active = data.isActive
    _ensure_head_is_member(db, dept)
    db.commit()
    return get_department(db, department_id)


def delete_department(db: Session, department_id: int) -> None:
    dept = db.get(Department, department_id)
    if dept is None:
        raise HTTPException(status_code=404, detail="Отдел не найден.")
    db.delete(dept)
    db.commit()


def list_department_members(db: Session, department_id: int) -> list[DepartmentMemberOut]:
    if db.get(Department, department_id) is None:
        raise HTTPException(status_code=404, detail="Отдел не найден.")
    rows = db.scalars(
        select(DepartmentMember)
        .options(
            joinedload(DepartmentMember.employee).joinedload(Employee.job_position),
            joinedload(DepartmentMember.manager),
            joinedload(DepartmentMember.team_role),
        )
        .where(DepartmentMember.department_id == department_id)
        .order_by(DepartmentMember.sort_order, DepartmentMember.id)
    ).unique().all()
    return [_member_out(m) for m in rows]


def add_department_member(db: Session, department_id: int, data: DepartmentMemberIn) -> DepartmentMemberOut:
    dept = db.get(Department, department_id)
    if dept is None:
        raise HTTPException(status_code=404, detail="Отдел не найден.")
    emp = db.get(Employee, data.employeeId)
    if emp is None:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")
    existing = db.scalar(
        select(DepartmentMember).where(
            DepartmentMember.department_id == department_id,
            DepartmentMember.employee_id == data.employeeId,
        )
    )
    if existing:
        raise HTTPException(status_code=400, detail="Сотрудник уже состоит в этом отделе.")
    member = DepartmentMember(
        department_id=department_id,
        employee_id=data.employeeId,
        team_role_id=data.teamRoleId,
        position=data.position,
        manager_id=data.managerId,
        email=data.email,
        sort_order=data.sortOrder,
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    loaded = db.scalar(
        select(DepartmentMember)
        .options(
            joinedload(DepartmentMember.employee).joinedload(Employee.job_position),
            joinedload(DepartmentMember.manager),
            joinedload(DepartmentMember.team_role),
        )
        .where(DepartmentMember.id == member.id)
    )
    return _member_out(loaded)  # type: ignore[arg-type]


def update_department_member(
    db: Session, department_id: int, member_id: int, data: DepartmentMemberUpdateIn
) -> DepartmentMemberOut:
    member = db.get(DepartmentMember, member_id)
    if member is None or member.department_id != department_id:
        raise HTTPException(status_code=404, detail="Участник не найден.")
    if data.teamRoleId is not None:
        member.team_role_id = data.teamRoleId or None
    if data.position is not None:
        member.position = data.position or None
    if data.managerId is not None:
        member.manager_id = data.managerId or None
    if data.email is not None:
        member.email = data.email or None
    if data.sortOrder is not None:
        member.sort_order = data.sortOrder
    db.commit()
    loaded = db.scalar(
        select(DepartmentMember)
        .options(
            joinedload(DepartmentMember.employee).joinedload(Employee.job_position),
            joinedload(DepartmentMember.manager),
            joinedload(DepartmentMember.team_role),
        )
        .where(DepartmentMember.id == member_id)
    )
    return _member_out(loaded)  # type: ignore[arg-type]


def delete_department_member(db: Session, department_id: int, member_id: int) -> None:
    member = db.get(DepartmentMember, member_id)
    if member is None or member.department_id != department_id:
        raise HTTPException(status_code=404, detail="Участник не найден.")
    db.delete(member)
    db.commit()


def _load_members_for_department(db: Session, department_id: int) -> list[DepartmentMember]:
    return list(
        db.scalars(
            select(DepartmentMember)
            .options(
                joinedload(DepartmentMember.employee).joinedload(Employee.job_position),
                joinedload(DepartmentMember.manager),
                joinedload(DepartmentMember.team_role),
            )
            .where(DepartmentMember.department_id == department_id)
        ).unique().all()
    )


def get_org_chart(db: Session, department_id: int | None = None) -> OrgChartOut:
    if department_id is not None:
        dept = db.scalar(
            select(Department).options(joinedload(Department.head)).where(Department.id == department_id)
        )
        if dept is None:
            raise HTTPException(status_code=404, detail="Отдел не найден.")
        members = _load_members_for_department(db, department_id)
        tree = build_department_tree(dept, members)
        return OrgChartOut(departmentTree=tree_to_dict(tree))  # type: ignore[arg-type]

    org_head = db.scalar(
        select(Employee)
        .options(joinedload(Employee.job_position))
        .where(Employee.is_organization_head.is_(True), Employee.is_active.is_(True))
    )
    departments = list(
        db.scalars(
            select(Department)
            .options(joinedload(Department.head))
            .where(Department.is_active.is_(True))
            .order_by(Department.sort_order, Department.name)
        ).unique().all()
    )
    employees = list(
        db.scalars(
            select(Employee)
            .options(joinedload(Employee.job_position))
            .where(Employee.is_active.is_(True))
        ).unique().all()
    )
    employees_by_id = {emp.id: emp for emp in employees}
    department_trees: dict[int, list] = {}
    for dept in departments:
        members = _load_members_for_department(db, dept.id)
        department_trees[dept.id] = build_department_tree(dept, members)
    chart = build_company_chart(
        organization_head=org_head,
        departments=departments,
        department_trees=department_trees,
        employees_by_id=employees_by_id,
    )
    return OrgChartOut(
        organizationHead=chart.get("organizationHead"),
        departments=chart.get("departments", []),
    )  # type: ignore[arg-type]


def find_org_user_by_email(db: Session, email: str) -> OrgUser | None:
    normalized = email.strip().casefold()
    return db.scalar(
        select(OrgUser).where(func.lower(OrgUser.email) == normalized, OrgUser.status == ORG_USER_STATUS_ACTIVE)
    )


def verify_org_user_password(user: OrgUser, password: str) -> bool:
    return verify_password(password, user.password_hash)


def get_employee_for_org_user(db: Session, org_user_id: int) -> Employee | None:
    return db.scalar(select(Employee).where(Employee.user_id == org_user_id))


def load_profile(db: Session, *, org_user_id: int | None, app_login: str | None, app_role: str) -> ProfileOut:
    email = app_login or ""
    role: str = app_role
    employee_out = None
    if org_user_id:
        user = db.get(OrgUser, org_user_id)
        if user:
            email = user.email
            role = "admin" if user.role == ORG_USER_ROLE_ADMIN else "user"
            emp = get_employee_for_org_user(db, org_user_id)
            if emp:
                employee_out = get_employee(db, emp.id)
    return ProfileOut(email=email, role=role, employee=employee_out)  # type: ignore[arg-type]


def update_profile(db: Session, org_user_id: int, data: ProfileUpdateIn) -> ProfileOut:
    emp = get_employee_for_org_user(db, org_user_id)
    if emp is None:
        raise HTTPException(status_code=400, detail="Профиль доступен только при привязке к карточке сотрудника.")
    emp.full_name = data.fullName.strip()
    db.commit()
    return load_profile(db, org_user_id=org_user_id, app_login=None, app_role="user")


async def update_profile_photo(db: Session, org_user_id: int, file: UploadFile) -> ProfileOut:
    emp = get_employee_for_org_user(db, org_user_id)
    if emp is None:
        raise HTTPException(status_code=400, detail="Фото доступно только при привязке к карточке сотрудника.")
    await upload_employee_photo(db, emp.id, file)
    return load_profile(db, org_user_id=org_user_id, app_login=None, app_role="user")


def change_password(db: Session, org_user_id: int | None, app_login: str | None, data: PasswordChangeIn) -> None:
    if data.newPassword != data.newPasswordRepeat:
        raise HTTPException(status_code=400, detail="Новые пароли не совпадают.")
    if len(data.newPassword) < 8:
        raise HTTPException(status_code=400, detail="Новый пароль должен быть не короче 8 символов.")

    user: OrgUser | None = None
    if org_user_id:
        user = db.get(OrgUser, org_user_id)
    if user is None and app_login:
        from app.app_users import verify_app_user
        from app.config import settings

        login = app_login.strip().casefold()
        for users_map in (settings.app_auth_users_map, settings.app_auth_roadmap_users_map):
            if verify_app_user(users_map, login, data.currentPassword):
                raise HTTPException(
                    status_code=400,
                    detail="Смена пароля для учётной записи из APP_AUTH_USERS не поддерживается. Обратитесь к администратору.",
                )

    if user is None:
        raise HTTPException(status_code=400, detail="Смена пароля доступна только для учётных записей сотрудников.")

    if not verify_password(data.currentPassword, user.password_hash):
        raise HTTPException(status_code=400, detail="Текущий пароль неверен.")

    user.password_hash = hash_password(data.newPassword)
    db.commit()


def list_org_users(db: Session) -> list[OrgUserOut]:
    rows = db.scalars(
        select(OrgUser).where(OrgUser.status != ORG_USER_STATUS_DELETED).order_by(OrgUser.email)
    ).all()
    result = []
    for user in rows:
        emp = db.scalar(select(Employee).where(Employee.user_id == user.id))
        result.append(
            OrgUserOut(
                id=user.id,
                email=user.email,
                role=_user_role_label(user.role),  # type: ignore[arg-type]
                status=_user_status_label(user.status),  # type: ignore[arg-type]
                employeeId=emp.id if emp else None,
                employeeName=emp.full_name if emp else None,
            )
        )
    return result


def create_org_user_account(db: Session, data: OrgUserIn) -> OrgUserOut:
    user = _create_org_user(db, email=data.email, password=data.password, is_admin=data.isAdmin)
    status = ORG_USER_STATUS_ACTIVE if data.status == "active" else ORG_USER_STATUS_INACTIVE
    user.status = status
    db.commit()
    return OrgUserOut(
        id=user.id,
        email=user.email,
        role=_user_role_label(user.role),  # type: ignore[arg-type]
        status=_user_status_label(user.status),  # type: ignore[arg-type]
    )


def update_org_user_account(db: Session, user_id: int, data: OrgUserUpdateIn) -> OrgUserOut:
    user = db.get(OrgUser, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден.")
    if data.email is not None:
        normalized = data.email.strip().casefold()
        existing = db.scalar(select(OrgUser).where(func.lower(OrgUser.email) == normalized, OrgUser.id != user_id))
        if existing:
            raise HTTPException(status_code=400, detail="Email уже занят.")
        user.email = normalized
        emp = db.scalar(select(Employee).where(Employee.user_id == user_id))
        if emp:
            emp.email = normalized
    if data.password:
        if len(data.password) < 8:
            raise HTTPException(status_code=400, detail="Пароль должен быть не короче 8 символов.")
        user.password_hash = hash_password(data.password)
    if data.isAdmin is not None:
        user.role = ORG_USER_ROLE_ADMIN if data.isAdmin else ORG_USER_ROLE_USER
    if data.status is not None:
        user.status = {
            "active": ORG_USER_STATUS_ACTIVE,
            "inactive": ORG_USER_STATUS_INACTIVE,
            "deleted": ORG_USER_STATUS_DELETED,
        }[data.status]
    db.commit()
    emp = db.scalar(select(Employee).where(Employee.user_id == user_id))
    return OrgUserOut(
        id=user.id,
        email=user.email,
        role=_user_role_label(user.role),  # type: ignore[arg-type]
        status=_user_status_label(user.status),  # type: ignore[arg-type]
        employeeId=emp.id if emp else None,
        employeeName=emp.full_name if emp else None,
    )

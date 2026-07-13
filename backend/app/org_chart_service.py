from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.org_models import Department, DepartmentMember, Employee
from app.org_photo_service import photo_public_url


@dataclass
class OrgChartPerson:
    employeeId: int
    publicId: str
    fullName: str
    position: str | None = None
    email: str | None = None
    photoUrl: str | None = None
    teamRole: str | None = None
    isHead: bool = False


@dataclass
class OrgChartNode:
    person: OrgChartPerson
    memberId: int | None = None
    children: list[OrgChartNode] = field(default_factory=list)


def _member_name(member: DepartmentMember) -> str:
    return member.employee.full_name if member.employee else ""


def _display_position(member: DepartmentMember) -> str | None:
    if member.position:
        return member.position
    emp = member.employee
    if emp and emp.position:
        return emp.position
    if emp and emp.job_position:
        return emp.job_position.name
    return None


def _display_email(member: DepartmentMember) -> str | None:
    if member.email:
        return member.email
    return member.employee.email if member.employee else None


def _resolve_manager_id(
    member: DepartmentMember,
    head_member: DepartmentMember | None,
) -> int | None:
    if member.manager_id is not None:
        return member.manager_id
    if member.employee and member.employee.manager_id is not None:
        return member.employee.manager_id
    if head_member is not None:
        return head_member.employee_id
    return None


def _has_manager_in_department(
    member: DepartmentMember,
    head_member: DepartmentMember | None,
    by_employee_id: dict[int, DepartmentMember],
) -> bool:
    manager_id = _resolve_manager_id(member, head_member)
    return manager_id is not None and manager_id in by_employee_id


def _resolve_head_member(
    department: Department,
    members: list[DepartmentMember],
) -> DepartmentMember | None:
    if department.head_employee_id is None:
        return None
    head_id = department.head_employee_id
    for member in members:
        if member.employee_id == head_id:
            return member
    if department.head is not None:
        synthetic = DepartmentMember(
            id=0,
            department_id=department.id,
            employee_id=head_id,
            employee=department.head,
        )
        return synthetic
    return None


def _employee_photo_url(employee: Employee | None) -> str | None:
    if employee is None:
        return None
    return photo_public_url(employee.photo_path)


def _build_node(
    member: DepartmentMember,
    children_by_manager: dict[int, list[DepartmentMember]],
    attached: dict[int, bool],
    *,
    is_head: bool = False,
) -> OrgChartNode:
    attached[member.employee_id] = True
    children = [
        _build_node(child, children_by_manager, attached)
        for child in children_by_manager.get(member.employee_id, [])
    ]
    children.sort(key=lambda n: n.person.fullName.casefold())
    return OrgChartNode(
        memberId=member.id or None,
        person=OrgChartPerson(
            employeeId=member.employee_id,
            publicId=str(member.employee.public_id) if member.employee else "",
            fullName=member.employee.full_name if member.employee else "",
            position=_display_position(member),
            email=_display_email(member),
            photoUrl=_employee_photo_url(member.employee),
            teamRole=member.team_role.name if member.team_role else None,
            isHead=is_head,
        ),
        children=children,
    )


def build_department_tree(
    department: Department,
    members: list[DepartmentMember],
) -> list[OrgChartNode]:
    head_member = _resolve_head_member(department, members)
    if not members and head_member is None:
        return []

    # Без руководителя отдела — все сотрудники на одном уровне (параллельно).
    if head_member is None:
        roots = [
            _build_node(member, {}, {}, is_head=False)
            for member in sorted(members, key=lambda m: _member_name(m).casefold())
        ]
        return roots

    by_employee_id: dict[int, DepartmentMember] = {m.employee_id: m for m in members}
    by_employee_id[head_member.employee_id] = head_member

    children_by_manager: dict[int, list[DepartmentMember]] = {}
    for member in members:
        if member.employee_id == head_member.employee_id:
            continue
        manager_id = _resolve_manager_id(member, head_member)
        if manager_id is not None and manager_id in by_employee_id:
            children_by_manager.setdefault(manager_id, []).append(member)

    attached: dict[int, bool] = {}
    root = _build_node(head_member, children_by_manager, attached, is_head=True)
    for member in members:
        if member.employee_id in attached:
            continue
        if not _has_manager_in_department(member, head_member, by_employee_id):
            root.children.append(_build_node(member, children_by_manager, attached))
    root.children.sort(key=lambda n: n.person.fullName.casefold())
    return [root]


def node_for_employee(employee: Employee, *, is_head: bool = False) -> OrgChartNode:
    return OrgChartNode(
        person=OrgChartPerson(
            employeeId=employee.id,
            publicId=str(employee.public_id),
            fullName=employee.full_name,
            position=employee.position or (employee.job_position.name if employee.job_position else None),
            email=employee.email,
            photoUrl=photo_public_url(employee.photo_path),
            isHead=is_head,
        ),
        children=[],
    )


def _department_branch_parent_id(
    dept: Department,
    dept_by_head_employee: dict[int, Department],
    org_head_id: int | None,
    employees_by_id: dict[int, Employee],
) -> int | None:
    """Отдел под отделом руководителя, если head подчиняется head другого отдела."""
    if dept.head_employee_id is None:
        return None
    head = employees_by_id.get(dept.head_employee_id)
    if head is None or head.manager_id is None:
        return None
    if org_head_id is not None and head.manager_id == org_head_id:
        return None
    parent = dept_by_head_employee.get(head.manager_id)
    if parent is not None and parent.id != dept.id:
        return parent.id
    return None


def _build_unassigned_roots(unassigned: list[Employee]) -> list[OrgChartNode]:
    """Сотрудники без отдела — отдельные ветки на уровне отделов (параллельно отделам)."""
    if not unassigned:
        return []

    unassigned_ids = {emp.id for emp in unassigned}
    children_by_manager: dict[int, list[Employee]] = {}
    for emp in unassigned:
        if emp.manager_id is not None and emp.manager_id in unassigned_ids:
            children_by_manager.setdefault(emp.manager_id, []).append(emp)

    created: dict[int, OrgChartNode] = {}

    def build_node(emp: Employee) -> OrgChartNode:
        if emp.id in created:
            return created[emp.id]
        children = [
            build_node(child)
            for child in sorted(
                children_by_manager.get(emp.id, []),
                key=lambda item: item.full_name.casefold(),
            )
        ]
        node = node_for_employee(emp)
        node.children = children
        created[emp.id] = node
        return node

    roots = [
        emp
        for emp in unassigned
        if emp.manager_id is None or emp.manager_id not in unassigned_ids
    ]
    return [build_node(emp) for emp in sorted(roots, key=lambda item: item.full_name.casefold())]


def build_company_chart(
    *,
    organization_head: Employee | None,
    departments: list[Department],
    department_trees: dict[int, list[OrgChartNode]],
    employees_without_department: list[Employee],
    employees_by_id: dict[int, Employee],
) -> dict[str, Any]:
    """Отделы — отдельные ветки; подчинённый отдел — колонкой под отделом руководителя."""

    org_head_id = organization_head.id if organization_head else None
    dept_by_head: dict[int, Department] = {}
    for dept in departments:
        if dept.head_employee_id is not None:
            dept_by_head[dept.head_employee_id] = dept

    parent_of: dict[int, int | None] = {
        dept.id: _department_branch_parent_id(dept, dept_by_head, org_head_id, employees_by_id)
        for dept in departments
    }

    def build_block(dept: Department) -> dict[str, Any]:
        nested = [d for d in departments if parent_of.get(d.id) == dept.id]
        nested.sort(key=lambda d: (d.sort_order, d.name.casefold()))
        return {
            "departmentId": dept.id,
            "departmentName": dept.name,
            "headEmployeeId": dept.head_employee_id,
            "roots": [_node_to_dict(n) for n in department_trees.get(dept.id, [])],
            "nestedDepartments": [build_block(d) for d in nested],
        }

    top_level = [d for d in departments if parent_of.get(d.id) is None]
    top_level.sort(key=lambda d: (d.sort_order, d.name.casefold()))

    director_node = node_for_employee(organization_head, is_head=True) if organization_head else None
    standalone_roots = _build_unassigned_roots(employees_without_department)

    return {
        "organizationHead": _node_to_dict(director_node) if director_node else None,
        "departments": [build_block(d) for d in top_level],
        "standaloneRoots": [_node_to_dict(n) for n in standalone_roots],
    }


def _node_to_dict(node: OrgChartNode | None) -> dict[str, Any] | None:
    if node is None:
        return None
    return {
        "memberId": node.memberId,
        "person": {
            "employeeId": node.person.employeeId,
            "publicId": node.person.publicId,
            "fullName": node.person.fullName,
            "position": node.person.position,
            "email": node.person.email,
            "photoUrl": node.person.photoUrl,
            "teamRole": node.person.teamRole,
            "isHead": node.person.isHead,
        },
        "children": [_node_to_dict(c) for c in node.children],
    }


def tree_to_dict(nodes: list[OrgChartNode]) -> list[dict[str, Any]]:
    return [_node_to_dict(n) for n in nodes if n is not None]

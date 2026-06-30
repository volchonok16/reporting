from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field


class OrgChartPersonOut(BaseModel):
    employeeId: int
    fullName: str
    position: str | None = None
    email: str | None = None
    photoUrl: str | None = None
    teamRole: str | None = None
    isHead: bool = False


class OrgChartNodeOut(BaseModel):
    memberId: int | None = None
    person: OrgChartPersonOut
    children: list["OrgChartNodeOut"] = Field(default_factory=list)


class DepartmentBlockOut(BaseModel):
    departmentId: int
    departmentName: str
    headEmployeeId: int | None = None
    roots: list[OrgChartNodeOut] = Field(default_factory=list)


class OrgChartOut(BaseModel):
    organizationHead: OrgChartNodeOut | None = None
    departments: list[DepartmentBlockOut] = Field(default_factory=list)
    departmentTree: list[OrgChartNodeOut] = Field(default_factory=list)


class JobPositionOut(BaseModel):
    id: int
    name: str
    sortOrder: int
    isActive: bool


class JobPositionIn(BaseModel):
    name: str
    sortOrder: int = 0
    isActive: bool = True


class TeamRoleOut(BaseModel):
    id: int
    name: str
    sortOrder: int
    isActive: bool


class TeamRoleIn(BaseModel):
    name: str
    sortOrder: int = 0
    isActive: bool = True


class ExpertiseDirectionOut(BaseModel):
    id: int
    name: str
    description: str | None = None
    sortOrder: int
    isActive: bool


class ExpertiseDirectionIn(BaseModel):
    name: str
    description: str | None = None
    sortOrder: int = 0
    isActive: bool = True


class EmployeeExpertiseOut(BaseModel):
    id: int
    directionId: int
    directionName: str
    level: str | None = None


class EmployeeExpertiseIn(BaseModel):
    expertiseDirectionId: int
    level: str | None = None


class OrgUserBriefOut(BaseModel):
    id: int
    email: str
    role: Literal["user", "admin"]
    status: Literal["active", "inactive", "deleted"]


class EmployeeOut(BaseModel):
    id: int
    fullName: str
    email: str | None = None
    positionId: int | None = None
    position: str | None = None
    managerId: int | None = None
    managerName: str | None = None
    photoUrl: str | None = None
    dailyWorkHours: Decimal
    isActive: bool
    isOrganizationHead: bool
    user: OrgUserBriefOut | None = None
    expertises: list[EmployeeExpertiseOut] = Field(default_factory=list)


class EmployeeBriefOut(BaseModel):
    id: int
    fullName: str
    position: str | None = None


class EmployeeDepartmentMembershipOut(BaseModel):
    departmentId: int
    departmentName: str
    teamRoleName: str | None = None
    displayPosition: str | None = None
    managerName: str | None = None
    displayEmail: str | None = None


class EmployeeHeadedDepartmentOut(BaseModel):
    id: int
    name: str


class EmployeeDetailOut(EmployeeOut):
    subordinates: list[EmployeeBriefOut] = Field(default_factory=list)
    departments: list[EmployeeDepartmentMembershipOut] = Field(default_factory=list)
    headedDepartments: list[EmployeeHeadedDepartmentOut] = Field(default_factory=list)


class EmployeeIn(BaseModel):
    fullName: str
    email: str | None = None
    positionId: int | None = None
    managerId: int | None = None
    dailyWorkHours: Decimal = Decimal("8")
    isActive: bool = True
    isOrganizationHead: bool = False
    createUserAccount: bool = False
    userPassword: str | None = None
    userIsAdmin: bool = False


class EmployeeUpdateIn(BaseModel):
    fullName: str | None = None
    email: str | None = None
    positionId: int | None = None
    managerId: int | None = None
    dailyWorkHours: Decimal | None = None
    isActive: bool | None = None
    isOrganizationHead: bool | None = None
    userIsAdmin: bool | None = None
    userPassword: str | None = None


class DepartmentOut(BaseModel):
    id: int
    name: str
    description: str | None = None
    headEmployeeId: int | None = None
    headEmployeeName: str | None = None
    sortOrder: int
    isActive: bool
    memberCount: int = 0


class DepartmentIn(BaseModel):
    name: str
    description: str | None = None
    headEmployeeId: int | None = None
    sortOrder: int = 0
    isActive: bool = True


class DepartmentMemberOut(BaseModel):
    id: int
    departmentId: int
    employeeId: int
    employeeName: str
    teamRoleId: int | None = None
    teamRoleName: str | None = None
    position: str | None = None
    displayPosition: str | None = None
    managerId: int | None = None
    managerName: str | None = None
    email: str | None = None
    displayEmail: str | None = None
    sortOrder: int
    photoUrl: str | None = None


class DepartmentMemberIn(BaseModel):
    employeeId: int
    teamRoleId: int | None = None
    position: str | None = None
    managerId: int | None = None
    email: str | None = None
    sortOrder: int = 0


class DepartmentMemberUpdateIn(BaseModel):
    teamRoleId: int | None = None
    position: str | None = None
    managerId: int | None = None
    email: str | None = None
    sortOrder: int | None = None


class ProfileOut(BaseModel):
    email: str
    role: Literal["user", "admin", "full", "roadmap"]
    employee: EmployeeOut | None = None


class ProfileUpdateIn(BaseModel):
    fullName: str


class PasswordChangeIn(BaseModel):
    currentPassword: str
    newPassword: str
    newPasswordRepeat: str


class OrgUserOut(BaseModel):
    id: int
    email: str
    role: Literal["user", "admin"]
    status: Literal["active", "inactive", "deleted"]
    employeeId: int | None = None
    employeeName: str | None = None


class OrgUserIn(BaseModel):
    email: str
    password: str
    isAdmin: bool = False
    status: Literal["active", "inactive"] = "active"


class OrgUserUpdateIn(BaseModel):
    email: str | None = None
    password: str | None = None
    isAdmin: bool | None = None
    status: Literal["active", "inactive", "deleted"] | None = None


class SelectOptionOut(BaseModel):
    id: int
    name: str


TimeOffKind = Literal["vacation", "dayoff", "sick_leave"]
EditableTimeOffKind = Literal["vacation", "dayoff", "sick_leave", "erase"]


class VacationEmployeeOut(BaseModel):
    id: int
    fullName: str
    position: str | None = None
    managerId: int | None = None
    canEdit: bool
    isSelf: bool = False


class VacationTimeOffDayOut(BaseModel):
    employeeId: int
    day: str
    kind: TimeOffKind


class VacationScheduleOut(BaseModel):
    year: int
    departmentId: int | None = None
    actorEmployeeId: int | None = None
    employees: list[VacationEmployeeOut] = Field(default_factory=list)
    timeOffDays: list[VacationTimeOffDayOut] = Field(default_factory=list)


class VacationRangeIn(BaseModel):
    employeeId: int
    fromDay: str
    toDay: str
    kind: EditableTimeOffKind


class VacationRangeOut(BaseModel):
    affectedDays: int


OrgChartNodeOut.model_rebuild()

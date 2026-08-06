from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field

PlanningProjectStatus = Literal["new", "in_progress", "completed"]


class PlanningComplexityOut(BaseModel):
    id: int
    name: str
    sortOrder: int
    isActive: bool


class PlanningComplexityIn(BaseModel):
    name: str
    sortOrder: int = 0
    isActive: bool = True


class PlanningCustomerDepartmentOut(BaseModel):
    id: int
    name: str
    sortOrder: int
    isActive: bool


class PlanningCustomerDepartmentIn(BaseModel):
    name: str
    sortOrder: int = 0
    isActive: bool = True


class PlanningCustomerDepartmentUpdateIn(BaseModel):
    name: str | None = None
    sortOrder: int | None = None
    isActive: bool | None = None


class PlanningExecutorOut(BaseModel):
    id: int
    fullName: str
    fromAllocation: bool = False


class PlanningProjectOut(BaseModel):
    id: int
    requestNumber: str
    requestName: str
    requestUrl: str | None = None
    complexityId: int | None = None
    complexityName: str | None = None
    executorIds: list[int] = Field(default_factory=list)
    executors: list[PlanningExecutorOut] = Field(default_factory=list)
    customerEmployeeId: int | None = None
    customerEmployeeName: str | None = None
    customerName: str | None = None
    customerDepartmentId: int | None = None
    customerDepartmentName: str | None = None
    plannedStartDate: date | None = None
    actualStartDate: date | None = None
    plannedEndDate: date | None = None
    actualEndDate: date | None = None
    status: PlanningProjectStatus = "new"
    notes: str | None = None
    createdByLabel: str | None = None
    createdAt: date | None = None
    allocationCount: int = 0
    totalPlannedHours: Decimal = Decimal("0")
    totalActualHours: Decimal = Decimal("0")


class PlanningProjectIn(BaseModel):
    requestNumber: str
    requestName: str
    requestUrl: str | None = None
    complexityId: int | None = None
    executorIds: list[int] = Field(default_factory=list)
    customerEmployeeId: int | None = None
    customerName: str | None = None
    customerDepartmentId: int | None = None
    plannedStartDate: date | None = None
    actualStartDate: date | None = None
    plannedEndDate: date | None = None
    actualEndDate: date | None = None
    status: PlanningProjectStatus = "new"
    notes: str | None = None


class PlanningProjectUpdateIn(BaseModel):
    requestNumber: str | None = None
    requestName: str | None = None
    requestUrl: str | None = None
    complexityId: int | None = None
    executorIds: list[int] | None = None
    customerEmployeeId: int | None = None
    customerName: str | None = None
    customerDepartmentId: int | None = None
    plannedStartDate: date | None = None
    actualStartDate: date | None = None
    plannedEndDate: date | None = None
    actualEndDate: date | None = None
    status: PlanningProjectStatus | None = None
    notes: str | None = None


class PlanningAllocationDayOut(BaseModel):
    day: date
    plannedHours: Decimal
    actualHours: Decimal


class PlanningAllocationDayIn(BaseModel):
    day: date
    plannedHours: Decimal = Decimal("0")
    actualHours: Decimal = Decimal("0")


class PlanningAllocationOut(BaseModel):
    id: int
    projectId: int
    employeeId: int
    employeeName: str
    employeeExpertises: list[str] = Field(default_factory=list)
    allocationStartDate: date
    allocationEndDate: date
    bookingMode: str
    plannedHoursPerDay: Decimal | None = None
    createdByLabel: str | None = None
    totalPlannedHours: Decimal = Decimal("0")
    totalActualHours: Decimal = Decimal("0")
    days: list[PlanningAllocationDayOut] = Field(default_factory=list)


class PlanningAllocationIn(BaseModel):
    employeeId: int
    allocationStartDate: date
    allocationEndDate: date
    bookingMode: str = "period"
    plannedHoursPerDay: Decimal | None = None
    days: list[PlanningAllocationDayIn] = Field(default_factory=list)


class PlanningAllocationUpdateIn(BaseModel):
    employeeId: int | None = None
    allocationStartDate: date | None = None
    allocationEndDate: date | None = None
    bookingMode: str | None = None
    plannedHoursPerDay: Decimal | None = None
    days: list[PlanningAllocationDayIn] | None = None


class PlanningAllocationDaysIn(BaseModel):
    days: list[PlanningAllocationDayIn]


class ProductionCalendarDayOut(BaseModel):
    day: date
    isWorkingDay: bool
    title: str | None = None
    note: str | None = None


class ProductionCalendarDayIn(BaseModel):
    day: date
    isWorkingDay: bool
    title: str | None = None
    note: str | None = None


class ProductionCalendarBulkIn(BaseModel):
    days: list[ProductionCalendarDayIn]


class PlanningWorkloadAllocationCell(BaseModel):
    allocationId: int
    projectId: int
    requestNumber: str
    requestName: str
    plannedHours: Decimal
    actualHours: Decimal


class PlanningWorkloadDayCell(BaseModel):
    capacityHours: Decimal
    plannedHours: Decimal
    actualHours: Decimal
    availableHours: Decimal
    isWorkingDay: bool
    timeOffKind: str | None = None
    allocations: list[PlanningWorkloadAllocationCell] = Field(default_factory=list)


class PlanningWorkloadEmployeeOut(BaseModel):
    id: int
    fullName: str
    dailyWorkHours: Decimal
    expertises: list[str] = Field(default_factory=list)
    departmentNames: list[str] = Field(default_factory=list)
    days: dict[str, PlanningWorkloadDayCell]


class PlanningWorkloadOut(BaseModel):
    dateFrom: date
    dateTo: date
    days: list[date]
    employees: list[PlanningWorkloadEmployeeOut]

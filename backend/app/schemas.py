from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


class TfsAuthIn(BaseModel):
    baseUrl: str = Field(default="https://tfs.t2.ru/tfs/Main")
    project: str = Field(default="Tele2")
    projectId: str | None = None
    pat: str | None = None
    username: str | None = None
    password: str | None = None


class AuthLoginOut(BaseModel):
    sessionId: str
    authMode: str | None = None
    username: str | None = None
    appRole: Literal["full", "roadmap"] = "full"


class AuthDefaultsOut(BaseModel):
    baseUrl: str
    project: str
    projectId: str | None = None


class VoiceSsoTokenOut(BaseModel):
    token: str
    expiresIn: int = 120


class TfsAuthStatusOut(BaseModel):
    authenticated: bool
    baseUrl: str | None = None
    project: str | None = None
    authMode: str | None = None
    username: str | None = None
    appRole: Literal["full", "roadmap"] = "full"
    canSyncTfs: bool = False
    canManageOrg: bool = False
    voiceOnly: bool = False
    otherUser: bool = False
    allowedPageKeys: list[str] = Field(default_factory=list)
    orgUserId: int | None = None
    orgEmployeeId: int | None = None
    orgEmployeeName: str | None = None
    orgEmployeePhotoUrl: str | None = None


class BoardOut(BaseModel):
    code: str
    name: str
    displayName: str
    project: str
    memberCodes: list[str] = []


class LinkedErrorOut(BaseModel):
    id: str
    title: str
    status: str | None = None
    url: str | None = None


class LinkedEnvironmentOut(BaseModel):
    key: str
    label: str
    zniId: str
    status: str | None = None
    boardColumn: str | None = None
    url: str | None = None


class QuarterOptionOut(BaseModel):
    key: str
    label: str


class TagFilterGroupOut(BaseModel):
    key: str
    label: str
    tags: list[str]
    subsectionPrefixes: list[str] = Field(default_factory=list)


class ChangeRequestOut(BaseModel):
    id: str
    number: str
    rowType: str = "change_request"
    title: str
    url: str | None = None
    status: str | None = None
    boardColumn: str | None = None
    startDate: date | None = None
    releaseDate: date | None = None
    plannedDate: date | None = None
    plannedLabel: str | None = None
    planQuarter: str | None = None
    plannedRelease: str | None = None
    createdAt: datetime | None = None
    boardCode: str | None = None
    boardName: str | None = None
    customerName: str | None = None
    businessGoal: str | None = None
    businessValue: int | None = None
    roadmapPriority: Literal["red", "yellow", "green"] | None = None
    roadmapComment: str | None = None
    ectResourceReservation: bool = False
    ectAcceptance: bool = False
    hasUc: bool = False
    linkedEnvironments: list[LinkedEnvironmentOut] = Field(default_factory=list)
    errors: list[LinkedErrorOut] = Field(default_factory=list)
    externalPriority: str | None = None
    externalCommercialEffect: str | None = None
    externalActualPeriod: str | None = None
    externalDesiredDate: date | None = None
    externalDesiredQuarter: str | None = None
    externalComment: str | None = None


class DashboardMetricsOut(BaseModel):
    totalTasks: int
    inProgress: int
    launchingSoon: int
    launched: int
    completed: int
    errorsCount: int


class DashboardOut(BaseModel):
    board: BoardOut | None = None
    allBoards: bool = False
    metrics: DashboardMetricsOut
    items: list[ChangeRequestOut]
    totalShown: int
    availableStatuses: list[str] = Field(default_factory=list)
    availableQuarters: list[QuarterOptionOut] = Field(default_factory=list)
    availableTagGroups: list[TagFilterGroupOut] = Field(default_factory=list)
    actualPeriodEditableStatuses: list[str] = Field(
        default_factory=list,
        description="Статусы, в которых можно править «Фактическая дата месяц/квартал»",
    )


class ProductStatusSheetOut(BaseModel):
    gid: str
    name: str
    columns: list[str]
    rows: list[dict[str, str]]
    totalShown: int
    projects: list[str] = Field(default_factory=list)


class ProductStatusB2BOut(BaseModel):
    title: str
    sourceUrl: str | None = None
    presentationReferenceUrl: str | None = None
    sheets: list[ProductStatusSheetOut]


class ProductStatusCellUpdate(BaseModel):
    gid: str
    rowIndex: int = Field(ge=0, description="0 — заголовок, 1+ — данные")
    columnIndex: int = Field(ge=0)
    value: str = ""
    column: str | None = None
    expectedValue: str | None = Field(
        default=None,
        description="Значение ячейки на момент начала правки (для защиты от перезаписи чужих изменений)",
    )
    rowId: int | None = Field(
        default=None,
        ge=1,
        description="Стабильный id строки в БД; предпочтительнее rowIndex",
    )


class ProductStatusRowDelete(BaseModel):
    gid: str
    rowId: int = Field(ge=1)


class ProductStatusSheetRowOrder(BaseModel):
    gid: str
    rowIds: list[int] = Field(default_factory=list, min_length=1)


class ProductStatusSaveIn(BaseModel):
    updates: list[ProductStatusCellUpdate] = Field(
        default_factory=list,
        max_length=50_000,
    )
    deletedRows: list[ProductStatusRowDelete] = Field(default_factory=list)
    rowOrder: list[ProductStatusSheetRowOrder] = Field(default_factory=list)


class ProductStatusHistoryEntryOut(BaseModel):
    id: int
    rowId: int | None = None
    officeName: str
    action: str
    fieldName: str | None = None
    oldValue: str | None = None
    newValue: str | None = None
    changedBy: str | None = None
    changedAt: str


class ProductStatusHistoryOut(BaseModel):
    items: list[ProductStatusHistoryEntryOut] = Field(default_factory=list)


class ProductStatusSnapshotOut(BaseModel):
    id: int
    rowCount: int
    changedBy: str | None = None
    createdAt: str


class ProductStatusSnapshotsOut(BaseModel):
    items: list[ProductStatusSnapshotOut] = Field(default_factory=list)


class TaskLookupIn(BaseModel):
    numbers: list[str] = Field(default_factory=list, max_length=200)


class TaskLookupOut(BaseModel):
    items: list[ChangeRequestOut] = Field(default_factory=list)


class BusinessValueUpdateIn(BaseModel):
    value: int | None = Field(
        default=None,
        ge=1,
        description="Целое число; null — очистить поле в TFS",
    )


class RoadmapPriorityUpdateIn(BaseModel):
    priority: Literal["red", "yellow", "green"] | None = Field(
        default=None,
        description="Приоритет колбаски на Планы: red — обязательно, yellow — средний, green — можно пропустить; null — сброс",
    )


class RoadmapCommentUpdateIn(BaseModel):
    comment: str | None = Field(
        default=None,
        max_length=500,
        description="Локальный комментарий колбаски Планы (не в TFS); null или пустая строка — сброс",
    )


class DigitalPlanOut(BaseModel):
    planTag: str
    periodFrom: date
    periodTo: date
    items: list[ChangeRequestOut]
    totalShown: int


class DigitalPlanUcUpdateIn(BaseModel):
    hasUc: bool | None = Field(
        default=None,
        description="UC есть (true) / нет (false); null — сброс",
    )


class ZniExternalDataUpdateIn(BaseModel):
    priority: str | None = Field(default=None, max_length=255, description="Приоритет (внешний)")
    commercialEffect: str | None = Field(default=None, max_length=4000, description="Коммерческий эффект")
    actualPeriod: str | None = Field(
        default=None,
        max_length=128,
        description="Фактическая дата месяц/квартал",
    )
    desiredDate: date | None = Field(default=None, description="Желаемая дата")
    desiredQuarter: str | None = Field(default=None, max_length=64, description="Желаемый квартал")
    comment: str | None = Field(default=None, max_length=4000, description="Комментарий")


class SyncRunOut(BaseModel):
    id: int
    status: str
    recordsFetched: int | None = None
    recordsUpserted: int | None = None
    errorMessage: str | None = None
    progressMessage: str | None = None
    startedAt: datetime
    finishedAt: datetime | None = None

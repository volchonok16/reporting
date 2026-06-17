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


class TfsAuthStatusOut(BaseModel):
    authenticated: bool
    baseUrl: str | None = None
    project: str | None = None
    authMode: str | None = None
    username: str | None = None
    appRole: Literal["full", "roadmap"] = "full"
    canSyncTfs: bool = False


class BoardOut(BaseModel):
    code: str
    name: str
    displayName: str
    project: str


class LinkedErrorOut(BaseModel):
    id: str
    title: str
    status: str | None = None
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
    ectResourceReservation: bool = False
    errors: list[LinkedErrorOut] = Field(default_factory=list)


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


class ProductStatusSheetOut(BaseModel):
    gid: str
    name: str
    columns: list[str]
    rows: list[dict[str, str]]
    totalShown: int


class ProductStatusB2BOut(BaseModel):
    title: str
    sourceUrl: str | None = None
    presentationReferenceUrl: str | None = None
    sheets: list[ProductStatusSheetOut]


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
        description="Приоритет колбаски на Roadmap: red — обязательно, yellow — средний, green — можно пропустить; null — сброс",
    )


class SyncRunOut(BaseModel):
    id: int
    status: str
    recordsFetched: int | None = None
    recordsUpserted: int | None = None
    errorMessage: str | None = None
    progressMessage: str | None = None
    startedAt: datetime
    finishedAt: datetime | None = None

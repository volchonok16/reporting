from datetime import date, datetime

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


class BoardOut(BaseModel):
    code: str
    name: str
    displayName: str
    project: str


class LinkedErrorOut(BaseModel):
    id: str
    title: str
    status: str | None = None


class QuarterOptionOut(BaseModel):
    key: str
    label: str


class ChangeRequestOut(BaseModel):
    id: str
    number: str
    title: str
    status: str | None = None
    boardColumn: str | None = None
    startDate: date | None = None
    releaseDate: date | None = None
    plannedDate: date | None = None
    planQuarter: str | None = None
    createdAt: datetime | None = None
    boardCode: str | None = None
    boardName: str | None = None
    errors: list[LinkedErrorOut] = Field(default_factory=list)


class DashboardMetricsOut(BaseModel):
    totalTasks: int
    launchingSoon: int
    launched: int
    errorsCount: int


class DashboardOut(BaseModel):
    board: BoardOut | None = None
    allBoards: bool = False
    metrics: DashboardMetricsOut
    items: list[ChangeRequestOut]
    totalShown: int
    availableStatuses: list[str] = Field(default_factory=list)
    availableQuarters: list[QuarterOptionOut] = Field(default_factory=list)


class SyncRunOut(BaseModel):
    id: int
    status: str
    recordsFetched: int | None = None
    recordsUpserted: int | None = None
    errorMessage: str | None = None
    progressMessage: str | None = None
    startedAt: datetime
    finishedAt: datetime | None = None

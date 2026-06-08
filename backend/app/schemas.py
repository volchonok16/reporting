from datetime import date, datetime

from pydantic import BaseModel, Field


class TfsAuthIn(BaseModel):
    baseUrl: str = Field(default="https://tfs.t2.ru/tfs/Main")
    project: str = Field(default="Tele2")
    projectId: str | None = None
    pat: str


class AuthLoginOut(BaseModel):
    sessionId: str


class AuthDefaultsOut(BaseModel):
    baseUrl: str
    project: str
    projectId: str | None = None


class TfsAuthStatusOut(BaseModel):
    authenticated: bool
    baseUrl: str | None = None
    project: str | None = None


class BoardOut(BaseModel):
    code: str
    name: str
    displayName: str
    project: str


class LinkedErrorOut(BaseModel):
    id: str
    title: str
    status: str | None = None


class ChangeRequestOut(BaseModel):
    id: str
    number: str
    title: str
    status: str | None = None
    startDate: date | None = None
    releaseDate: date | None = None
    createdAt: datetime | None = None
    boardCode: str | None = None
    boardName: str | None = None
    errors: list[LinkedErrorOut] = Field(default_factory=list)


class DashboardMetricsOut(BaseModel):
    totalTasks: int
    launchingSoon: int
    errorsCount: int


class DashboardOut(BaseModel):
    board: BoardOut
    metrics: DashboardMetricsOut
    items: list[ChangeRequestOut]
    totalShown: int


class SyncRunOut(BaseModel):
    id: int
    status: str
    recordsFetched: int | None = None
    recordsUpserted: int | None = None
    errorMessage: str | None = None
    startedAt: datetime
    finishedAt: datetime | None = None

from datetime import datetime

from pydantic import BaseModel, Field


class YouJailBoardMetaOut(BaseModel):
    id: int
    name: str
    slug: str
    description: str = ""
    sortOrder: int = 0
    isActive: bool = True
    teamIds: list[int] = Field(default_factory=list)


class YouJailBoardIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    slug: str | None = Field(default=None, min_length=1, max_length=64)
    description: str = ""
    sortOrder: int = 0
    teamIds: list[int] = Field(default_factory=list)


class YouJailBoardTeamsIn(BaseModel):
    teamIds: list[int] = Field(default_factory=list)


class YouJailTeamMemberOut(BaseModel):
    id: int
    teamId: int
    employeeId: int
    employeeName: str
    employeePhotoUrl: str | None = None
    role: str = "member"


class YouJailTeamOut(BaseModel):
    id: int
    name: str
    slug: str
    description: str = ""
    sortOrder: int = 0
    isActive: bool = True
    memberCount: int = 0
    boardIds: list[int] = Field(default_factory=list)
    members: list[YouJailTeamMemberOut] = Field(default_factory=list)


class YouJailTeamBoardsIn(BaseModel):
    boardIds: list[int] = Field(default_factory=list)


class YouJailTeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    slug: str | None = Field(default=None, min_length=1, max_length=64)
    description: str = ""
    sortOrder: int = 0


class YouJailTeamUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    sortOrder: int | None = None
    isActive: bool | None = None


class YouJailTeamMemberIn(BaseModel):
    employeeId: int
    role: str = "member"


class YouJailProjectOut(BaseModel):
    id: int
    name: str
    slug: str
    repoPath: str | None = None
    contextMd: str = ""
    instructionsMd: str = ""
    isActive: bool = True


class YouJailProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    slug: str | None = Field(default=None, min_length=1, max_length=64)
    repoPath: str | None = None
    contextMd: str = ""
    instructionsMd: str = ""


class YouJailProjectUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    repoPath: str | None = None
    contextMd: str | None = None
    instructionsMd: str | None = None
    isActive: bool | None = None


class YouJailTaskTypeOut(BaseModel):
    id: int
    name: str
    instructionsMd: str = ""
    sortOrder: int = 0
    isActive: bool = True


class YouJailTaskTypeIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    instructionsMd: str = ""
    sortOrder: int = 0


class YouJailTagOut(BaseModel):
    id: int
    name: str
    slug: str
    color: str | None = None


class YouJailTagIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


class YouJailColumnOut(BaseModel):
    id: int
    boardId: int
    columnKey: str
    title: str
    tone: str
    sortOrder: int


class YouJailColumnIn(BaseModel):
    title: str = Field(min_length=1, max_length=128)
    columnKey: str | None = Field(default=None, min_length=1, max_length=32)
    tone: str = Field(default="custom", min_length=1, max_length=32)


class YouJailColumnUpdateIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=128)
    tone: str | None = Field(default=None, min_length=1, max_length=32)
    sortOrder: int | None = None


class YouJailAttachmentOut(BaseModel):
    id: int
    cardId: int
    filename: str
    contentType: str | None = None
    sizeBytes: int
    downloadUrl: str
    createdAt: datetime


class YouJailExecutionLogOut(BaseModel):
    id: int
    seq: int
    stream: str
    content: str
    createdAt: datetime


class YouJailExecutionOut(BaseModel):
    id: int
    cardId: int
    executor: str
    status: str
    startedAt: datetime
    finishedAt: datetime | None = None
    exitCode: int | None = None
    errorMessage: str | None = None
    worktreePath: str | None = None
    logs: list[YouJailExecutionLogOut] = Field(default_factory=list)


class YouJailCardOut(BaseModel):
    id: int
    boardId: int
    columnId: int
    columnKey: str
    cardNumber: int
    cardKey: str
    projectId: int | None = None
    projectName: str | None = None
    taskTypeId: int | None = None
    taskTypeName: str | None = None
    title: str
    descriptionMd: str = ""
    pinned: bool = False
    archived: bool = False
    closedAt: datetime | None = None
    scheduledAt: datetime | None = None
    sortOrder: int = 0
    executor: str = "manual"
    worktreePath: str | None = None
    worktreeBranch: str | None = None
    executionStatus: str = "idle"
    assigneeEmployeeId: int | None = None
    tagIds: list[int] | None = None
    assigneeName: str | None = None
    assigneePhotoUrl: str | None = None
    tags: list[YouJailTagOut] = Field(default_factory=list)
    createdBy: str | None = None
    createdAt: datetime
    updatedAt: datetime
    attachments: list[YouJailAttachmentOut] = Field(default_factory=list)
    latestExecution: YouJailExecutionOut | None = None


class YouJailBoardOut(BaseModel):
    board: YouJailBoardMetaOut
    boards: list[YouJailBoardMetaOut]
    columns: list[YouJailColumnOut]
    cards: list[YouJailCardOut]
    projects: list[YouJailProjectOut]
    taskTypes: list[YouJailTaskTypeOut]
    tags: list[YouJailTagOut] = Field(default_factory=list)


class YouJailCardIn(BaseModel):
    title: str = Field(min_length=1, max_length=1000)
    descriptionMd: str = ""
    boardId: int | None = None
    columnId: int | None = None
    projectId: int | None = None
    taskTypeId: int | None = None
    scheduledAt: datetime | None = None
    executor: str = "manual"
    assigneeEmployeeId: int | None = None
    tagIds: list[int] | None = None


class YouJailCardUpdateIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=1000)
    descriptionMd: str | None = None
    columnId: int | None = None
    projectId: int | None = None
    taskTypeId: int | None = None
    scheduledAt: datetime | None = None
    executor: str | None = None
    assigneeEmployeeId: int | None = None
    tagIds: list[int] | None = None
    sortOrder: int | None = None


class YouJailCardMoveIn(BaseModel):
    columnId: int
    sortOrder: int | None = None


class YouJailExecuteIn(BaseModel):
    executor: str | None = None
    retryFeedback: str | None = None

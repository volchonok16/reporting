from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class AppNotificationOut(BaseModel):
    id: int
    title: str
    body: str
    audience: Literal["all", "users", "departments"]
    delivery: Literal["inbox", "popup"] = "inbox"
    createdAt: datetime
    readAt: datetime | None = None
    isRead: bool = False


class AppNotificationUnreadCountOut(BaseModel):
    count: int


class AppNotificationCreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    body: str = Field(min_length=1, max_length=4000)
    audience: Literal["all", "users", "departments"] = "all"
    delivery: Literal["inbox", "popup"] = "inbox"
    orgUserIds: list[int] = Field(default_factory=list)
    departmentIds: list[int] = Field(default_factory=list)


class AppNotificationCreateOut(BaseModel):
    id: int
    recipientCount: int

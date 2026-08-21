from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class AppNotification(Base):
    __tablename__ = "app_notification"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    audience: Mapped[str] = mapped_column(String(32), nullable=False)
    created_by_org_user_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("org_user.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class AppNotificationRecipient(Base):
    __tablename__ = "app_notification_recipient"
    __table_args__ = (UniqueConstraint("notification_id", "org_user_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    notification_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("app_notification.id", ondelete="CASCADE"),
        nullable=False,
    )
    org_user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("org_user.id", ondelete="CASCADE"),
        nullable=False,
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    popup_shown_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class AppError(Exception):
    code: str
    message: str
    status_code: int = 400
    source_row: int | None = None

    @property
    def detail(self) -> dict[str, Any]:
        result: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.source_row is not None:
            result["sourceRow"] = self.source_row
        return result


class CancelledError(Exception):
    """Internal cooperative-cancellation signal."""

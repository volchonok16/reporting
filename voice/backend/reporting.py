from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from .security import csv_injection_safe, mask_number


REPORT_HEADER = ("source_row", "code", "message", "masked_a", "masked_b")


class ReportWriter:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self.path.open("w", encoding="utf-8", newline="")
        self._writer = csv.writer(self._handle, lineterminator="\r\n")
        self._writer.writerow(REPORT_HEADER)
        self.rows = 0

    def add(
        self,
        *,
        source_row: int | str = "",
        code: str,
        message: str,
        a_number: Any = "",
        b_number: Any = "",
    ) -> None:
        values = (
            source_row,
            code,
            message,
            mask_number(a_number) if a_number not in ("", None) else "",
            mask_number(b_number) if b_number not in ("", None) else "",
        )
        self._writer.writerow([csv_injection_safe(value) for value in values])
        self.rows += 1

    def flush(self) -> None:
        self._handle.flush()

    def close(self) -> None:
        if not self._handle.closed:
            self._handle.flush()
            self._handle.close()

    def __enter__(self) -> "ReportWriter":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

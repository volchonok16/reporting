from dataclasses import dataclass

from app.config import settings
from app.tfs_auth import TfsAuth


@dataclass(frozen=True)
class BoardConfig:
    code: str
    name: str
    display_name: str
    project: str
    project_id: str
    team_id: str
    area_path: str
    base_url: str = settings.tfs_base_url

    def to_tfs_auth(self, pat: str) -> TfsAuth:
        return TfsAuth(
            base_url=self.base_url.rstrip("/"),
            project=self.project,
            project_id=self.project_id,
            pat=pat,
        )


ALL_BOARDS_CODE = "all"


BOARDS: list[BoardConfig] = [
    BoardConfig(
        code="digital_streams_b2b",
        name="Digital Streams B2b",
        display_name="Digital Streams B2b",
        project="Tele2",
        project_id="c56fb5fe-9752-462a-82ae-0b9e10364510",
        team_id="95d94210-a12e-4b11-b13b-4bbbc698d30b",
        area_path=r"Tele2\Digital\Streams\B2b",
    ),
    BoardConfig(
        code="be_t2_team",
        name="BE-T2 Team",
        display_name="BE-T2 Team",
        project="BE-T2",
        project_id="03cc4df6-e5d2-43a6-9f9a-024573edff5a",
        team_id="b085b610-9249-4077-8d41-6c29bb6853f5",
        area_path="BE-T2",
    ),
]


def is_all_boards(code: str | None) -> bool:
    return (code or "").strip().lower() == ALL_BOARDS_CODE


def board_by_code(code: str | None) -> BoardConfig | None:
    if not code or is_all_boards(code):
        return None
    normalized = code.strip().lower()
    for board in BOARDS:
        if board.code == normalized:
            return board
    return None


def boards_for_sync(board_code: str | None) -> list[BoardConfig]:
    if is_all_boards(board_code) or not board_code:
        return list(BOARDS)
    board = board_by_code(board_code)
    return [board] if board else list(BOARDS)


def default_board() -> BoardConfig:
    return BOARDS[0]

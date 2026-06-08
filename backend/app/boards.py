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
    sync_tags: tuple[str, ...] = ()
    error_sync_tags: tuple[str, ...] = ()
    exclude_sync_tags: tuple[str, ...] = ()
    exclude_sync_states: tuple[str, ...] = ()
    launching_soon_states: tuple[str, ...] = ()
    launching_soon_triage_values: tuple[str, ...] = ()
    launched_states: tuple[str, ...] = ()
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
        error_sync_tags=("FE B2B", "microservice"),
        exclude_sync_tags=("EFO",),
        launching_soon_states=("UAT",),
        launched_states=("Pilot", "Пилот"),
    ),
    BoardConfig(
        code="be_t2_team",
        name="BE Analytics",
        display_name="BE Analytics",
        project="BE-T2",
        project_id="03cc4df6-e5d2-43a6-9f9a-024573edff5a",
        team_id="cbc10e7f-8dfa-479f-9a31-0fa6258a1f9f",
        area_path=r"BE-T2\BE Analytics",
        sync_tags=("b2b_product",),
        error_sync_tags=("FE B2B", "microservice"),
        exclude_sync_states=("Rejected",),
        launching_soon_states=("UAT Prod", "Implementation Prod"),
        launching_soon_triage_values=("в Работе",),
        launched_states=("Closed",),
    ),
    BoardConfig(
        code="esb_analytics",
        name="ESB Analytics",
        display_name="ESB",
        project="BE-T2",
        project_id="03cc4df6-e5d2-43a6-9f9a-024573edff5a",
        team_id="69adf97c-07fc-4f05-98ad-3fa9c77b56d0",
        area_path=r"BE-T2\ESB\ESB Analytics",
        sync_tags=("b2b_product",),
        error_sync_tags=("FE B2B", "microservice"),
        exclude_sync_states=("Rejected",),
        launching_soon_states=("UAT Prod", "Implementation Prod"),
        launching_soon_triage_values=("в Работе",),
        launched_states=("Closed",),
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

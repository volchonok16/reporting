from app.boards import BoardConfig, set_boards_cache
from app.sync_service import _release_to_area_owner


def _board(code: str, area_path: str) -> BoardConfig:
    return BoardConfig(
        code=code,
        name=code,
        display_name=code,
        project="Tele2",
        project_id="proj",
        team_id="team",
        area_path=area_path,
    )


class _Db:
    def __init__(self) -> None:
        self.statements: list[str] = []

    def scalar(self, statement):
        self.statements.append(str(statement))
        return None


def test_parent_board_keeps_child_area_without_missing_column() -> None:
    parent = _board("core", r"Tele2\B2B Product")
    child = _board("ppo", r"Tele2\B2B Product\PPO")
    set_boards_cache([parent, child])
    db = _Db()
    kept = _release_to_area_owner(
        db,
        parent,
        {"id": 100, "fields": {"System.AreaPath": r"Tele2\B2B Product\PPO\Team"}},
        source_system_id=1,
    )
    assert kept is True
    assert db.statements
    assert "source_system_id" in db.statements[0]
    assert "task.source " not in db.statements[0].lower()


def test_own_area_is_synced_on_this_board() -> None:
    child = _board("ppo", r"Tele2\B2B Product\PPO")
    set_boards_cache([child])
    db = _Db()
    kept = _release_to_area_owner(
        db,
        child,
        {"id": 100, "fields": {"System.AreaPath": r"Tele2\B2B Product\PPO\Team"}},
        source_system_id=1,
    )
    assert kept is False
    assert db.statements == []

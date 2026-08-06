"""Seed досок ЗНИ для unit-тестов (зеркало миграции 043_zni_boards.sql)."""

from __future__ import annotations

from app.boards import BoardConfig, set_boards_cache

_TELE2_PROJECT = "Tele2"
_TELE2_PROJECT_ID = "c56fb5fe-9752-462a-82ae-0b9e10364510"
_TELE2_TEAM_ID = "95d94210-a12e-4b11-b13b-4bbbc698d30b"


def _tele2(
    *,
    code: str,
    name: str,
    alias: str,
    area_path: str,
    sync_tags: tuple[str, ...] = (),
) -> BoardConfig:
    return BoardConfig(
        code=code,
        name=name,
        display_name=alias,
        project=_TELE2_PROJECT,
        project_id=_TELE2_PROJECT_ID,
        team_id=_TELE2_TEAM_ID,
        area_path=area_path,
        sync_tags=sync_tags,
        exclude_sync_tags=("EFO", "not_product"),
        launching_soon_states=("UAT",),
        launched_states=("Pilot", "Пилот"),
    )


def default_test_boards() -> list[BoardConfig]:
    return [
        _tele2(
            code="digital_streams_b2b",
            name="Digital Streams B2b",
            alias="Digital",
            area_path=r"Tele2\Digital\Streams\B2b",
        ),
        _tele2(
            code="tele2_products",
            name="Продукты",
            alias="Продукты",
            area_path=r"Tele2\Продукты",
            sync_tags=("b2b_product",),
        ),
        _tele2(
            code="reports",
            name="Reports",
            alias="Reports",
            area_path=r"Tele2\Reports\Team A",
            sync_tags=("b2b_product",),
        ),
        _tele2(
            code="b2b_product_core",
            name="B2B Product",
            alias="CORE",
            area_path=r"Tele2\B2B Product",
        ),
        _tele2(
            code="b2b_product_partners",
            name="B2B Product Partners",
            alias="КАТС",
            area_path=r"Tele2\B2B Product Partners",
        ),
        _tele2(
            code="b2b_voice_products",
            name="B2B Voice Products",
            alias="Голосовые продукты",
            area_path=r"Tele2\B2B Product\B2B Voice Products",
        ),
        _tele2(
            code="b2b_m2m_platform",
            name="M2M Platform",
            alias="М2М / IoT",
            area_path=r"Tele2\B2B Product\M2M Platform",
        ),
        _tele2(
            code="b2b_sms_target",
            name="SMS-Target",
            alias="SMS",
            area_path=r"Tele2\B2B Product\SMS-Target",
        ),
        _tele2(
            code="b2b_solar",
            name="Solar",
            alias="Solar",
            area_path=r"Tele2\B2B Product\Solar",
        ),
        _tele2(
            code="b2b_umnico",
            name="Umnico",
            alias="Umnico",
            area_path=r"Tele2\B2B Product\Umnico",
        ),
        BoardConfig(
            code="be_t2_team",
            name="BE Analytics",
            display_name="Bercut",
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
            incident_error_area_path=r"BE-T2\Incident management",
            incident_error_sync_tags=("b2b_product",),
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


def install_default_boards() -> list[BoardConfig]:
    boards = default_test_boards()
    set_boards_cache(boards)
    return boards

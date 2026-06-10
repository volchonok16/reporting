from app.sync_service import is_excluded_sync_title
from app.tfs_client import wiql_exclude_title_patterns_clause
from app.zni_title_filters import is_excluded_zni_title


def test_excluded_mobile_carousel() -> None:
    title = "[Мобильная карусель] ООО Исаншин Владислав Валерьевич, ЛС 141343272"
    assert is_excluded_zni_title(title)


def test_excluded_voice_target() -> None:
    title = 'ООО "ФЕНИКС", Санкт-Петербург, ЛС 142414646 [VOICE TARGET]'
    assert is_excluded_zni_title(title)


def test_excluded_voice_target_case_insensitive() -> None:
    assert is_excluded_zni_title("Задача [voice target] тест")


def test_not_excluded_regular_title() -> None:
    assert not is_excluded_zni_title("ООО Ромашка, ЛС 123456789")
    assert not is_excluded_zni_title("")
    assert not is_excluded_zni_title(None)


def test_excluded_sync_title_from_fields() -> None:
    assert is_excluded_sync_title({"System.Title": "[Мобильная карусель] тест"})
    assert not is_excluded_sync_title({"System.Title": "Обычный ЗНИ"})


def test_wiql_exclude_title_patterns_clause() -> None:
    clause = wiql_exclude_title_patterns_clause(("[Мобильная карусель]", "[VOICE TARGET]"))
    assert "[System.Title] NOT CONTAINS '[Мобильная карусель]'" in clause
    assert "[System.Title] NOT CONTAINS '[VOICE TARGET]'" in clause
    assert wiql_exclude_title_patterns_clause(()) == ""

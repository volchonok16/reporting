from app.sync_service import is_excluded_sync_title
from app.tfs_client import wiql_exclude_title_patterns_clause
from app.zni_title_filters import is_excluded_zni_title


def test_excluded_efo_title() -> None:
    assert is_excluded_zni_title("[EFO] ООО Ромашка, ЛС 123")
    assert is_excluded_zni_title("Задача [efo] тест")
    assert is_excluded_zni_title("ООО Ромашка [EFO]")


def test_other_bracket_prefixes_are_kept() -> None:
    assert not is_excluded_zni_title("[voice] ООО Ромашка, ЛС 123")
    assert not is_excluded_zni_title("[voise] тест")
    assert not is_excluded_zni_title("[sms] тест")
    assert not is_excluded_zni_title("[qqq] тест")
    assert not is_excluded_zni_title("[Мобильная карусель] ООО Исаншин Владислав Валерьевич, ЛС 141343272")
    assert not is_excluded_zni_title('ООО "ФЕНИКС", Санкт-Петербург, ЛС 142414646 [VOICE TARGET]')
    assert not is_excluded_zni_title("Задача [voice target] тест")


def test_not_excluded_regular_title() -> None:
    assert not is_excluded_zni_title("ООО Ромашка, ЛС 123456789")
    assert not is_excluded_zni_title("EFO без скобок")
    assert not is_excluded_zni_title("[EFOO] похожий маркер")
    assert not is_excluded_zni_title("")
    assert not is_excluded_zni_title(None)


def test_excluded_sync_title_from_fields() -> None:
    assert is_excluded_sync_title({"System.Title": "[EFO] тест"})
    assert not is_excluded_sync_title({"System.Title": "[sms] обычный ЗНИ"})
    assert not is_excluded_sync_title({"System.Title": "Обычный ЗНИ"})


def test_wiql_skips_bracket_title_patterns() -> None:
    assert wiql_exclude_title_patterns_clause(("[EFO]", "[sms]", "[VOICE TARGET]")) == ""
    assert wiql_exclude_title_patterns_clause(("plain marker",)) == (
        " AND [System.Title] NOT CONTAINS 'plain marker'"
    )
    assert wiql_exclude_title_patterns_clause(()) == ""

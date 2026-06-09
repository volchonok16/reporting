from app.zni_description import (
    extract_business_goal_from_description,
    tfs_identity_display_name,
)


def test_tfs_identity_display_name() -> None:
    assert (
        tfs_identity_display_name("Синицына Анастасия Ашурбеговна <T2RU\\anastasia.sinitsyna>")
        == "Синицына Анастасия Ашурбеговна"
    )
    assert tfs_identity_display_name(None) is None


def test_extract_business_goal_from_description() -> None:
    html = (
        "<div><b>Текущая реализация* </b><br></div><div>Отсутствует.</div><br>"
        "<b>Цель и бизнес-смысл доработки*</b><br><div>Увеличение продаж БО.</div><br>"
        "<b>Детальные требования к изменению*</b><br><div>Ссылка на wiki.</div><br>"
        "<b>Ценность доработки/Ожидаемый эффект*</b><br><div>Эффект.</div>"
    )
    result = extract_business_goal_from_description(html)
    assert result is not None
    assert "Увеличение продаж БО." in result
    assert "Детальные требования к изменению" in result
    assert "Ссылка на wiki." in result
    assert "Эффект." not in result


def test_extract_business_goal_without_end_section() -> None:
    html = (
        "<b>Цель и бизнес-смысл доработки*</b><br><div>Только цель.</div><br>"
        "<b>Детальные требования к изменению*</b><br><div>Требования.</div>"
    )
    result = extract_business_goal_from_description(html)
    assert result == "Только цель.\n\nДетальные требования к изменению\nТребования."

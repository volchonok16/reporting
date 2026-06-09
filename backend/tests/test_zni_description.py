from app.zni_description import (
    extract_business_goal_from_description,
    tfs_identity_display_name,
)


def test_tfs_identity_display_name() -> None:
    assert (
        tfs_identity_display_name("Синицына Анастасия Ашурбеговна <T2RU\\anastasia.sinitsyna>")
        == "Синицына Анастасия Ашурбеговна"
    )
    assert tfs_identity_display_name(
        {"displayName": "Гагарин Георгий Геннадьевич", "uniqueName": "T2RU\\user"}
    ) == "Гагарин Георгий Геннадьевич"
    assert tfs_identity_display_name(
        "{'displayName': 'Гагарин Георгий Геннадьевич', 'url': 'https://tfs.t2.ru'}"
    ) == "Гагарин Георгий Геннадьевич"
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
    assert "Детальные требования к изменению" not in result
    assert "Ссылка на wiki." not in result
    assert "Эффект." not in result


def test_extract_business_goal_without_end_section() -> None:
    html = (
        "<b>Цель и бизнес-смысл доработки*</b><br><div>Только цель.</div><br>"
        "<b>Детальные требования к изменению*</b><br><div>Требования.</div>"
    )
    result = extract_business_goal_from_description(html)
    assert result == "Только цель."


def test_extract_business_goal_multi_paragraph_section() -> None:
    html = (
        "<b>Цель и бизнес-смысл доработки*</b><br>"
        "<div>Повысить процент базы с указанным кодовым словом.</div>"
        "<div>Это необходимо для изменения процесса идентификации.</div><br>"
        "<b>Детальные требования к изменению*</b><br>"
        "<div>Необходимо, чтобы в роли «Администратор»...</div>"
    )
    result = extract_business_goal_from_description(html)
    assert result is not None
    assert "Повысить процент базы" in result
    assert "изменения процесса идентификации" in result
    assert "Администратор" not in result

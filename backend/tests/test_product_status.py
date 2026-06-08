from app.product_status_service import parse_product_status_csv


def test_parse_product_status_csv() -> None:
    csv_text = (
        "Дата запуска,Проект,Описание проекта,Зачем и для чего делаем\n"
        "09.06,Ремонт,Убираем 300 рублевые офферы,\n"
        ",CORE,Перенос номеров,Для увел.абон базы\n"
    )
    rows = parse_product_status_csv(csv_text)
    assert len(rows) == 2
    assert rows[0].launchDate == "09.06"
    assert rows[0].project == "Ремонт"
    assert rows[0].description == "Убираем 300 рублевые офферы"
    assert rows[1].purpose == "Для увел.абон базы"


def test_parse_product_status_csv_skips_empty_rows() -> None:
    csv_text = "Дата запуска,Проект,Описание проекта,Зачем и для чего делаем\n,,,\n"
    assert parse_product_status_csv(csv_text) == []

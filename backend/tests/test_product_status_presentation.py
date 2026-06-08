from datetime import date

from app.product_status_presentation import (
    build_b2b_product_status_presentation,
    chunk_rows,
    presentation_filename,
    select_columns,
    template_path,
)
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut


def test_select_columns_keeps_first_four() -> None:
    columns = ["A", "B", "C", "D", "E"]
    assert select_columns(columns) == ["A", "B", "C", "D"]


def test_select_columns_prefers_status_column() -> None:
    columns = ["Дата", "Проект", "Описание", "Комментарий", "Статус"]
    assert select_columns(columns) == ["Дата", "Проект", "Описание", "Статус"]


def test_chunk_rows_splits_by_size() -> None:
    rows = [{"a": str(index)} for index in range(7)]
    assert len(chunk_rows(rows, 3)) == 3
    assert len(chunk_rows(rows, 3)[0]) == 3
    assert len(chunk_rows(rows, 3)[-1]) == 1


def test_chunk_rows_empty() -> None:
    assert chunk_rows([], 6) == [[]]


def test_presentation_filename() -> None:
    assert presentation_filename(date(2026, 6, 11)) == "status-b2b-11062026.pptx"


def test_build_b2b_product_status_presentation() -> None:
    data = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sourceUrl=None,
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Продуктовый офис: SMS",
                columns=["Дата запуска", "Проект", "Описание проекта", "Статус"],
                rows=[
                    {
                        "Дата запуска": "09.06",
                        "Проект": "Ремонт",
                        "Описание проекта": "Убираем 300 рублевые офферы",
                        "Статус": "В работе",
                    },
                    {
                        "Дата запуска": "",
                        "Проект": "CORE",
                        "Описание проекта": "Перенос номеров",
                        "Статус": "План",
                    },
                ],
                totalShown=2,
            )
        ],
    )

    content = build_b2b_product_status_presentation(data)
    assert template_path().is_file()
    assert content[:2] == b"PK"
    assert len(content) > 50_000

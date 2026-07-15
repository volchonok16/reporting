from __future__ import annotations

import io

from openpyxl import load_workbook

from app.revenue_activities_excel import generate_revenue_activities_excel
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut


def test_revenue_excel_exports_numbers_as_numeric_cells() -> None:
    data = ProductStatusB2BOut(
        title="Активности по выручкам",
        sheets=[
            ProductStatusSheetOut(
                gid="main",
                name="Активности по выручкам",
                columns=[
                    "Активность",
                    "Статус F2 2026",
                    "Ответственный",
                    "Влияние на базу, тыс",
                    "Влияние на выручку, млн",
                    "Влияние на gmc, млн",
                    "Комментарий",
                ],
                rows=[
                    {
                        "Активность": "Пилот",
                        "Статус F2 2026": "В работе",
                        "Ответственный": "Иванов",
                        "Влияние на базу, тыс": "10",
                        "Влияние на выручку, млн": "2,5",
                        "Влияние на gmc, млн": "1",
                        "Комментарий": "ок",
                    }
                ],
                totalShown=1,
            )
        ],
    )

    content, filename = generate_revenue_activities_excel(data)
    assert filename.startswith("aktivnosti-po-vyruchkam-")
    assert filename.endswith(".xlsx")

    workbook = load_workbook(io.BytesIO(content))
    sheet = workbook["Активности по выручкам"]
    assert sheet["A1"].value == "Активность"
    assert sheet["B1"].value == "Статус F2 2026"
    assert sheet["D1"].value == "Влияние на базу, тыс"
    assert sheet["A2"].value == "Пилот"
    assert sheet["D2"].value == 10
    assert sheet["E2"].value == 2.5
    assert sheet["F2"].value == 1
    assert sheet["G2"].value == "ок"
    assert sheet["A3"].value == "Итого"
    assert sheet["D3"].value == 10
    assert sheet["E3"].value == 2.5
    assert sheet["F3"].value == 1


def test_revenue_excel_keeps_non_numeric_influence_as_text() -> None:
    data = ProductStatusB2BOut(
        title="Активности по выручкам",
        sheets=[
            ProductStatusSheetOut(
                gid="main",
                name="Активности по выручкам",
                columns=["Активность", "Влияние на базу, тыс", "Комментарий"],
                rows=[
                    {
                        "Активность": "X",
                        "Влияние на базу, тыс": "н/д",
                        "Комментарий": "",
                    }
                ],
                totalShown=1,
            )
        ],
    )
    content, _ = generate_revenue_activities_excel(data)
    workbook = load_workbook(io.BytesIO(content))
    sheet = workbook.active
    assert sheet["B2"].value == "н/д"

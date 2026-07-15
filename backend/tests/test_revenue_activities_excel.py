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
                    "Влияние на базу",
                    "Влияние на выручку",
                    "Влияние на gmc",
                    "Комментарий",
                    "Результат",
                ],
                rows=[
                    {
                        "Активность": "Пилот",
                        "Влияние на базу": "10",
                        "Влияние на выручку": "2,5",
                        "Влияние на gmc": "1",
                        "Комментарий": "ок",
                        "Результат": "13.5",
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
    assert sheet["D1"].value == "Влияние на gmc"
    assert sheet["A2"].value == "Пилот"
    assert sheet["B2"].value == 10
    assert sheet["C2"].value == 2.5
    assert sheet["D2"].value == 1
    assert sheet["E2"].value == "ок"
    assert sheet["F2"].value == 13.5
    assert isinstance(sheet["B2"].value, (int, float))
    assert isinstance(sheet["F2"].value, float)
    assert sheet["A3"].value == "Итого"
    assert sheet["B3"].value == 10
    assert sheet["C3"].value == 2.5
    assert sheet["D3"].value == 1
    assert sheet["F3"].value == 13.5


def test_revenue_excel_keeps_non_numeric_influence_as_text() -> None:
    data = ProductStatusB2BOut(
        title="Активности по выручкам",
        sheets=[
            ProductStatusSheetOut(
                gid="main",
                name="Активности по выручкам",
                columns=["Активность", "Влияние на базу", "Результат"],
                rows=[
                    {
                        "Активность": "X",
                        "Влияние на базу": "н/д",
                        "Результат": "",
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

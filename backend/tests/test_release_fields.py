from app.release_fields import release_label_from_text, work_item_planned_release


def test_release_label_from_text() -> None:
    assert release_label_from_text("2026.08.11.0-R") == "2026.08.11.0-R"
    assert release_label_from_text("ЗНИ 2026.06.11.0-R extra") == "2026.06.11.0-R"


def test_planned_release_from_found_in_release() -> None:
    fields = {"Logrocon.FoundinRelease": "2026.06.02.0-R"}
    assert work_item_planned_release(fields) == "2026.06.02.0-R"


def test_planned_release_from_linked_logrocon_release() -> None:
    fields = {"Logrocon.Release": "Bercut InVoice 4.7.90.0 (1034184)"}
    assert work_item_planned_release(fields) == "Bercut InVoice 4.7.90.0 (1034184)"


def test_planned_release_empty() -> None:
    assert work_item_planned_release({}) is None
    assert work_item_planned_release(None) is None

from app.product_status_save_helpers import apply_row_order


def test_apply_row_order_reorders_known_rows() -> None:
    db_rows = [
        {"id": 10, "cells": {}},
        {"id": 20, "cells": {}},
        {"id": 30, "cells": {}},
    ]
    ordered = apply_row_order(db_rows, [30, 10, 20])
    assert [row["id"] for row in ordered] == [30, 10, 20]


def test_apply_row_order_appends_unknown_rows() -> None:
    db_rows = [
        {"id": 10, "cells": {}},
        {"id": 20, "cells": {}},
    ]
    ordered = apply_row_order(db_rows, [20])
    assert [row["id"] for row in ordered] == [20, 10]

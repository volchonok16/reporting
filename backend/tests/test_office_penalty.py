from app.office_penalty import clamp_points, rank_offices


def test_clamp_points_does_not_go_below_zero() -> None:
    assert clamp_points(2, -5) == 0
    assert clamp_points(2, 3) == 5


def test_rank_offices_from_high_score_and_shares_place() -> None:
    places = rank_offices(
        [
            {"gid": "sms", "name": "Офис: SMS", "points": 1, "sort_order": 10, "members": ["Анна"]},
            {"gid": "core", "name": "Офис: CORE", "points": 4, "sort_order": 60, "members": ["Иван", "Мария"]},
            {"gid": "voice", "name": "Офис: VOICE", "points": 4, "sort_order": 20, "members": []},
        ]
    )
    assert [(item["name"], item["place"], item["points"]) for item in places] == [
        ("Офис: VOICE", 1, 4),
        ("Офис: CORE", 1, 4),
        ("Офис: SMS", 2, 1),
    ]
    assert places[1]["members"] == ["Иван", "Мария"]

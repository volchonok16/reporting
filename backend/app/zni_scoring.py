"""Скоринг ЗНИ: Value из money/hours/nps (вилки), Urgency из дат, профиль из категории."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ZniExternalData, ZniScoringBand, ZniScoringProfile
from app.zni_plan_quarter import moscow_today, plan_quarter_is_overdue

Metric = str  # money | hours | nps


@dataclass(frozen=True)
class ScoringBand:
    metric: Metric
    min_value: Decimal | None
    max_value: Decimal | None
    score: int
    label: str | None


@dataclass(frozen=True)
class ScoringProfile:
    id: int
    code: str
    name: str
    weight_value: float
    weight_urgency: float
    is_out_of_queue: bool


@dataclass
class ScoringConfig:
    profiles_by_id: dict[int, ScoringProfile]
    profiles_by_code: dict[str, ScoringProfile]
    bands: list[ScoringBand]


def _dec(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def load_scoring_config(db: Session) -> ScoringConfig:
    profiles = [
        ScoringProfile(
            id=row.id,
            code=row.code,
            name=row.name,
            weight_value=float(row.weight_value or 0),
            weight_urgency=float(row.weight_urgency or 0),
            is_out_of_queue=bool(row.is_out_of_queue),
        )
        for row in db.scalars(
            select(ZniScoringProfile)
            .where(ZniScoringProfile.is_active.is_(True))
            .order_by(ZniScoringProfile.sort_order, ZniScoringProfile.id)
        ).all()
    ]
    bands = [
        ScoringBand(
            metric=row.metric,
            min_value=_dec(row.min_value),
            max_value=_dec(row.max_value),
            score=int(row.score),
            label=row.label,
        )
        for row in db.scalars(
            select(ZniScoringBand)
            .where(ZniScoringBand.is_active.is_(True))
            .order_by(ZniScoringBand.metric, ZniScoringBand.sort_order, ZniScoringBand.id)
        ).all()
    ]
    return ScoringConfig(
        profiles_by_id={p.id: p for p in profiles},
        profiles_by_code={p.code: p for p in profiles},
        bands=bands,
    )


def band_score_for_value(config: ScoringConfig, metric: Metric, value: Decimal | float | None) -> int | None:
    if value is None:
        return None
    amount = _dec(value)
    if amount is None:
        return None
    for band in config.bands:
        if band.metric != metric:
            continue
        lo_ok = band.min_value is None or amount >= band.min_value
        hi_ok = band.max_value is None or amount < band.max_value
        if lo_ok and hi_ok:
            return band.score
    return 0


def value_from_effects(
    config: ScoringConfig,
    *,
    effect_money: Decimal | float | None,
    effect_hours: Decimal | float | None,
    effect_nps: Decimal | float | None,
) -> tuple[int, dict[str, int | None]]:
    money = band_score_for_value(config, "money", effect_money)
    hours = band_score_for_value(config, "hours", effect_hours)
    nps = band_score_for_value(config, "nps", effect_nps)
    parts = [part for part in (money, hours, nps) if part is not None]
    value = max(parts) if parts else 0
    return value, {"money": money, "hours": hours, "nps": nps}


def urgency_from_dates(
    *,
    desired_date: date | None,
    plan_quarter: str | None,
    closed_on: date | None = None,
    today: date | None = None,
) -> int:
    """0 — нет срока; 1 — есть желаемая/квартал; 2 — просрочка."""
    current = today or moscow_today()
    overdue = False
    if desired_date is not None and desired_date < current:
        overdue = True
    if plan_quarter_is_overdue(plan_quarter, closed_on=closed_on, today=current):
        overdue = True
    if overdue:
        return 2
    if desired_date is not None or (plan_quarter and str(plan_quarter).strip()):
        return 1
    return 0


def urgency_to_scale(urgency: int) -> float:
    return {0: 0.0, 1: 3.0, 2: 5.0}.get(int(urgency), 0.0)


def profile_for_external(config: ScoringConfig, external: ZniExternalData | None) -> ScoringProfile | None:
    if external is None or external.category is None:
        return None
    profile_id = getattr(external.category, "scoring_profile_id", None)
    if profile_id is not None:
        return config.profiles_by_id.get(int(profile_id))
    profile = getattr(external.category, "scoring_profile", None)
    if profile is not None:
        return config.profiles_by_id.get(int(profile.id))
    return None


def compute_zni_score(
    config: ScoringConfig,
    *,
    profile: ScoringProfile | None,
    effect_money: Decimal | float | None,
    effect_hours: Decimal | float | None,
    effect_nps: Decimal | float | None,
    desired_date: date | None,
    plan_quarter: str | None,
    closed_on: date | None = None,
) -> dict[str, Any]:
    if profile is None:
        return {
            "scoringProfileCode": None,
            "scoringProfileName": None,
            "score": None,
            "scoreValue": None,
            "scoreUrgency": None,
            "effectBands": {"money": None, "hours": None, "nps": None},
        }
    if profile.is_out_of_queue:
        return {
            "scoringProfileCode": profile.code,
            "scoringProfileName": profile.name,
            "score": None,
            "scoreValue": None,
            "scoreUrgency": None,
            "effectBands": {"money": None, "hours": None, "nps": None},
        }

    value, bands = value_from_effects(
        config,
        effect_money=effect_money,
        effect_hours=effect_hours,
        effect_nps=effect_nps,
    )
    urgency = urgency_from_dates(
        desired_date=desired_date,
        plan_quarter=plan_quarter,
        closed_on=closed_on,
    )
    score = round(
        profile.weight_value * float(value) + profile.weight_urgency * urgency_to_scale(urgency),
        3,
    )
    return {
        "scoringProfileCode": profile.code,
        "scoringProfileName": profile.name,
        "score": score,
        "scoreValue": value,
        "scoreUrgency": urgency,
        "effectBands": bands,
    }


def scoring_payload_from_external(
    config: ScoringConfig,
    external: ZniExternalData | None,
    *,
    effective_desired: date | None = None,
    closed_on: date | None = None,
) -> dict[str, Any]:
    empty = {
        "scoringProfileCode": None,
        "scoringProfileName": None,
        "score": None,
        "scoreValue": None,
        "scoreUrgency": None,
        "effectMoney": None,
        "effectHours": None,
        "effectNps": None,
        "effectBands": {"money": None, "hours": None, "nps": None},
    }
    if external is None:
        return empty

    desired = effective_desired if effective_desired is not None else external.desired_date
    profile = profile_for_external(config, external)
    computed = compute_zni_score(
        config,
        profile=profile,
        effect_money=external.effect_money,
        effect_hours=external.effect_hours,
        effect_nps=external.effect_nps,
        desired_date=desired,
        plan_quarter=external.plan_quarter,
        closed_on=closed_on,
    )
    return {
        **computed,
        "effectMoney": float(external.effect_money) if external.effect_money is not None else None,
        "effectHours": float(external.effect_hours) if external.effect_hours is not None else None,
        "effectNps": float(external.effect_nps) if external.effect_nps is not None else None,
    }


def validate_non_negative(value: float | Decimal | None, *, field: str) -> Decimal | None:
    if value is None:
        return None
    amount = _dec(value)
    if amount is None:
        return None
    if amount < 0:
        raise ValueError(f"{field}: значение не может быть отрицательным")
    return amount


def scoring_config_payload(config: ScoringConfig) -> dict[str, Any]:
    return {
        "profiles": [
            {
                "id": p.id,
                "code": p.code,
                "name": p.name,
                "weightValue": p.weight_value,
                "weightUrgency": p.weight_urgency,
                "isOutOfQueue": p.is_out_of_queue,
            }
            for p in sorted(config.profiles_by_id.values(), key=lambda row: row.id)
        ],
        "bands": [
            {
                "metric": b.metric,
                "minValue": float(b.min_value) if b.min_value is not None else None,
                "maxValue": float(b.max_value) if b.max_value is not None else None,
                "score": b.score,
                "label": b.label,
            }
            for b in config.bands
        ],
    }

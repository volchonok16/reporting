from sqlalchemy import select

from app.domain.validation import validate_inn
from app.domain.output_spec import CONTRACTS
from app.errors import ApiError
from app.models import WhitemavInn

DEFAULT_INNS = (CONTRACTS['WHITEMAV']['files']['NUMBERS']['defaults']['INN'], '7707083893')


def checked_inn(value):
    issues = validate_inn(value)
    if issues:
        raise ValueError(issues[0]['message'])
    return value


def inn_choices(db, owner_id):
    return inn_directory(db, owner_id)['items']


def inn_directory(db, owner_id):
    saved = db.scalars(select(WhitemavInn).where(WhitemavInn.owner_id == owner_id)
                       .order_by(WhitemavInn.created_at, WhitemavInn.id)).all()
    names = dict.fromkeys(DEFAULT_INNS, '')
    for item in saved:
        if item.is_deleted:
            names.pop(item.inn, None)
        else:
            names[item.inn] = item.company_name
    return {'items': list(names), 'entries': [{'inn': inn, 'company_name': name} for inn, name in names.items()]}


def selected_inn(db, owner_id, value=None):
    value = value if value is not None else DEFAULT_INNS[0]
    try:
        checked_inn(value)
    except ValueError as error:
        raise ApiError(422, 'invalid_whitemav_inn', str(error)) from None
    if value not in inn_choices(db, owner_id):
        raise ApiError(422, 'unknown_whitemav_inn', 'Сначала добавьте ИНН в список исключений.')
    return value

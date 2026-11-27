from uuid import uuid4

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.api.schemas import WhitemavInnInput, WhitemavInnList, WhitemavInnNameInput
from app.auth.policy import check_mutation, permission
from app.db import get_db
from app.domain.whitemav_inns import DEFAULT_INNS, checked_inn, inn_directory, selected_inn
from app.errors import ApiError
from app.models import AuditEvent, WhitemavInn

router = APIRouter(prefix='/api/whitemav/inns', tags=['whitemav'])


@router.get('', response_model=WhitemavInnList)
def list_inns(user=Depends(permission('case.read')), db=Depends(get_db)):
    return inn_directory(db, user.id)


@router.post('', response_model=WhitemavInnList, dependencies=[Depends(check_mutation)])
def add_inn(body: WhitemavInnInput, user=Depends(permission('case.edit')), db=Depends(get_db)):
    identity = db.scalar(insert(WhitemavInn).values(id=uuid4(), owner_id=user.id, inn=body.inn, company_name=body.company_name)
                         .on_conflict_do_update(index_elements=['owner_id', 'inn'],
                            set_={'is_deleted': False, 'company_name': body.company_name},
                            where=WhitemavInn.is_deleted.is_(True)).returning(WhitemavInn.id))
    if identity:
        db.add(AuditEvent(actor_id=user.id, action='whitemav.inn.add', details={'inn': body.inn, 'company_name': body.company_name}))
    db.commit()
    return inn_directory(db, user.id)


@router.put('/{inn}', response_model=WhitemavInnList, dependencies=[Depends(check_mutation)])
def name_inn(inn: str, body: WhitemavInnNameInput, user=Depends(permission('case.edit')), db=Depends(get_db)):
    selected_inn(db, user.id, inn)
    db.execute(insert(WhitemavInn).values(id=uuid4(), owner_id=user.id, inn=inn, company_name=body.company_name)
               .on_conflict_do_update(index_elements=['owner_id', 'inn'], set_={'company_name': body.company_name}))
    db.add(AuditEvent(actor_id=user.id, action='whitemav.inn.name', details={'inn': inn, 'company_name': body.company_name}))
    db.commit()
    return inn_directory(db, user.id)


@router.delete('/{inn}', response_model=WhitemavInnList, dependencies=[Depends(check_mutation)])
def delete_inn(inn: str, user=Depends(permission('case.edit')), db=Depends(get_db)):
    try:
        checked_inn(inn)
    except ValueError as error:
        raise ApiError(422, 'invalid_whitemav_inn', str(error)) from None
    if inn not in DEFAULT_INNS and not db.scalar(select(WhitemavInn.id).where(WhitemavInn.owner_id == user.id, WhitemavInn.inn == inn)):
        raise ApiError(404, 'whitemav_inn_not_found', 'ИНН не найден в вашем справочнике.')
    identity = db.scalar(insert(WhitemavInn).values(id=uuid4(), owner_id=user.id, inn=inn, is_deleted=True)
                         .on_conflict_do_update(index_elements=['owner_id', 'inn'], set_={'is_deleted': True},
                            where=WhitemavInn.is_deleted.is_(False)).returning(WhitemavInn.id))
    if identity:
        db.add(AuditEvent(actor_id=user.id, action='whitemav.inn.delete', details={'inn': inn}))
    db.commit()
    return inn_directory(db, user.id)

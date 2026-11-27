"""Global reference data and partner profiles, with atomic versioned publication."""
from copy import deepcopy
from uuid import uuid4

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from pydantic import ValidationError

from app.admin.publish_rules import active_snapshot, publish_rules
from app.api.schemas import MnemonicWriteBody, PartnerSettingsBody, ProcessingSettingsState
from app.auth.policy import check_mutation, permission
from app.db import get_db
from app.domain.operations import canonical_digest, complete_operation, find_operation
from app.domain.rules import seed_config, operator_value
from app.errors import ApiError
from app.models import AuditEvent, Operation, ProcessingMnemonic

router = APIRouter(tags=['processing-settings'])


def settings_lock(db):
    # Same lock as CLI publication: profiles and catalogue cannot race each other.
    db.execute(text('SELECT pg_advisory_xact_lock(731946204)'))


def settings_state(db, user):
    snapshot = active_snapshot(db)
    profiles = deepcopy((snapshot['config'] if snapshot else seed_config())['profiles'])
    profiles.setdefault('ГПБМ', seed_config()['profiles']['ГПБМ'])
    for profile in profiles.values():
        profile['INTERNAL_OPERATOR_NAME'] = operator_value(profile['INTERNAL_OPERATOR_NAME'])
    entries = [{'id': str(item.id), 'code': item.code, 'description': item.description,
                'used_by': sorted(partner for partner, profile in profiles.items()
                                  if profile['INTERNAL_OPERATOR_NAME'] == item.code)}
               for item in db.scalars(select(ProcessingMnemonic).order_by(ProcessingMnemonic.code))
               if operator_value(item.code)]
    token = canonical_digest({'rules_digest': snapshot['digest'] if snapshot else None, 'mnemonics': entries})
    return {'token': token, 'can_manage': 'rules.publish' in user.permissions,
            'rules_ready': snapshot is not None, 'profiles': profiles, 'mnemonics': entries}


def begin_write(db, user, body, action):
    settings_lock(db)
    digest = canonical_digest(body.model_dump(mode='json', exclude={'operation_id'}))
    previous = find_operation(db, user.id, None, action, body.operation_id, digest)
    if previous:
        return previous, None
    before = settings_state(db, user)
    if body.expected_token != before['token']:
        raise ApiError(409, 'settings_changed', 'Настройки изменились. Обновите справочник и повторите изменения.')
    operation = Operation(owner_id=user.id, case_id=None, action=action,
        client_operation_id=body.operation_id, request_digest=digest)
    db.add(operation)
    db.flush()
    return operation, before


def finish_write(db, user, operation, details):
    db.flush()
    result = settings_state(db, user)
    complete_operation(operation, result)
    db.add(AuditEvent(actor_id=user.id, operation_id=operation.id, action=operation.action, details=details))
    db.commit()
    return result


@router.get('/api/processing-settings', response_model=ProcessingSettingsState)
def read_settings(user=Depends(permission('case.read')), db=Depends(get_db)):
    settings_lock(db)
    return settings_state(db, user)


@router.post('/api/dictionary/mnemonics', response_model=ProcessingSettingsState,
             dependencies=[Depends(check_mutation)])
def write_mnemonic(body: MnemonicWriteBody, user=Depends(permission('rules.publish')), db=Depends(get_db)):
    operation, before = begin_write(db, user, body, 'dictionary.mnemonic.' + body.action)
    if before is None:
        return operation.result
    item = db.get(ProcessingMnemonic, body.mnemonic_id) if body.mnemonic_id else None
    if body.action != 'add' and item is None:
        raise ApiError(404, 'mnemonic_not_found', 'Мнемоника не найдена.')
    original = {'code': item.code, 'description': item.description} if item else None
    used = item and any(p['INTERNAL_OPERATOR_NAME'] == item.code for p in before['profiles'].values())
    if used and (body.action == 'delete' or body.code != item.code):
        raise ApiError(409, 'mnemonic_in_use', 'Мнемоника используется партнёром. Сначала выберите другую в настройках партнёров.')
    if body.action == 'delete':
        db.delete(item)
    else:
        existing = db.scalar(select(ProcessingMnemonic).where(ProcessingMnemonic.code == body.code))
        if existing and (item is None or existing.id != item.id):
            raise ApiError(409, 'mnemonic_exists', 'Такая мнемоника уже есть в справочнике.')
        if item is None:
            item = ProcessingMnemonic(code=body.code, description=body.description.strip())
            db.add(item)
        else:
            item.code, item.description = body.code, body.description.strip()
    db.flush()
    return finish_write(db, user, operation, {'mnemonic_id': str(item.id), 'before': original,
        'after': None if body.action == 'delete' else {'code': item.code, 'description': item.description}})


@router.post('/api/processing-settings/partners', response_model=ProcessingSettingsState,
             dependencies=[Depends(check_mutation)])
def write_partners(body: PartnerSettingsBody, user=Depends(permission('rules.publish')), db=Depends(get_db)):
    operation, before = begin_write(db, user, body, 'dictionary.partner_settings')
    if before is None:
        return operation.result
    profiles = {partner: profile.model_dump(exclude_none=True) for partner, profile in body.profiles.items()}
    if not before['profiles'].keys() <= profiles.keys():
        raise ApiError(422, 'partner_removal', 'Сохраните настройки существующих партнёров.')
    if any(profile.get('IS_MAV') == profile.get('IS_KSS') == '0' for profile in profiles.values()):
        raise ApiError(422, 'flags_both_zero', 'IS_MAV и IS_KSS не могут одновременно быть 0.')
    known = {'', *(item['code'] for item in before['mnemonics'])}
    if any(profile['INTERNAL_OPERATOR_NAME'] not in known for profile in profiles.values()):
        raise ApiError(422, 'mnemonic_required', 'Выберите внутреннее имя оператора из справочника «Мнемоника».')
    snapshot = active_snapshot(db)
    config = deepcopy(snapshot['config'] if snapshot else seed_config())
    config.update(version='partner-settings-' + uuid4().hex, profiles=profiles)
    try:
        publication = publish_rules(db, user, config, reason='Настройки партнёров сохранены через справочник')
    except ValidationError:
        raise ApiError(422, 'invalid_partner_settings', 'Названия партнёров должны быть уникальными. WhiteMAV зарезервировано.') from None
    return finish_write(db, user, operation, {'before': before['profiles'], 'after': profiles,
        'rule_publication_id': str(publication.id)})

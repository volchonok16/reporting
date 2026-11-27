"""Resolve immutable reader selection once; v1 parsing remains an explicit legacy branch."""
from app.domain.readers.base import MappedSource
from app.domain.ingress import HUB_COLUMNS
from app.models import IntakeAssessment
from app.storage.local import StorageFailure


ADD_FIELD_DEFAULTS = {'IS_MAV': '0', 'MAV_LABEL_NAME': '', 'MAV_LABEL_LATIN': ''}


def reader_result(db, revision):
    if revision.assessment_id is None:
        return None
    assessment = db.get(IntakeAssessment, revision.assessment_id)
    if not assessment or assessment.reader_version not in {
            'numbers-table-v1', 'xlsb-table-v1', 'csv-table-v4', 'xlsx-table-v4', 'xls-table-v4', 'csv-table-v2', 'xlsx-table-v2', 'xls-table-v2', 'csv-table-v3', 'xlsx-table-v3', 'xls-table-v3'}:
        raise StorageFailure()
    return assessment.result


def mapped_reader(storage, source_id, result):
    if result is None:
        return None
    try:
        required = ('MSISDN',) if result.get('operation') in ('DELETE', 'WHITEMAV') else None
        options = {'required': required} if required else {}
        defaults = result.get('field_defaults', {})
        if result.get('operation') in ('ADD', 'CHANGE') and defaults:
            mapping = result['mapping']
            if (set(defaults) != set(HUB_COLUMNS) - mapping.keys()
                    or not mapping.keys() <= set(HUB_COLUMNS)
                    or any(value not in (('', '0', '1') if field in ('IS_MAV', 'IS_KSS') else ('',))
                           for field, value in defaults.items())):
                raise ValueError('Source fields differ from the defaulted contract.')
            options = {'required': tuple(mapping), 'defaults': defaults}
        elif defaults not in ({}, {'IS_MAV': '0'}):
            raise ValueError('Unsupported source field defaults.')
        if result.get('operation') == 'REPAIR':
            from app.domain.repair import SOURCE_FIELDS
            role = result['repair_role']
            required = (*SOURCE_FIELDS[role], 'STATUS')
            if role == 'NUMBERS' and 'MAV_OPERATOR_NAME' in result.get('record_fields', []):
                required = (*required, 'MAV_OPERATOR_NAME')
            minimum = ('INN', 'STATUS') if role == 'CLIENTS' else (*SOURCE_FIELDS[role], 'STATUS')
            if defaults:
                minimum = tuple(field for field in minimum if field != 'IS_MAV')
            mapping = result['mapping']
            if not set(minimum) <= set(mapping) <= set(required):
                raise ValueError('Repair source fields differ from its selected role.')
            options = {'required': tuple(mapping), 'defaults': {**{field: '' for field in required}, **defaults}}
        return MappedSource(storage, result['raw_index_key'], source_id, result['mapping'], **options)
    except (KeyError, ValueError):
        raise StorageFailure() from None


def inspection_for(source, parsed):
    if parsed is None:
        return source.inspection
    return {'columns': parsed.index['columns'], 'records_count': parsed.summary['records_count'],
            'schema_supported': True, 'errors': parsed.summary['file_errors'],
            'contract_version': parsed.index['reader_version']}

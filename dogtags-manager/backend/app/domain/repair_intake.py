"""Recognize a returned CSV role without treating its STATUS as database evidence."""
from app.domain.readers.mapping import map_columns


def configure_repair(result, questions, decisions, aliases):
    from app.domain.repair import SOURCE_FIELDS
    from app.processing.discovery import question
    columns = result['columns']
    role = decisions.get('repair_role')
    probes = map_columns(columns, aliases, ('INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN'))
    if not role:
        if 'MSISDN' in probes['mapping']:
            role = 'NUMBERS'
        elif 'MAV_LABEL_LATIN' in probes['mapping']:
            role = 'DOGTAGS'
        elif 'INN' in probes['mapping'] and not any(probes['candidates'][f] for f in
                                                  ('MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN')):
            role = 'CLIENTS'
    result['repair_role'] = role
    if role not in SOURCE_FIELDS:
        questions.append(question('repair_role', 'repair_role_required',
            'Выберите тип возвращённого файла.', options=['CLIENTS', 'DOGTAGS', 'NUMBERS']))
        result['mapping'] = {}
        return
    fields = (*SOURCE_FIELDS[role], 'STATUS')
    if role == 'NUMBERS':
        fields = (*fields, 'MAV_OPERATOR_NAME')
    analysis = map_columns(columns, aliases, fields)
    required = ('INN', 'STATUS') if role == 'CLIENTS' else (*SOURCE_FIELDS[role], 'STATUS')
    required = tuple(field for field in required if field != 'IS_MAV')
    mapping = decisions.get('mapping') if decisions.get('mapping') is not None else analysis['mapping']
    complete = (set(required) <= set(mapping) <= set(fields)
                and len(set(mapping.values())) == len(mapping)
                and all(type(i) is int and 0 <= i < len(columns) for i in mapping.values())
                and (decisions.get('mapping') is not None or not analysis['ambiguous']))
    # Explicit mapping resolves header ambiguity; missing optional CLIENTS cells default to empty.
    defaults = {'IS_MAV': '0'} if role == 'NUMBERS' and 'IS_MAV' not in mapping else {}
    result.update(mapping=mapping, mapping_analysis=analysis, record_fields=list(fields), field_defaults=defaults)
    if not complete:
        questions.append(question('mapping', 'mapping_required',
            'Укажите соответствие колонок возвращённого файла, включая STATUS.',
            required=list(required), columns=columns))


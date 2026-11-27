"""One versioned operation contract for serialization, review and release."""
import json

from app.domain.source_inspection import CONTRACT_ROOT

CONTRACTS = {operation: json.loads((CONTRACT_ROOT / name).read_text()) for operation, name in
             [('ADD', 'output-v1.json'), ('DELETE', 'delete-v1.json'), ('WHITEMAV', 'whitemav-v1.json')]}
SPEC_VERSION = 'operation-output-v1'
MANIFEST_VERSION = 'operation-artifact-manifest-v2'


def output_spec(operation='ADD'):
    if operation == 'REPAIR':
        return repair_spec()
    if operation == 'CHANGE':
        add = output_spec('ADD')
        roles = ['DELETE', *add['roles']]
        return {**add, 'operation': 'CHANGE', 'contract': 'linked-change-v1',
                'roles': roles, 'archive_roles': roles, 'stages': [
                    {'id': 'DELETE', 'roles': ['DELETE'], 'depends_on': []},
                    {'id': 'ADD', 'roles': add['roles'], 'depends_on': ['DELETE']}]}
    if operation not in CONTRACTS:
        raise ValueError('Unsupported output operation.')
    contract = CONTRACTS[operation]
    return {'version': SPEC_VERSION, 'operation': operation, 'contract': contract['version'],
            'serialization': contract['serialization'],
            'stages': [{'id': operation, 'roles': contract['order'], 'depends_on': []}],
            'roles': contract['order'], 'archive_roles': contract['order']}


def revision_spec(revision):
    settings = getattr(revision, 'settings', {})
    operation = settings.get('operation', 'ADD')
    saved = settings.get('output_spec')
    spec = (repair_spec(settings.get('repair_role'), version=(saved or {}).get('version', 'repair-output-v2'))
            if operation == 'REPAIR' else source_spec(operation) if source_separation(settings) else output_spec(operation))
    if saved is not None and saved != spec:
        raise ValueError('Unsupported pinned output specification.')
    if operation != 'ADD' and saved is None:
        raise ValueError('Operation requires a pinned output specification.')
    return spec


def dataset_operation(dataset):
    return dataset.summary.get('operation', 'ADD')


def file_definition(role, operation='ADD', *, error_source=None):
    if role in ('ERRORS', 'ERROR_OTHER_OPERATOR') and operation in ('ADD', 'DELETE', 'REPAIR', 'WHITEMAV'):
        if error_source is not None:
            if error_source['version'] != 'source-error-cells-v1':
                raise ValueError('Unsupported error source layout.')
            columns = list(error_source['columns'])
            if role == 'ERRORS' and error_source.get('diagnostic_column'):
                columns.append(error_source['diagnostic_column'])
            return {'columns': columns, 'required': [],
                    'encoding': 'utf-8', 'utf8_bom': error_source.get('utf8_bom', False), 'purpose': 'source-errors'}
        from app.domain.repair import ERROR_COLUMNS
        return {'columns': list(ERROR_COLUMNS), 'required': ['SOURCE_ROW', 'ERROR_FIELDS', 'ERROR_MESSAGES'],
                'encoding': 'utf-8', 'purpose': 'diagnostic'}
    if operation == 'REPAIR':
        return file_definition(role, 'DELETE' if role == 'DELETE' else 'ADD')
    spec = output_spec(operation)
    if role not in spec['roles']:
        raise ValueError('Role is outside the operation contract.')
    contract = ('DELETE' if role == 'DELETE' else 'ADD') if operation == 'CHANGE' else operation
    return CONTRACTS[contract]['files'][role]


def dataset_file_definition(dataset, role):
    layout = dataset.summary.get('error_source')
    if role in ('ERRORS', 'ERROR_OTHER_OPERATOR') and layout:
        from app.domain.error_exports import export_layout
        layout = export_layout(dataset, role)
    return file_definition(role, dataset_operation(dataset), error_source=layout)


def manifest_spec(manifest):
    if manifest.get('version') == 'hub-artifact-manifest-v1':
        return output_spec('ADD')
    if manifest.get('version') != MANIFEST_VERSION:
        raise ValueError('Unsupported artifact manifest.')
    saved = manifest['output_spec']
    expected = (repair_spec(saved['source_role'], saved['roles'], version=saved['version'])
                if saved.get('version') in ('repair-output-v1', 'repair-output-v2', 'repair-output-v3')
                else source_spec(saved['operation'], saved['roles']) if saved.get('version') == 'source-output-v1'
                else retry_spec(saved['operation'], saved['roles']) if saved.get('version') == 'retry-output-v1'
                else output_spec(saved['operation']))
    if saved != expected:
        raise ValueError('Artifact specification differs from its versioned contract.')
    return saved


def retry_spec(operation, roles):
    base = output_spec(operation)
    if operation not in ('ADD', 'DELETE') or not roles or roles != [r for r in base['roles'] if r in roles]:
        raise ValueError('A retry requires a nonempty ordered subset of its stage.')
    return {**base, 'version': 'retry-output-v1', 'roles': roles, 'archive_roles': roles,
            'stages': [{'id': operation, 'roles': roles, 'depends_on': []}]}


def dataset_spec(dataset):
    return dataset.summary.get('output_spec') or output_spec(dataset_operation(dataset))


def source_separation(settings):
    return (settings.get('row_error_policy') == 'separate-source-errors-v1'
            and settings.get('operation', 'ADD') in ('ADD', 'DELETE', 'WHITEMAV') and not settings.get('retry'))


def source_spec(operation='ADD', roles=None):
    """Frozen preparation policy; business templates remain the original contracts."""
    if operation not in ('ADD', 'DELETE', 'WHITEMAV'):
        raise ValueError('Source separation is limited to ADD and DELETE.')
    base = output_spec(operation)
    allowed = [*base['roles'], 'ERRORS']
    selected = allowed if roles is None else list(roles)
    if not selected or selected != [role for role in allowed if role in selected]:
        raise ValueError('Source outputs require an ordered nonempty subset.')
    imports = [role for role in selected if role != 'ERRORS']
    stages = ([{'id': operation, 'roles': imports, 'depends_on': []}] if imports else [])
    if 'ERRORS' in selected:
        stages.append({'id': 'DIAGNOSTIC', 'roles': ['ERRORS'], 'depends_on': []})
    return {**base, 'version': 'source-output-v1', 'roles': selected, 'archive_roles': selected,
            'row_error_policy': 'separate-source-errors-v1', 'stages': stages,
            'diagnostic_roles': ['ERRORS'] if 'ERRORS' in selected else [],
            'serialization': {key: value for key, value in base['serialization'].items() if key != 'encoding'},
            'encoding_by_role': {role: 'utf-8' if role == 'ERRORS' else 'cp1251' for role in selected}}


def repair_spec(source_role=None, roles=None, *, version='repair-output-v3'):
    """A preparation contract: unchanged import templates plus a separate diagnostic CSV."""
    if version not in ('repair-output-v1', 'repair-output-v2', 'repair-output-v3'):
        raise ValueError('Unsupported repair output version.')
    permitted = {'CLIENTS': ['CLIENTS', 'ERRORS'], 'DOGTAGS': ['CLIENTS', 'DOGTAGS', 'ERRORS'],
                 'NUMBERS': ['CLIENTS', 'NUMBERS', 'DELETE', 'ERRORS'],
                 None: ['CLIENTS', 'DOGTAGS', 'NUMBERS', 'DELETE', 'ERRORS']}
    if source_role not in permitted:
        raise ValueError('Unsupported returned file role.')
    allowed = permitted[source_role]
    if version == 'repair-output-v3' and source_role in (None, 'NUMBERS'):
        allowed = [*allowed, 'ERROR_OTHER_OPERATOR']
    selected = allowed if roles is None else list(roles)
    if not selected or selected != [role for role in allowed if role in selected]:
        raise ValueError('Repair requires an ordered nonempty subset of its outputs.')
    diagnostics = [role for role in selected if role in ('ERRORS', 'ERROR_OTHER_OPERATOR')]
    imports = [role for role in selected if role not in ('DELETE', *diagnostics)]
    stages = []
    if 'DELETE' in selected:
        stages.append({'id': 'DELETE', 'roles': ['DELETE'], 'depends_on': []})
    if imports:
        stages.append({'id': 'ADD', 'roles': imports, 'depends_on': ['DELETE'] if 'DELETE' in selected else []})
    if diagnostics:
        stages.append({'id': 'DIAGNOSTIC', 'roles': diagnostics, 'depends_on': []})
    spec = {'version': version, 'operation': 'REPAIR', 'contract': 'status-repair-v1',
            'source_role': source_role, 'serialization': CONTRACTS['ADD']['serialization'],
            'roles': selected, 'archive_roles': selected, 'stages': stages,
            'diagnostic_roles': diagnostics}
    if version in ('repair-output-v2', 'repair-output-v3'):
        spec['serialization'] = {key: value for key, value in spec['serialization'].items() if key != 'encoding'}
        spec['encoding_by_role'] = {role: 'utf-8' if role in diagnostics else 'cp1251' for role in selected}
    return spec

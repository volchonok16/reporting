from types import SimpleNamespace

import pytest

from app.domain.output_spec import MANIFEST_VERSION, manifest_spec, repair_spec, revision_spec


def test_repair_declares_encoding_for_each_output_role():
    spec = repair_spec('NUMBERS')
    assert spec['version'] == 'repair-output-v3'
    assert 'encoding' not in spec['serialization']
    assert spec['encoding_by_role'] == {
        'CLIENTS': 'cp1251', 'NUMBERS': 'cp1251', 'DELETE': 'cp1251', 'ERRORS': 'utf-8', 'ERROR_OTHER_OPERATOR': 'utf-8'}
    assert manifest_spec({'version': MANIFEST_VERSION, 'output_spec': spec}) == spec
    spec['encoding_by_role']['ERRORS'] = 'cp1251'
    with pytest.raises(ValueError):
        manifest_spec({'version': MANIFEST_VERSION, 'output_spec': spec})


def test_historical_repair_spec_stays_pinned_and_verifiable():
    spec = repair_spec('DOGTAGS', version='repair-output-v1')
    assert spec['serialization']['encoding'] == 'cp1251'
    assert 'encoding_by_role' not in spec
    revision = SimpleNamespace(settings={
        'operation': 'REPAIR', 'repair_role': 'DOGTAGS', 'output_spec': spec})
    assert revision_spec(revision) == spec
    assert manifest_spec({'version': MANIFEST_VERSION, 'output_spec': spec}) == spec

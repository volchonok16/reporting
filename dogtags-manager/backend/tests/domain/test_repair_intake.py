import pytest

from app.domain.repair_intake import configure_repair
from app.domain.readers.csv_reader import discover_csv


@pytest.mark.parametrize('columns,role', [
    (['STATUS', 'INN'], 'CLIENTS'),
    (['STATUS', 'IS_ACTIVE', 'MAV_LABEL_LATIN', 'MAV_LABEL', 'INN'], 'DOGTAGS'),
    (['STATUS', 'MSISDN', 'INN', 'MAV_LABEL_NAME', 'IS_MAV', 'IS_KSS',
      'SPREADING', 'INTERNAL_OPERATOR_NAME', 'MAV_OPERATOR_NAME'], 'NUMBERS'),
])
def test_returned_headers_detect_role_and_keep_exact_data_mapping(columns, role):
    result, questions = {'columns': columns}, []
    configure_repair(result, questions, {}, None)
    assert result['repair_role'] == role and questions == []
    assert result['mapping']['STATUS'] == 0
    if role == 'NUMBERS':
        assert result['mapping']['MAV_OPERATOR_NAME'] == columns.index('MAV_OPERATOR_NAME')


def test_status_missing_and_duplicate_headers_require_explicit_mapping():
    result, questions = {'columns': ['INN', 'ИНН', 'STATUS']}, []
    configure_repair(result, questions, {'repair_role': 'CLIENTS'}, None)
    assert questions[0]['code'] == 'mapping_required'
    questions.clear()
    configure_repair(result, questions, {'repair_role': 'CLIENTS', 'mapping': {'INN': 1, 'STATUS': 2}}, None)
    assert not questions and result['mapping']['INN'] == 1
    result, questions = {'columns': ['INN']}, []
    configure_repair(result, questions, {}, None)
    assert questions[0]['required'] == ['INN', 'STATUS']


def test_returned_numbers_without_mav_column_default_to_zero():
    columns = ['STATUS', 'phonenumber', 'INN', 'label', 'IS_KSS', 'SPREADING', 'INTERNAL_OPERATOR_NAME']
    result, questions = {'columns': columns}, []
    configure_repair(result, questions, {}, {})
    assert not questions and result['repair_role'] == 'NUMBERS'
    assert result['field_defaults'] == {'IS_MAV': '0'}
    assert 'IS_MAV' not in result['mapping']


def test_returned_numbers_can_resolve_encoding_from_its_only_label(tmp_path):
    path = tmp_path / 'numbers.csv'
    path.write_text('INN;MAV_LABEL_NAME;MSISDN;IS_MAV;IS_KSS;SPREADING;INTERNAL_OPERATOR_NAME;STATUS\n'
                    '7707083893;Тест;79000000000;1;0;0;hubRTK;\n', encoding='utf-8')
    assert len(discover_csv(path)) == 2
    choices = discover_csv(path, returned=True)
    assert len(choices) == 1 and choices[0]['reader']['encoding'] == 'utf-8'


def test_damaged_labels_do_not_silently_decide_ambiguous_encoding(tmp_path):
    path = tmp_path / 'numbers.csv'
    path.write_text('INN;MAV_LABEL_NAME;MSISDN;STATUS\n7707083893;Ошибка№;900;\n', encoding='utf-8')
    assert len(discover_csv(path, returned=True)) == 2

from uuid import uuid4

from app.domain.projections import projection_rows, verify_projections
from app.domain.readers.base import MappedSource, publish_raw_index
from app.domain.readers.csv_reader import CSVTable
from app.domain.serialization import write_csv
from app.domain.whitemav import build_whitemav_dataset
from app.storage.local import LocalStorage


def test_whitemav_numbers_have_exact_constants_and_ignore_comments(tmp_path):
    source = uuid4()
    path = tmp_path / 'input.csv'
    raw = 'comment;phonenumber\nIgnore;79937967877\nDifferent;79937967877\nAlso ignored;79937967878\n'.encode()
    path.write_bytes(raw)
    storage = LocalStorage(tmp_path / 'objects')
    key = publish_raw_index(CSVTable(path, source, encoding='utf-8', delimiter=';'), storage, tmp_path / 'raw')
    parsed = MappedSource(storage, key, source, {'MSISDN': 1}, required=('MSISDN',))
    dataset = build_whitemav_dataset(path, 'utf-8', source, tmp_path / 'dataset', {}, parsed_source=parsed)
    assert verify_projections(dataset)['counts'] == {'NUMBERS': 2}
    assert list(projection_rows(dataset, 'NUMBERS')) == [
        ['7743895280', '', '79937967877', '1', '0', '0', 'whiteMAV'],
        ['7743895280', '', '79937967878', '1', '0', '0', 'whiteMAV']]
    artifact = write_csv(dataset, 'NUMBERS', tmp_path / 'output.csv')
    assert artifact.path.read_bytes() == (
        b'INN;MAV_LABEL_NAME;MSISDN;IS_MAV;IS_KSS;SPREADING;INTERNAL_OPERATOR_NAME\r\n'
        b'7743895280;;79937967877;1;0;0;whiteMAV\r\n'
        b'7743895280;;79937967878;1;0;0;whiteMAV\r\n')
    assert path.read_bytes() == raw

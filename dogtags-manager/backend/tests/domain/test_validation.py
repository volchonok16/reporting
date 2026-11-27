"""Synthetic expectations independently fixed from Callmark v4 §4–6."""
from uuid import uuid4

import pytest

from app.domain.ingress import parse_source, source_record_id
from app.domain.validation import validate_record

HEADER = "INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS"


def values(**changes):
    return {"INN": "1234567894", "MSISDN": "79000000000", "MAV_LABEL_NAME": "Тест",
            "MAV_LABEL_LATIN": "Test", "IS_MAV": "0", "IS_KSS": "1", **changes}


def codes(**changes):
    return {issue["code"] for issue in validate_record(values(**changes))}


@pytest.mark.parametrize('dash', ['-'])
def test_hyphen_is_valid_in_both_label_alphabets(dash):
    assert not codes(MAV_LABEL_NAME=f'Тест{dash}1', MAV_LABEL_LATIN=f'Test{dash}1')


@pytest.mark.parametrize('label', ['Тест–1', 'Тест—1', 'ООО "Тест"', 'Тест_'])
def test_symbols_outside_the_supplied_allowlist_are_invalid(label):
    assert 'label_characters' in codes(MAV_LABEL_NAME=label)


@pytest.mark.parametrize("inn", ["1234567894", "123456789047", "0000000000", "000000000000"])
def test_inn_strings_checksum_and_leading_zeros(inn):
    assert not codes(INN=inn)


def test_reported_inn_is_valid_and_hidden_characters_are_located():
    assert not codes(INN='7805406976')
    issue = next(i for i in validate_record(values(INN='7805406976  ')) if i['field'] == 'INN')
    assert '11' in issue['message'] and '12' in issue['message'] and 'пробел' in issue['message']


def test_label_diagnostic_locates_each_character_and_excess_range():
    issue = next(i for i in validate_record(values(MAV_LABEL_NAME='ТеAт_')) if i['code'] == 'label_characters')
    assert issue['message'] == 'В этикетке на кириллице найдены недопустимые символы: позиция 5: «_»'
    latin = next(i for i in validate_record(values(MAV_LABEL_LATIN='Teст\t')) if i['code'] == 'label_characters')
    assert latin['message'] == 'В этикетке на латинице найдены недопустимые символы: позиция 3: «с»; позиция 4: «т»; позиция 5: табуляция'
    issue = next(i for i in validate_record(values(MAV_LABEL_LATIN='A' * 35)) if i['code'] == 'label_length')
    assert '33–35' in issue['message']


@pytest.mark.parametrize("inn,code", [("1234567895", "inn_checksum"), ("123456789037", "inn_checksum"),
                                     ("7,84201E+11", "inn_scientific"), ("123.45", "inn_fractional"),
                                     ("1234", "inn_length"), ("１２３４５６７８９４", "inn_characters")])
def test_damaged_inn_diagnoses_without_guessing(inn, code):
    row = values(INN=inn)
    assert code in {issue["code"] for issue in validate_record(row)}
    assert row["INN"] == inn


@pytest.mark.parametrize("mav,kss", [("0", "0"), ("0", "1"), ("1", "0"), ("1", "1")])
def test_at_least_one_assignment_flag_is_enabled(mav, kss):
    assert codes(IS_MAV=mav, IS_KSS=kss) == ({'flags_both_zero'} if mav == kss == '0' else set())


def test_empty_flags_and_msisdn_are_not_inferred():
    assert "flag_value" in codes(IS_MAV="")
    assert "msisdn_required" in codes(MSISDN="")
    assert "msisdn_format" in codes(MSISDN="8-unknown-number-policy")


def test_ten_digit_msisdn_requires_operator_decision_without_mutation():
    row = values(MSISDN='9937967877')
    issue = next(i for i in validate_record(row) if i['code'] == 'msisdn_country_prefix')
    assert issue['field'] == 'MSISDN'
    assert '79937967877' in issue['message']
    assert row['MSISDN'] == '9937967877'
    assert not codes(MSISDN='79937967877')
    assert 'msisdn_format' in codes(MSISDN='001900')


def test_labels_keep_full_length_and_unresolved_glyphs():
    assert not codes(MAV_LABEL_NAME="Я" * 32, MAV_LABEL_LATIN="A" * 32)
    assert "label_length" in codes(MAV_LABEL_NAME="Я" * 33)
    assert not codes(MAV_LABEL_NAME="Ёлка и ёж")
    assert 'label_characters' in codes(MAV_LABEL_LATIN='Ёлка')
    assert not codes(MAV_LABEL_NAME="Тест A")
    assert "label_characters" in codes(MAV_LABEL_LATIN="Тест")
    assert "label_characters" in codes(MAV_LABEL_NAME="Тест\u00a0")


def test_csv_keeps_quoted_cells_empty_values_and_physical_lines(tmp_path):
    source = uuid4()
    path = tmp_path / "source.csv"
    path.write_bytes((HEADER + '\r\n0000000000;79000000000;"Тест;\r\nещё";Test;;1\r\n'
                     + "1234567894;900;Тест;Test;0;0\r\n").encode())
    parsed = parse_source(path, "utf-8", source)
    rows = list(parsed.records())
    assert rows[0].raw_cells == ["0000000000", "79000000000", "Тест;\r\nещё", "Test", "", "1"]
    assert (rows[0].ordinal, rows[0].line_start, rows[0].line_end) == (1, 2, 3)
    assert rows[0].record_id == str(source_record_id(source, 1))
    assert rows[1].ordinal == 2 and rows[1].line_start == 4
    assert parsed.summary["unknown_remainder"] is False


@pytest.mark.parametrize("suffix,code,count,unknown", [
    ("1234567894;900;Тест;Test;0\n", "row_shape", 1, False),
    ('1234567894;900;"unterminated', "source_csv_syntax_error", 0, True),
    ("", "source_empty", 0, False),
])
def test_parse_failures_are_separate_and_accounted(tmp_path, suffix, code, count, unknown):
    path = tmp_path / "source.csv"
    path.write_text(HEADER + "\n" + suffix)
    parsed = parse_source(path, "utf-8", uuid4())
    rows = list(parsed.records())
    assert len(rows) == count
    errors = parsed.summary["file_errors"] + [i for row in rows for i in row.issues]
    assert code in {i["code"] for i in errors}
    assert parsed.summary["unknown_remainder"] is unknown
    if rows:
        assert len(rows[0].raw_cells) == 5


def test_bad_decode_keeps_known_prefix_and_extra_or_duplicate_columns(tmp_path):
    path = tmp_path / "source.csv"
    path.write_bytes((HEADER + "\n1234567894;900;Тест;Test;0;1\n").encode() + b"\xff\n")
    parsed = parse_source(path, "utf-8", uuid4())
    assert len(list(parsed.records())) == 1
    assert parsed.summary["unknown_remainder"] is True
    assert parsed.summary["file_errors"][0]["code"] == "source_encoding_error"
    for header in (HEADER + ";EXTRA", HEADER.replace("MSISDN", "INN")):
        path.write_text(header + "\n1234567894;900;Тест;Test;0;1;extra\n")
        parsed = parse_source(path, "utf-8", uuid4())
        row = list(parsed.records())[0]
        assert row.raw_cells[-1] == "extra"
        assert parsed.summary["schema_supported"] is False
        assert parsed.summary["file_errors"][0]["code"] == "unsupported_schema"


def test_long_field_and_crlf_cross_chunk_are_retained(tmp_path):
    path = tmp_path / "source.csv"
    prefix = HEADER + "\n1234567894;900;"
    field = "Я" * 70000
    first = prefix + field + ";Test;0;1"
    # Put CR exactly at the end of the second 64 KiB reader chunk.
    padding = " " * ((131071 - len(first.encode())) % 65536)
    path.write_bytes((first + padding + "\r\n1234567894;901;Тест;Test;1;0\r\n").encode())
    parsed = parse_source(path, "utf-8", uuid4())
    rows = list(parsed.records())
    assert len(rows) == 2
    assert rows[0].values["MAV_LABEL_NAME"] == field
    assert rows[0].raw_cells[5] == "1" + padding
    assert (rows[1].line_start, rows[1].line_end) == (3, 3)


def test_source_identity_independent_fixed_vectors():
    source = "22222222-2222-4222-8222-222222222222"
    assert str(source_record_id(source, 1)) == "1e6f0bd1-dd8d-5c49-b39f-0dcdad92d98d"
    assert str(source_record_id(source, 2)) == "d2d8b91a-271b-5457-bdfa-a765b4a551b3"

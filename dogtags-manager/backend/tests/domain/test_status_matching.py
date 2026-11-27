"""No row order, fuzzy values or production STATUS guesses enter correlation."""
from uuid import uuid4

from app.domain.operations import canonical_digest
from app.domain.registry import business_identity
from app.domain.returns import match_row, reconcile_scratch, scratch_database


def test_duplicate_export_keys_require_one_exact_values_match(tmp_path):
    db = scratch_database(tmp_path / 'matches.sqlite')
    values = {'INN': '7707083893', 'MAV_LABEL': 'Тест', 'MAV_LABEL_LATIN': 'Test', 'IS_ACTIVE': '1'}
    _, key = business_identity('DOGTAGS', values)
    first, second = str(uuid4()), str(uuid4())
    db.execute('INSERT INTO exports VALUES (?,?,?,?)', (first, 1, key, canonical_digest(values)))
    changed = {**values, 'MAV_LABEL_LATIN': 'Other'}
    db.execute('INSERT INTO exports VALUES (?,?,?,?)', (second, 2, key, canonical_digest(changed)))
    rules = {'synthetic yes': 'success'}
    assert match_row(db, 'DOGTAGS', values, 'synthetic yes', rules, [])[:2] == (first, 'APPLIED')
    assert match_row(db, 'DOGTAGS', values, 'Synthetic yes', rules, [])[1] == 'UNKNOWN'
    assert match_row(db, 'DOGTAGS', changed, 'synthetic yes', {}, [])[1] == 'UNKNOWN'
    assert match_row(db, 'DOGTAGS', values, 'synthetic yes', rules, [{'code': 'excel_formula_cache_missing'}])[1] == 'INVALID'
    db.execute('INSERT INTO exports VALUES (?,?,?,?)', (str(uuid4()), 3, key, canonical_digest(values)))
    assert match_row(db, 'DOGTAGS', values, 'synthetic yes', rules, [])[1] == 'AMBIGUOUS'
    db.close()


def test_conflicting_repeats_and_missing_exports_remain_distinct(tmp_path):
    db = scratch_database(tmp_path / 'matches.sqlite')
    db.executemany('INSERT INTO exports VALUES (?,?,?,?)', [('a', 1, 'key', 'sig'), ('b', 2, 'key2', 'sig2')])
    db.executemany('INSERT INTO rows VALUES (?,?,?,?,?,?,?)', [
        (1, 'raw1', '[]', 'yes', 'a', 'APPLIED', 'known_status'),
        (2, 'raw2', '[]', 'no', 'a', 'REJECTED', 'known_status'),
        (3, 'raw3', '[]', 'yes', None, 'UNMATCHED', 'no_exact_export')])
    assert reconcile_scratch(db) == {'CONFLICT': 2, 'MISSING': 1, 'UNMATCHED': 1}
    db.close()

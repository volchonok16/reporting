"""Selections are pinned to immutable source identities, never output row positions."""


def excluded_records(settings, source_asset_id, parsed):
    result = {}
    for key, value in settings.get('row_selections', {}).items():
        if (key != value['record_id'] or value['source_asset_id'] != str(source_asset_id)
                or value.get('mapping_digest') != getattr(parsed, 'mapping_digest', None)):
            raise ValueError('Row selection does not belong to this source mapping.')
        if value['excluded']:
            result[value['ordinal']] = key
    return result


def verify_selection(record, excluded, seen):
    if record.ordinal in excluded:
        if record.record_id != excluded[record.ordinal]:
            raise ValueError('Excluded row identity changed.')
        seen.add(record.ordinal)


def install_exclusions(db, excluded):
    db.execute('CREATE TABLE manual_exclusions (ordinal BIGINT PRIMARY KEY)')
    if excluded:
        db.executemany('INSERT INTO manual_exclusions VALUES (?)', [(ordinal,) for ordinal in excluded])

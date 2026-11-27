"""Persist cleanup diagnostics without affecting row eligibility or output bytes."""


def add_msisdn_cleanup_warnings(db, directory, indexed):
    db.read_parquet(str(directory / 'raw.parquet')).create_view('msisdn_source')
    db.execute('CREATE TEMP TABLE msisdn_edits (ordinal BIGINT, submitted VARCHAR)')
    edits = [(ordinal, change.get('submitted_after', change['after']))
             for ordinal, changes in indexed.items()
             for change in [next((c for c in reversed(changes) if c['field'] == 'MSISDN'), None)] if change]
    if edits:
        db.executemany('INSERT INTO msisdn_edits VALUES (?,?)', edits)
    db.execute("""INSERT INTO issues SELECT r.record_id,r.ordinal,'MSISDN','msisdn_cleaned',
        'Автоматически удалены символы: ' ||
        to_json(regexp_replace(coalesce(edit.submitted,s.MSISDN), '[0-9]', '', 'g')) ||
        '. Обозначения: пробел — внутри кавычек, \\t — табуляция, \\n — перенос строки. '
        || 'Строка исходного файла: ' || s.line_start || '. MSISDN после обработки: ' || r.MSISDN, 'warning'
        FROM records r JOIN msisdn_source s USING(record_id)
        LEFT JOIN msisdn_edits edit ON edit.ordinal=r.ordinal
        WHERE regexp_matches(coalesce(edit.submitted,s.MSISDN), '[^0-9]')""")

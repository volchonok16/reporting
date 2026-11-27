"""Case-only label variants are operator notices, never exclusion rules."""


def add_label_case_warnings(db, fields=('MAV_LABEL_NAME', 'MAV_LABEL_LATIN')):
    for field in fields:
        if field not in ('MAV_LABEL_NAME', 'MAV_LABEL_LATIN'):
            raise ValueError('Unsupported label warning field.')
        script = 'латинице' if field == 'MAV_LABEL_LATIN' else 'кириллице'
        db.execute(f'''INSERT INTO issues
            WITH variants AS (
                SELECT INN,lower({field}) AS folded,{field} AS value,min(ordinal) AS first_row
                FROM records WHERE disposition IN ('included','exact_duplicate')
                GROUP BY INN,lower({field}),{field}),
            ranked AS (SELECT *,row_number() OVER (PARTITION BY INN,folded ORDER BY first_row) AS variant_number,
                count(*) OVER (PARTITION BY INN,folded) AS variant_count FROM variants),
            groups AS (SELECT INN,folded,
                string_agg('«' || value || '»', '; ' ORDER BY first_row) AS examples
                FROM ranked WHERE variant_count>1 AND variant_number<=3 GROUP BY INN,folded)
            SELECT r.record_id,r.ordinal,?,'label_case_variant',
                ? || g.examples || '. Это некритичное различие; исправление остаётся на ваше усмотрение.',
                'warning' FROM records r JOIN groups g ON r.INN=g.INN AND lower(r.{field})=g.folded
                WHERE r.disposition IN ('included','exact_duplicate')''',
            [field, f'У одного ИНН этикетки на {script} различаются только регистром: '])


def add_label_latin_warnings(db):
    """Notice allowed Latin letters after disposition, without excluding records."""
    db.execute("""INSERT INTO issues
        SELECT record_id,ordinal,'MAV_LABEL_NAME','label_contains_latin',
            'В общей этикетке есть латинские символы. Это разрешено; проверьте написание при необходимости.',
            'warning' FROM records WHERE regexp_matches(MAV_LABEL_NAME, '[A-Za-z]')""")

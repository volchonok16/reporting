"""Deterministic whole-file review order, computed on disk by the worker."""
from app.domain.canonical import connection
from tempfile import TemporaryDirectory

QUERY = """SELECT r.* EXCLUDE(page_index),
    row_number() OVER (ORDER BY coalesce(i.has_error,false) DESC,(i.issues IS NOT NULL) DESC,r.ordinal) AS page_index,
    coalesce(i.issues,[]) AS issues FROM review_records r LEFT JOIN
    (SELECT record_id,bool_or(scope<>'warning') AS has_error,
     list(DISTINCT struct_pack(field:=field,scope:=scope,code:=code,message:=message)) AS issues
     FROM review_issues GROUP BY record_id) i USING(record_id)"""


def sorted_records(records_path, issues_path, *, memory_limit='1GiB', threads=1):
    with TemporaryDirectory(prefix='dogtags-review-sort-') as spill, connection(
            memory_limit=memory_limit, threads=threads, temp_directory=spill) as db:
        db.read_parquet(str(records_path)).create_view('review_records')
        db.read_parquet(str(issues_path)).create_view('review_issues')
        reader = db.execute(QUERY + ' ORDER BY page_index').to_arrow_reader(1000)
        for batch in reader:
            yield from batch.to_pylist()


def sorted_page(records_path, issues_path, *, after, limit, record_fields, memory_limit, threads):
    # Compatibility for immutable datasets published before the sorted index.
    # DuckDB bounds memory; only one transport page is returned to the API.
    with TemporaryDirectory(prefix='dogtags-review-sort-') as spill, connection(
            memory_limit=memory_limit, threads=threads, temp_directory=spill) as db:
        db.read_parquet(str(records_path)).create_view('review_records')
        db.read_parquet(str(issues_path)).create_view('review_issues')
        rows = db.execute(f'SELECT * FROM ({QUERY}) WHERE page_index>? ORDER BY page_index LIMIT ?',
                          [after, limit + 1]).to_arrow_table().to_pylist()
    for row in rows:
        row['effective'] = {field: row.pop(field) for field in record_fields}
        row.pop('effective_cells', None)
    return {'items': rows[:limit], 'next_cursor': rows[limit - 1]['page_index'] if len(rows) > limit else None}

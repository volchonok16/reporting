"""Source-shaped error exports and their record-owned diagnostics."""
from app.domain.canonical import connection

FIELD_LABELS = {
    'INN': 'ИНН', 'MSISDN': 'Номер', 'MAV_LABEL_NAME': 'Этикетка на русском',
    'MAV_LABEL_LATIN': 'Этикетка латиницей', 'IS_MAV': 'Флаг IS_MAV', 'IS_KSS': 'Флаг IS_KSS',
    'COMPANY_NAME': 'Название компании', 'COMPANY_CONTRACT': 'Договор компании',
    'MAV_OPERATOR_NAME': 'Оператор клиента', 'IS_ACTIVE': 'Флаг IS_ACTIVE',
    'SPREADING': 'Флаг SPREADING', 'INTERNAL_OPERATOR_NAME': 'Внутреннее имя оператора', 'STATUS': 'STATUS',
}


def error_description(messages):
    lines = []
    for message in messages.split('\n'):
        field, separator, description = message.partition(': ')
        lines.append(f"{FIELD_LABELS.get(field, field or 'Структура строки')}: {description}"
                     if separator else message)
    return '\n'.join(lines)


def export_layout(dataset, role='ERRORS'):
    layout = dataset.summary['error_source']
    if not layout.get('width_checked'):
        with connection(memory_limit=dataset.memory_limit, threads=dataset.threads) as db:
            name = 'other_operators' if role == 'ERROR_OTHER_OPERATOR' else 'errors'
            db.read_parquet(str(dataset.directory / f'{name}.parquet')).create_view('errors')
            if 'ERROR_OTHER_OPERATOR' in dataset.roles:
                db.read_parquet(str(dataset.directory / 'errors.parquet')).create_view('standard_errors')
                db.read_parquet(str(dataset.directory / 'other_operators.parquet')).create_view('other_errors')
                db.execute('CREATE OR REPLACE VIEW errors AS SELECT page_index FROM standard_errors '
                           'UNION ALL SELECT page_index FROM other_errors')
            db.read_parquet(str(dataset.directory / 'effective.parquet')).create_view('effective')
            width = db.execute('''SELECT max(len(e.effective_cells)) FROM errors x
                JOIN effective e ON e.ordinal=x.page_index''').fetchone()[0] or 0
        layout['columns'] = [*layout['columns'], *[f'Дополнительная ячейка {i + 1}'
                            for i in range(max(0, width - len(layout['columns'])))]]
        layout['width_checked'] = True
    return layout


def error_entries(dataset, role='ERRORS'):
    layout = export_layout(dataset, role)
    with connection(memory_limit=dataset.memory_limit, threads=dataset.threads,
                    temp_directory=dataset.directory / '.error-export-spill') as db:
        name = 'other_operators' if role == 'ERROR_OTHER_OPERATOR' else 'errors'
        db.read_parquet(str(dataset.directory / f'{name}.parquet')).create_view('errors')
        db.read_parquet(str(dataset.directory / 'effective.parquet')).create_view('effective')
        reader = db.execute('''SELECT e.effective_cells, x.page_index, x.ERROR_FIELDS, x.ERROR_MESSAGES
            FROM errors x JOIN effective e ON e.ordinal=x.page_index ORDER BY x.page_index''').to_arrow_reader(1000)
        for batch in reader:
            for row in batch.to_pylist():
                cells = row['effective_cells']
                cells = [*cells, *[''] * (len(layout['columns']) - len(cells))]
                yield cells, row['page_index'], row['ERROR_FIELDS'], row['ERROR_MESSAGES']


def preview_diagnostics(dataset, role='ERRORS'):
    layout = export_layout(dataset, role)
    for _, ordinal, fields, messages in error_entries(dataset, role):
        highlighted = [layout['columns'][layout['mapping'][field]] for field in fields.split('; ')
                       if field in layout['mapping']]
        if 'SOURCE_ROW' in fields.split('; '):
            highlighted.append('SOURCE_ROW')
        yield {'source_row': str(ordinal), 'error_fields': '; '.join(highlighted), 'error_messages': messages}

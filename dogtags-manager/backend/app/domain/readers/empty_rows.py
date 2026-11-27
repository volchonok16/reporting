"""Ignore empty/template rows without discarding partially filled records."""


def flag_columns(columns):
    from app.domain.readers.mapping import map_columns
    return frozenset(map_columns(columns, required=('IS_MAV', 'IS_KSS', 'IS_ACTIVE', 'SPREADING'))['mapping'].values())


def empty_row(cells, flags=()):
    return all(not value.strip() or (index in flags and value.strip() in ('0', '1'))
               for index, value in enumerate(cells))

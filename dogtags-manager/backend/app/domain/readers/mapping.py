"""Explainable header aliases. Values never establish a column's business meaning alone."""
import re

from app.domain.ingress import HUB_COLUMNS

DEFAULT_ALIASES = {
    'INN': ['ИНН', 'ИНН клиента'],
    'MSISDN': ['Номер телефона', 'Телефон', 'Номер'],
    'MAV_LABEL_NAME': ['MAV_LABEL', 'Маркировка', 'Маркировка на кириллице'],
    'MAV_LABEL_LATIN': ['Маркировка на латинице', 'Латинская маркировка'],
    'IS_MAV': ['Признак МАВ'],
    'IS_KSS': ['Признак КСС'],
}

SUPPLIED_ALIASES = {'MSISDN': ['phonenumber'], 'MAV_LABEL_NAME': ['label'], 'MAV_LABEL_LATIN': ['labelLatin']}


def effective_aliases(aliases=None):
    configured = DEFAULT_ALIASES if aliases is None else aliases
    return {field: [*configured.get(field, []), *SUPPLIED_ALIASES.get(field, [])]
            for field in set(configured) | set(SUPPLIED_ALIASES)}


def header_key(value):
    return re.sub(r'[\W_]+', '', value.casefold())


def map_columns(columns, aliases=None, required=HUB_COLUMNS):
    aliases = effective_aliases(aliases)
    candidates = {field: [i for i, column in enumerate(columns)
                          if header_key(column) in {header_key(field),
                                                   *(header_key(a) for a in aliases.get(field, []))}]
                  for field in required}
    mapping = {field: indices[0] for field, indices in candidates.items() if len(indices) == 1}
    # An alias rule assigning the same original column twice is also ambiguous.
    collisions = {i for i in mapping.values() if list(mapping.values()).count(i) > 1}
    ambiguous = [field for field, values in candidates.items()
                 if len(values) > 1 or any(i in collisions for i in values)]
    mapping = {field: i for field, i in mapping.items() if field not in ambiguous}
    missing = [field for field, values in candidates.items() if not values]
    return {'mapping': mapping, 'candidates': candidates, 'missing': missing, 'ambiguous': ambiguous,
            'complete': not (set(missing) - {'IS_MAV'}) and not ambiguous, 'extras': [i for i in range(len(columns))
                                                               if i not in mapping.values()]}

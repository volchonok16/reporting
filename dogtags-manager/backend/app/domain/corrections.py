from app.domain.ingress import HUB_COLUMNS, source_record_id
from app.domain.rules import ordinary_spaces, operator_value, label_linebreaks
import re
import hashlib
from heapq import merge


def clean_msisdn(value):
    return re.sub(r'[^0-9]', '', value)


def prefixed_msisdn(value):
    return '7' + value if re.fullmatch(r'[0-9]{10}', value) else value


class CorrectionIndex(dict):
    def __init__(self):
        super().__init__()
        self.bulk_steps = []
        self.bulk_label_fields = set()


def overlay_index(overlay, source_id, *, mapping_digest=None, allowed_fields=HUB_COLUMNS):
    """Retain ordered history; address precisely one immutable source record."""
    indexed = CorrectionIndex()
    for position, change in enumerate(overlay):
        if change.get('action') == 'prefix_ten_digit_msisdn':
            if (change.get('source_asset_id') != str(source_id)
                    or change.get('mapping_digest') != mapping_digest or 'MSISDN' not in allowed_fields):
                raise ValueError('Bulk correction does not belong to this source contract.')
            indexed.bulk_steps.append((position, change))
            continue
        if change.get('action') == 'replace_labels':
            labels = change['labels']
            if (change.get('source_asset_id') != str(source_id)
                    or change.get('mapping_digest') != mapping_digest
                    or not labels.keys() <= set(allowed_fields) & {'MAV_LABEL_NAME', 'MAV_LABEL_LATIN'}):
                raise ValueError('Bulk label correction does not belong to this source contract.')
            indexed.bulk_steps.append((position, change))
            indexed.bulk_label_fields.update(labels)
            continue
        ordinal = change["ordinal"]
        identity_valid = (change.get('mapping_digest') == mapping_digest if mapping_digest else
                          str(source_record_id(source_id, ordinal)) == change['record_id'])
        if not identity_valid or change["field"] not in allowed_fields:
            raise ValueError("Correction does not belong to this source contract.")
        indexed.setdefault(ordinal, []).append({**change, '_position': position})
    return indexed


def effective_values(record, changes, *, normalizer=None, bulk_steps=(), normalization_log=None):
    values = normalizer.apply(record.values)[0] if normalizer else dict(record.values)
    # Existing audit chains may predate boundary-space normalization. Replay
    # their original before-values, retaining all original digits and history.
    inn_changes = [change for change in changes if change['field'] == 'INN']
    if inn_changes and inn_changes[0]['before'] == record.values.get('INN'):
        values['INN'] = record.values['INN']
    cell_steps = ((change.get('_position', index), change) for index, change in enumerate(changes))
    ordered = (merge(cell_steps, bulk_steps, key=lambda item: item[0]) if changes and bulk_steps
               else cell_steps if changes else bulk_steps)
    mav_enabled = ordinary_spaces(values.get('IS_MAV', '')) == '1'
    for _, change in ordered:
        if change.get('action') == 'prefix_ten_digit_msisdn':
            if 'MSISDN' in values:
                before = values['MSISDN']
                if change.get('rule_version') == 'operator-confirmed-prefix-v2':
                    before = clean_msisdn(before)
                values['MSISDN'] = prefixed_msisdn(before)
            continue
        if change.get('action') == 'replace_labels':
            values.update(change['labels'])
            continue
        if change['record_id'] != record.record_id:
            raise ValueError('Correction does not address this original row.')
        # Accept the displayed KSS value as well as historical, unadjusted before-values.
        if change['field'] == 'IS_KSS' and mav_enabled and change['before'] == '0':
            values['IS_KSS'] = '0'
        normalize = clean_msisdn if change['field'] == 'MSISDN' else lambda v: label_linebreaks(change['field'], ordinary_spaces(v))
        if normalize(values[change['field']]) != normalize(change['before']):
            raise ValueError("Stored correction history does not match its effective before-value.")
        values[change["field"]] = change["after"]
        if change['field'] == 'IS_KSS':
            mav_enabled = ordinary_spaces(values.get('IS_MAV', '')) == '1'
        elif change['field'] == 'IS_MAV' and ordinary_spaces(change['after']) == '1':
            mav_enabled = True
    def automatic(field, after, rule):
        before = values[field]
        if normalization_log is not None and before != after:
            normalization_log.append({'field': field, 'before': before, 'after': after,
                'rule_id': rule, 'rule_version': rule, 'rule_digest': hashlib.sha256(rule.encode()).hexdigest()})
        values[field] = after

    if ordinary_spaces(values.get('IS_MAV', '')) == '1' and ordinary_spaces(values.get('IS_KSS', 'missing')) in ('', '0', '1'):
        automatic('IS_KSS', '0', 'mav-priority-v1')
    if 'MSISDN' in values:
        automatic('MSISDN', clean_msisdn(values['MSISDN']), 'msisdn-digits-v1')
    return {field: operator_value(ordinary_spaces(value)) if field == 'INTERNAL_OPERATOR_NAME'
            else label_linebreaks(field, ordinary_spaces(value)) for field, value in values.items()}

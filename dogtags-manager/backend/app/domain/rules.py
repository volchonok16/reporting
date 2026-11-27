"""Immutable, explicit configuration. No guesses about partners, spelling or STATUS."""
import hashlib
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.domain.readers.mapping import DEFAULT_ALIASES, header_key
from app.domain.ingress import HUB_COLUMNS
from app.storage.json_objects import json_bytes

PARTNERS = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=48,
                                           pattern=r'^[\p{L}\p{N}][\p{L}\p{N} ._-]*$')]
PARTNER_FLAG_FIELDS = ('IS_MAV', 'IS_KSS')
PARTNER_NAMES = ('RTK HUB', 'RTK ABC', 'RTK MVNO', 'ГПБМ')
LABEL_FIELDS = Literal['MAV_LABEL_NAME', 'MAV_LABEL_LATIN']
INN_TRIM_RULE = 'inn-boundary-whitespace-v1'
INN_TRIM_DIGEST = hashlib.sha256(INN_TRIM_RULE.encode()).hexdigest()
SPACE_RULE = 'nonbreaking-space-v1'
SPACE_DIGEST = hashlib.sha256(SPACE_RULE.encode()).hexdigest()
LINEBREAK_RULE = 'label-linebreak-space-v1'
LINEBREAK_DIGEST = hashlib.sha256(LINEBREAK_RULE.encode()).hexdigest()


def label_linebreaks(field, value):
    return re.sub(r'\r\n|[\r\n\u2028\u2029]', ' ', value) if field in ('MAV_LABEL_NAME', 'MAV_LABEL_LATIN') else value


def ordinary_spaces(value):
    return value.replace('\u00a0', ' ').replace('\u202f', ' ')


def operator_value(value):
    # Legacy placeholder means absence; keep actual operator codes unchanged.
    return '' if value.strip().casefold() == 'none' else value


def trim_inn(value):
    trimmed = value.strip(' \t\r\n\u00a0\u202f')
    return trimmed if trimmed and all('0' <= c <= '9' for c in trimmed) else value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Profile(StrictModel):
    SPREADING: Literal['0', '1']
    IS_MAV: Literal['0', '1'] | None = None
    IS_KSS: Literal['0', '1'] | None = None
    INTERNAL_OPERATOR_NAME: str = Field(max_length=120)


class Attribution(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    field: Literal['sender', 'recipient', 'cc']
    address: str = Field(pattern=r'^[^\s@]+@[^\s@]+$')
    partner: PARTNERS


class Normalization(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    field: LABEL_FIELDS
    before: str = Field(min_length=1)
    after: str = Field(min_length=1)


class StatusRule(StrictModel):
    value: str
    classification: Literal['success', 'failure']


class Example(StrictModel):
    kind: Literal['normalization', 'status', 'attribution']
    rule_id: str | None = None
    before: str | None = None
    after: str | None = None
    value: str | None = None
    classification: Literal['success', 'failure', 'unknown'] | None = None
    context: dict[str, list[str]] | None = None
    partner: PARTNERS | None = None


class RuleConfig(StrictModel):
    schema_version: Literal[1] = 1
    version: str = Field(pattern=r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$')
    profiles: dict[PARTNERS, Profile]
    aliases: dict[str, list[str]]
    attribution: list[Attribution]
    normalizations: list[Normalization]
    statuses: list[StatusRule]
    examples: list[Example]

    @model_validator(mode='after')
    def consistent(self):
        if not {'RTK HUB', 'RTK ABC', 'RTK MVNO'} <= set(self.profiles):
            raise ValueError('All supplied partner profiles are required.')
        names = {name.casefold() for name in self.profiles}
        if len(names) != len(self.profiles) or 'whitemav' in names:
            raise ValueError('Partner names must be unique and cannot use WhiteMAV.')
        if any(rule.partner not in self.profiles for rule in self.attribution):
            raise ValueError('Attribution requires an existing partner profile.')
        allowed = {*HUB_COLUMNS, 'STATUS'}
        if not set(self.aliases) <= allowed:
            raise ValueError('Unknown canonical alias field.')
        aliases = {header_key(field): field for field in allowed}
        for field, names in self.aliases.items():
            for name in [field, *names]:
                key = header_key(name)
                if not key or (key in aliases and aliases[key] != field):
                    raise ValueError('Column aliases must have unambiguous meaning.')
                aliases[key] = field
        for items, key in ((self.attribution, lambda r: r.id), (self.normalizations, lambda r: r.id),
                           (self.normalizations, lambda r: (r.field, r.before)),
                           (self.statuses, lambda r: r.value)):
            values = [key(rule) for rule in items]
            if len(values) != len(set(values)):
                raise ValueError('Rule identifiers and exact matches must be unique.')
        from app.domain.validation import validate_record
        for rule in self.normalizations:
            sample = {'INN': '7707083893', 'MSISDN': '1', 'MAV_LABEL_NAME': 'Тест',
                      'MAV_LABEL_LATIN': 'Test', 'IS_MAV': '0', 'IS_KSS': '0', rule.field: rule.after}
            if rule.before == rule.after or any(i['field'] == rule.field for i in validate_record(sample)):
                raise ValueError('A replacement must change a label to a valid value.')
        return self


def seed_config():
    return {'schema_version': 1, 'version': 'supplied-contracts-v3-gpbm', 'profiles': {
        'RTK HUB': {'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'},
        'RTK ABC': {'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'fRTK'},
        'RTK MVNO': {'SPREADING': '1', 'INTERNAL_OPERATOR_NAME': ''},
        'ГПБМ': {'SPREADING': '1', 'INTERNAL_OPERATOR_NAME': ''}},
        'aliases': {key: list(values) for key, values in DEFAULT_ALIASES.items()},
        'attribution': [], 'normalizations': [], 'statuses': [], 'examples': []}


def digest_config(config):
    return hashlib.sha256(json_bytes(config)).hexdigest()


def rules_snapshot(config):
    data = config.model_dump(mode='json') if isinstance(config, RuleConfig) else RuleConfig.model_validate(config).model_dump()
    for profile in data['profiles'].values():
        for field in PARTNER_FLAG_FIELDS:
            if profile.get(field) is None:
                profile.pop(field, None)
    return {'version': data['version'], 'digest': digest_config(data), 'config': data}


def checked_config(snapshot):
    data = snapshot['config']
    if snapshot.get('version') != data.get('version') or snapshot.get('digest') != digest_config(data):
        raise ValueError('Rule snapshot digest/version does not match its immutable content.')
    return data


def profile_for(snapshot, partner):
    config = checked_config(snapshot)
    return {'id': f"{config['version']}:{partner}", 'partner': partner, **config['profiles'][partner],
            'rule_version': snapshot['version'], 'rule_digest': snapshot['digest']}


def resolve_partner(snapshot, *, manual=None, context=None, trusted=False):
    config = checked_config(snapshot)
    if manual is not None:
        if manual not in config['profiles']:
            raise ValueError('Unknown partner.')
        return {'partner': manual, 'reason': 'manual', 'rules': []}
    # trusted is an internal call-site capability. No HTTP body/context flag is consulted.
    if not trusted or not context:
        return {'partner': None, 'reason': 'context_missing', 'rules': []}
    matches = [rule for rule in config['attribution']
               if rule['address'].casefold() in {v.casefold() for v in context.get(rule['field'], [])}]
    partners = {r['partner'] for r in matches}
    return {'partner': next(iter(partners)) if len(partners) == 1 else None,
            'reason': 'rule' if len(partners) == 1 else ('conflict' if partners else 'no_match'),
            'rules': [r['id'] for r in matches]}


class Normalizer:
    """Compile a pinned snapshot once per worker, with constant per-row lookup cost."""
    def __init__(self, snapshot, partner_flags=None):
        config = checked_config(snapshot)
        self.partner_flags = partner_flags or {}
        self.snapshot = snapshot
        self.matches = {(r['field'], r['before']): {**r, 'rule_version': snapshot['version'],
                                                   'rule_digest': snapshot['digest']}
                        for r in config['normalizations']}

    def apply(self, values):
        effective, changes = dict(values), []
        for field, before in values.items():
            after = ordinary_spaces(before)
            if after != before:
                effective[field] = after
                changes.append({'field': field, 'before': before, 'after': after,
                                'rule_id': SPACE_RULE, 'rule_version': SPACE_RULE, 'rule_digest': SPACE_DIGEST})
            before = after
            after = label_linebreaks(field, before)
            if after != before:
                effective[field] = after
                changes.append({'field': field, 'before': before, 'after': after,
                                'rule_id': LINEBREAK_RULE, 'rule_version': LINEBREAK_RULE,
                                'rule_digest': LINEBREAK_DIGEST})
        inn = effective.get('INN', '')
        trimmed = trim_inn(inn)
        if trimmed != inn:
            effective['INN'] = trimmed
            changes.append({'field': 'INN', 'before': inn, 'after': trimmed,
                            'rule_id': INN_TRIM_RULE, 'rule_version': INN_TRIM_RULE,
                            'rule_digest': INN_TRIM_DIGEST})
        for field in ('MAV_LABEL_NAME', 'MAV_LABEL_LATIN'):
            rule = self.matches.get((field, effective.get(field))) or self.matches.get((field, values.get(field)))
            if rule:
                before = effective[field]
                effective[field] = rule['after']
                changes.append({'field': field, 'before': before, 'after': rule['after'],
                                'rule_id': rule['id'], 'rule_version': rule['rule_version'],
                                'rule_digest': rule['rule_digest']})
        for field, after in self.partner_flags.items():
            before = effective[field]
            if before != after:
                effective[field] = after
                changes.append({'field': field, 'before': before, 'after': after,
                                'rule_id': 'partner-flag-v1', 'rule_version': self.snapshot['version'],
                                'rule_digest': self.snapshot['digest']})
        return effective, changes


def normalize_values(values, snapshot):
    return Normalizer(snapshot).apply(values)


def classify_status(value, snapshot):
    return next((r['classification'] for r in checked_config(snapshot)['statuses']
                 if r['value'] == value), 'unknown')


def validate_config(data):
    config = RuleConfig.model_validate(data)
    if not set(PARTNER_NAMES) <= set(config.profiles):
        raise ValueError('New rule publications require all supported partner profiles.')
    snapshot = rules_snapshot(config)
    covered = set()
    for example in config.examples:
        if example.kind == 'normalization':
            rule = next((r for r in config.normalizations if r.id == example.rule_id), None)
            if not rule or example.before != rule.before or example.after != rule.after:
                raise ValueError('Normalization example does not prove its exact rule.')
            result, _ = normalize_values({rule.field: example.before}, snapshot)
            if result[rule.field] != example.after:
                raise ValueError('Normalization example failed.')
            covered.add(('normalization', rule.id))
        elif example.kind == 'status':
            if classify_status(example.value, snapshot) != example.classification:
                raise ValueError('STATUS example failed.')
            covered.add(('status', example.value))
        else:
            result = resolve_partner(snapshot, context=example.context, trusted=True)
            if result['partner'] != example.partner:
                raise ValueError('Attribution example failed.')
            covered.update(('attribution', rule) for rule in result['rules'])
    required = ({('normalization', r.id) for r in config.normalizations}
                | {('status', r.value) for r in config.statuses}
                | {('attribution', r.id) for r in config.attribution})
    if not required <= covered:
        raise ValueError('Every configurable transformation/classification requires a passing example.')
    return config


def partner_filename_token(partner):
    built_in = {'RTK HUB': 'RTK-HUB', 'RTK ABC': 'RTK-ABC', 'RTK MVNO': 'RTK-MVNO', 'ГПБМ': 'GPBM'}
    if partner in built_in:
        return built_in[partner]
    prefix = re.sub(r'[^A-Za-z0-9]+', '-', partner).strip('-')[:48] or 'PARTNER'
    return prefix + '-' + hashlib.sha256(partner.encode()).hexdigest()[:12]

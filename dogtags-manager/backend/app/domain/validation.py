"""Contract validation and explicit MSISDN diagnostics."""
import re


LABEL_ALPHABETS = {"MAV_LABEL_NAME": "А-Яа-яЁёA-Za-z", "MAV_LABEL_LATIN": "A-Za-z"}


def character_locations(value, invalid):
    names = {' ': 'пробел', '\t': 'табуляция', '\n': 'перенос строки', '\r': 'возврат каретки',
             '\u00a0': 'неразрывный пробел', '\u200b': 'невидимый пробел', '\ufeff': 'невидимый знак BOM'}
    locations = [(position, char) for position, char in enumerate(value, 1) if invalid(char)]
    shown = [f"позиция {position}: {names.get(char, f'«{char}»')}"
             for position, char in locations[:12]]
    if len(locations) > 12:
        shown.append(f'ещё {len(locations) - 12} символов')
    return '; '.join(shown)


def label_script_valid(field, value):
    alphabet = LABEL_ALPHABETS[field]
    return re.fullmatch(f"[{alphabet}0-9. :\\-]*", value) is not None


def validate_msisdn(value):
    if value == '':
        return [{'field': 'MSISDN', 'code': 'msisdn_required', 'message': 'MSISDN обязателен.'}]
    if re.fullmatch(r'[0-9]{10}', value):
        return [{'field': 'MSISDN', 'code': 'msisdn_country_prefix',
                 'message': f'В MSISDN 10 цифр. Добавить 7 в начало: {value} → 7{value}? '
                            'Изменение применяется только по вашему решению.'}]
    if not re.fullmatch(r'7[0-9]{10}', value):
        return [{'field': 'MSISDN', 'code': 'msisdn_format',
                 'message': 'MSISDN должен содержать 11 цифр и начинаться с 7. Проверьте номер; цифры автоматически не заменяются.'}]
    return []


def validate_inn(inn):
    issues = []

    def issue(field, code, message):
        issues.append({"field": field, "code": code, "message": message})

    if re.fullmatch(r"[+-]?[0-9]+(?:[.,][0-9]+)?[eE][+-]?[0-9]+", inn.strip()):
        issue("INN", "inn_scientific", "В исходнике ИНН записан экспонентой. Строка исключается из выходных файлов; укажите полный ИНН для её восстановления.")
    elif re.fullmatch(r"[+-]?[0-9]+[.,][0-9]+", inn):
        issue("INN", "inn_fractional", "Дробная запись не является ИНН.")
    elif not re.fullmatch(r"[0-9]+", inn):
        issue("INN", "inn_characters", "В ИНН допустимы только цифры 0–9. " + character_locations(inn, lambda c: c not in '0123456789'))
    elif len(inn) not in (10, 12):
        issue("INN", "inn_length", f"В ИНН {len(inn)} цифр вместо 10 или 12; разряды не подбираются.")
    else:
        digits = [int(char) for char in inn]

        def check(weights):
            return sum(value * weight for value, weight in zip(digits, weights, strict=False)) % 11 % 10

        valid = (digits[9] == check([2, 4, 10, 3, 5, 9, 4, 6, 8])) if len(inn) == 10 else (
            digits[10] == check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
            and digits[11] == check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]))
        if not valid:
            weights = [(10, [2, 4, 10, 3, 5, 9, 4, 6, 8])] if len(inn) == 10 else [
                (11, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]), (12, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8])]
            detail = '; '.join(f'позиция {position}: {digits[position - 1]}, расчётная цифра {check(w)}'
                               for position, w in weights if digits[position - 1] != check(w))
            issue("INN", "inn_checksum", "Контрольные разряды ИНН не совпадают: " + detail + '. Проверьте исходник.')
    return issues


def validate_record(values):
    issues = validate_inn(values['INN'])

    def issue(field, code, message):
        issues.append({"field": field, "code": code, "message": message})

    issues.extend(validate_msisdn(values['MSISDN']))
    for field in ("IS_MAV", "IS_KSS"):
        if values[field] not in ("0", "1"):
            issue(field, "flag_value", "Флаг независимо принимает только строку 0 или 1.")
    if values['IS_MAV'] == values['IS_KSS'] == '0':
        issue('IS_MAV', 'flags_both_zero', 'IS_MAV и IS_KSS одновременно равны 0. Хотя бы один из флагов должен быть 1.')
    for field in LABEL_ALPHABETS:
        label = values[field]
        if label == "":
            issue(field, "label_required", "Этикетка обязательна.")
        if len(label) > 32:
            issue(field, "label_length", f"Длина {len(label)} символов; максимум 32. Лишние символы на позициях 33–{len(label)}: {label[32:]!r}.")
        if not label_script_valid(field, label):
            script = 'латинице' if field == 'MAV_LABEL_LATIN' else 'кириллице'
            issue(field, "label_characters", f"В этикетке на {script} найдены недопустимые символы: "
                  + character_locations(label, lambda c: not label_script_valid(field, c)))
    return issues

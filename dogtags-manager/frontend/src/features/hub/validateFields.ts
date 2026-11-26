/** Local cell checks only. Cross-row conflicts and source structure require the server. */
export type FieldIssue = { field: string; code: string; message: string; scope?: string }

const labelStatuses = [
  'Длина MAV_LABEL не должна превышать 32 символа или имеются некорретные символы',
  'Длина MAV_LABEL не должна превышать 32 символа или имеются некорректные символы',
]
const knownStatuses: Record<string, readonly string[]> = {
  CLIENTS: ['ИНН уже есть в списке MAV клиентов'],
  DOGTAGS: ['Указанный MAV_LABEL уже есть у данного клиента', 'ИНН отсутствует в таблице MAV клиентов', ...labelStatuses],
  NUMBERS: ['Номер телефона уже есть в таблице MAV номеров',
    'MAV_LABEL_NAME отсутствует в таблице этикеток', 'MAV_LABEL_NAME отсутствуют в таблице этикеток',
    'ИНН отсутствует в таблице MAV клиентов', ...labelStatuses],
}

// The WHATWG decoder maps byte 0x98, but Python's strict CP1251 encoder rejects it.
const cp1251Characters = new Set<string>()
const cp1251Decoder = new TextDecoder('windows-1251')
for (let byte = 0; byte < 256; byte++) {
  if (byte !== 0x98) cp1251Characters.add(cp1251Decoder.decode(new Uint8Array([byte])))
}

function fullMatch(pattern: RegExp, value: string): boolean {
  // JavaScript's $ may match before a final newline; Python's fullmatch does not.
  return value.match(pattern)?.[0].length === value.length
}

export function suggestMsisdnPrefix(value: string): string | undefined {
  return fullMatch(/^[0-9]{10}$/, value) ? `7${value}` : undefined
}

const latinLookalikes: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x',
}

export function suggestLabelCorrection(field: string, value: string): string | undefined {
  if (!['MAV_LABEL_NAME', 'MAV_LABEL', 'MAV_LABEL_LATIN'].includes(field)) return undefined
  let candidate = value.replace(/\r\n|[\r\n\u2028\u2029\t]/g, ' ').replace(/[\u2010\u2011\u2013\u2014\u2212]/g, '-')
  if (field === 'MAV_LABEL_LATIN') candidate = [...candidate].map(char => latinLookalikes[char] ?? char).join('')
  // Never discard letters or digits: unfamiliar alphabets still require a manual decision.
  candidate = candidate.replace(/[^\p{L}\p{N}. :\-]/gu, '')
  return candidate !== value && !validateFields({ [field]: candidate }, [field]).some(issue => issue.scope !== 'warning')
    ? candidate : undefined
}

function locations(value: string, invalid: (char: string) => boolean): string {
  const names: Record<string, string> = { ' ': 'пробел', '\t': 'табуляция', '\n': 'перенос строки', '\r': 'возврат каретки', '\u00a0': 'неразрывный пробел', '\u200b': 'невидимый пробел', '\ufeff': 'невидимый знак BOM' }
  const found = [...value].flatMap((char, index) => invalid(char) ? [{ char, position: index + 1 }] : [])
  return found.slice(0, 12).map(({ char, position }) => `позиция ${position}: ${names[char] ?? `«${char}»`}`).join('; ')
    + (found.length > 12 ? `; ещё ${found.length - 12} символов` : '')
}

export function validateFields(
  values: Record<string, string>, fields: readonly string[],
  repairRole?: string,
): FieldIssue[] {
  const issues: FieldIssue[] = []
  const issue = (field: string, code: string, message: string) => issues.push({ field, code, message, scope: 'cell' })
  if (fields.some(field => field === 'IS_MAV' || field === 'IS_KSS') && values.IS_MAV === '0' && values.IS_KSS === '0') {
    issue('IS_MAV', 'flags_both_zero', 'IS_MAV и IS_KSS одновременно равны 0. Хотя бы один из флагов должен быть 1.')
  }
  if (repairRole === 'NUMBERS' && fields.includes('MAV_OPERATOR_NAME') && values.STATUS === 'Номер телефона уже есть в таблице MAV номеров'
      && values.MAV_OPERATOR_NAME !== 'mTELE2') {
    issue('MAV_OPERATOR_NAME', 'other_operator', `Оператор «${values.MAV_OPERATOR_NAME || 'не указан'}» отличается от mTELE2. Строка передана в ERROR OTHER OPERATOR и исключена из DELETE.`)
  }
  for (const field of new Set(fields)) {
    // Server detail values are already source-normalized. Saved overlays use
    // the exact edited text and never run source replacement rules again.
    const value = (values[field] ?? '').replaceAll('\u00a0', ' ').replaceAll('\u202f', ' ')
    const labelField = field === 'MAV_LABEL' ? 'MAV_LABEL_NAME' : field
    const isLabel = labelField === 'MAV_LABEL_NAME' || labelField === 'MAV_LABEL_LATIN'
    if (field === 'INN') {
      if (fullMatch(/^[+-]?[0-9]+(?:[.,][0-9]+)?[eE][+-]?[0-9]+$/, value.trim())) {
        issue(field, 'inn_scientific', 'В исходнике ИНН записан экспонентой. Строка исключается из выходных файлов; укажите полный ИНН для её восстановления.')
      } else if (fullMatch(/^[+-]?[0-9]+[.,][0-9]+$/, value)) {
        issue(field, 'inn_fractional', 'Дробная запись не является ИНН.')
      } else if (!fullMatch(/^[0-9]+$/, value)) {
        issue(field, 'inn_characters', 'В ИНН допустимы только цифры 0–9. ' + locations(value, char => !/^[0-9]$/.test(char)))
      } else if (value.length !== 10 && value.length !== 12) {
        issue(field, 'inn_length', `В ИНН ${value.length} цифр вместо 10 или 12; разряды не подбираются.`)
      } else {
        const digits = [...value].map(Number)
        const check = (weights: number[]) => weights.reduce((total, weight, index) => total + weight * digits[index], 0) % 11 % 10
        const valid = value.length === 10
          ? digits[9] === check([2, 4, 10, 3, 5, 9, 4, 6, 8])
          : digits[10] === check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
            && digits[11] === check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8])
        if (!valid) {
          const weights = value.length === 10 ? [[2, 4, 10, 3, 5, 9, 4, 6, 8]] : [[7, 2, 4, 10, 3, 5, 9, 4, 6, 8], [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]]
          const detail = weights.flatMap((w, index) => { const position = value.length === 10 ? 10 : 11 + index; return digits[position - 1] === check(w) ? [] : [`позиция ${position}: ${digits[position - 1]}, расчётная цифра ${check(w)}`] })
          issue(field, 'inn_checksum', `Контрольные разряды ИНН не совпадают: ${detail.join('; ')}. Проверьте исходник.`)
        }
      }
    }
    if (field === 'MSISDN' && value === '') {
      issue(field, 'msisdn_required', 'MSISDN обязателен.')
    } else if (field === 'MSISDN' && suggestMsisdnPrefix(value)) {
      issue(field, 'msisdn_country_prefix', `В MSISDN 10 цифр. Добавить 7 в начало: ${value} → 7${value}? Изменение применяется только по вашему решению.`)
    }
    if (field === 'MSISDN' && value !== '' && !suggestMsisdnPrefix(value) && !fullMatch(/^7[0-9]{10}$/, value)) {
      issue(field, 'msisdn_format', 'MSISDN должен содержать 11 цифр и начинаться с 7. Посторонние символы удаляются при обработке.')
    }
    if (['IS_MAV', 'IS_KSS', 'SPREADING'].includes(field) && value !== '0' && value !== '1') {
      issue(field, 'flag_value', field === 'SPREADING'
        ? 'SPREADING принимает только строку 0 или 1.' : 'Флаг независимо принимает только строку 0 или 1.')
    }
    if (field === 'IS_ACTIVE' && value !== '1') issue(field, 'active_value', 'IS_ACTIVE должен быть строкой 1.')
    if (isLabel) {
      const characters = [...value]
      if (value === '') issue(field, 'label_required', 'Этикетка обязательна.')
      if (characters.length > 32) issue(field, 'label_length', `Длина ${characters.length} символов; максимум 32. Лишние символы на позициях 33–${characters.length}: «${characters.slice(32).join('')}».`)
      if (!fullMatch(labelField === 'MAV_LABEL_LATIN' ? /^[A-Za-z0-9. :\-]*$/ : /^[А-Яа-яЁёA-Za-z0-9. :\-]*$/, value)) {
        const script = labelField === 'MAV_LABEL_LATIN' ? 'латинице' : 'кириллице'
        issue(field, 'label_characters', `В этикетке на ${script} найдены недопустимые символы: ` + locations(value, char => !(labelField === 'MAV_LABEL_LATIN' ? /^[A-Za-z0-9. :\-]$/ : /^[А-Яа-яЁёA-Za-z0-9. :\-]$/).test(char)))
      }
    }
    if (labelField === 'MAV_LABEL_NAME' && /[A-Za-z]/.test(value)) {
      issues.push({ field, code: 'label_contains_latin', scope: 'warning', message: 'В общей этикетке есть латинские символы. Это разрешено; проверьте написание при необходимости.' })
    }
    if (field === 'STATUS' && repairRole && value !== '' && !(knownStatuses[repairRole] ?? []).includes(value)) {
      issue(field, 'status_unresolved', 'STATUS не соответствует подтверждённому действию для этого файла; требуется ручное решение.')
    }
    if (field !== 'STATUS' && !(repairRole === 'NUMBERS' && field === 'MAV_OPERATOR_NAME') && [...value].some(char => !cp1251Characters.has(char))) {
      issue(field, 'output_encoding_error', 'Не представимо в Windows-1251: ' + locations(value, char => !cp1251Characters.has(char)))
    }
  }
  return issues
}

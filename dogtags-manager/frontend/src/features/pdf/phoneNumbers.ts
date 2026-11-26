const separators = '[ \\t\\u00a0\\u202f.\\-–—‑]*';
const area = '(?:\\([0-9]{3}\\)|[0-9]{3})';
const local = `${area}${separators}[0-9]{3}${separators}[0-9]{2}${separators}[0-9]{2}`;
const phone = new RegExp(`(?<![\\p{L}\\p{N}])(?:\\+?[78]${separators}${local}|${local})(?![\\p{L}\\p{N}])`, 'gu');

export function extractPhoneNumbers(text: string): string[] {
  return Array.from(text.matchAll(phone), match => match[0].replace(/[^0-9]/g, ''));
}

export function uniquePhoneNumbers(numbers: readonly string[]): string[] {
  return [...new Set(numbers)];
}

export function phoneListText(numbers: readonly string[], format: 'txt' | 'csv'): string {
  return [...(format === 'csv' ? ['MSISDN'] : []), ...numbers].join('\r\n') + '\r\n';
}

export function sourceFilename(disposition: string | null, fallback: string): string {
  const encoded = disposition?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim()); } catch { /* Fall through to the plain filename. */ }
  }
  return disposition?.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    ?? disposition?.match(/filename\s*=\s*([^;\s]+)/i)?.[1]
    ?? fallback;
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

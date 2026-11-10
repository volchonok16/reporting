// Desktop PowerPoint puts an editable slide on the clipboard as JSON
// (`ppt/slides`): a base64 OOXML package, sometimes under clipboard/ instead of ppt/.

/** The JSON package PowerPoint stores under `ppt/slides`, if this clipboard has it. */
export function powerpointClipboardRaw(types: readonly string[], getData: (type: string) => string): string {
  for (const type of types) {
    if (type === 'ppt/slides' || (/powerpoint/i.test(type) && /slide/i.test(type))) {
      const value = getData(type);
      if (value.includes('"data"')) return value;
    }
  }
  return '';
}

export async function powerpointPackageBytes(raw: string): Promise<Uint8Array | null> {
  const text = raw.trim();
  if (!text.startsWith('{')) return null;
  let payload: { data?: unknown; isDataCompressed?: unknown };
  try {
    payload = JSON.parse(text) as { data?: unknown; isDataCompressed?: unknown };
  } catch {
    return null;
  }
  if (typeof payload.data !== 'string' || !payload.data) return null;
  let bytes = decodeBase64(payload.data);
  if (payload.isDataCompressed === true) bytes = await inflate(bytes);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  return bytes;
}

function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') return bytes;
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // try the other wrapper
    }
  }
  return bytes;
}

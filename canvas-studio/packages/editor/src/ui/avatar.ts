// Фото сотрудника reporting. Буква, если фото нет или адрес не открылся.

import { h } from './dom.ts';

export function initial(text: string): string {
  return (text.trim().charAt(0) || '·').toUpperCase();
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Картинка с reporting. localhost из сборки на проде заменяется адресом вкладки, откуда открыта Симметрика. */
export function avatarSrc(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || typeof window === 'undefined') return undefined;
  try {
    const base = document.referrer || window.location.href;
    const url = new URL(value, base);
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref && isLocalHost(url.hostname) && !isLocalHost(ref.hostname)) {
      url.protocol = ref.protocol;
      url.hostname = ref.hostname;
      url.port = ref.port;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export function portrait(className: string, name: string, avatar?: string): HTMLElement {
  const node = h('span', { class: className });
  const letter = () => {
    node.replaceChildren(document.createTextNode(initial(name)));
  };
  const src = avatarSrc(avatar);
  if (!src) {
    letter();
    return node;
  }
  const img = h('img', { src, alt: '' }) as HTMLImageElement;
  img.addEventListener('error', () => letter());
  node.append(img);
  return node;
}

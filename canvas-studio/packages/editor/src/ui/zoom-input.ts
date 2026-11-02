// The zoom percentage you can type into, as in Figma: a click turns the label
// into a field with the number selected; Enter (or leaving the field) applies
// it, Esc keeps the zoom as it was. "150", "150%", "37,5" are all understood.

import { h } from './dom.ts';

/** Makes `label` editable: `current` — the zoom now (1 = 100 %), `apply` — sets one. */
export function editableZoom(label: HTMLButtonElement, current: () => number, apply: (zoom: number) => void): void {
  label.addEventListener('click', () => {
    if (label.hidden) return;
    const input = h('input', {
      class: 'zoom-input',
      type: 'text',
      inputmode: 'decimal',
      spellcheck: false,
      'aria-label': label.title || 'Zoom',
      value: String(Math.round(current() * 100)),
    });
    input.style.width = `${Math.max(48, label.offsetWidth)}px`;
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const v = Number.parseFloat(input.value.replace(',', '.').replace(/[%\s]/g, ''));
      input.remove();
      label.hidden = false;
      if (keep && Number.isFinite(v) && v > 0) apply(v / 100);
    };
    input.addEventListener('keydown', (e) => {
      // The canvas' shortcuts must not take the digits and the Enter.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
        label.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
        label.focus();
      }
    });
    input.addEventListener('blur', () => finish(true));
    label.hidden = true;
    label.after(input);
    input.focus();
    input.select();
  });
}

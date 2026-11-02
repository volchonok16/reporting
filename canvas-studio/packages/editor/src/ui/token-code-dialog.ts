// «Переменные в код» (FR-VAR-041): a language, a name template and a case,
// a live preview of the file; copy it or download it. The choices are
// remembered on this computer.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { defaultTokenOptions, exportableCollections, TOKEN_FORMATS, tokenName, tokensToCode, type NameCase, type TokenCodeOptions, type TokenFormat } from '../token-code.ts';
import { download, h, icon } from './dom.ts';

const STORE = 'cs-token-code';

const CASES: { id: NameCase; label: string }[] = [
  { id: 'kebab', label: 'color-bg-primary' },
  { id: 'snake', label: 'color_bg_primary' },
  { id: 'camel', label: 'colorBgPrimary' },
  { id: 'pascal', label: 'ColorBgPrimary' },
  { id: 'constant', label: 'COLOR_BG_PRIMARY' },
];

function remembered(): Partial<TokenCodeOptions> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<TokenCodeOptions>;
  } catch {
    return {};
  }
}

function remember(o: TokenCodeOptions): void {
  try {
    localStorage.setItem(STORE, JSON.stringify({ format: o.format, template: o.template, nameCase: o.nameCase, latin: o.latin, useCodeNames: o.useCodeNames }));
  } catch {
    // Private window: the choice is simply not kept.
  }
}

export function openTokenCode(editor: Editor, toast: (message: string) => void): void {
  const doc = editor.doc;
  const saved = remembered();
  let o: TokenCodeOptions = { ...defaultTokenOptions(saved.format ?? 'css'), ...saved, collections: null };
  const collections = exportableCollections(doc);
  const chosen = new Set(collections);
  const close = () => overlay.remove();

  const format = h('select', { class: 'field-select', 'aria-label': tr('Язык') }, ...TOKEN_FORMATS.map((f) => h('option', { value: f.id }, f.label)));
  const template = h('input', { class: 'field-input', type: 'text', spellcheck: false, 'aria-label': tr('Шаблон имени'), placeholder: '{path}' });
  const nameCase = h('select', { class: 'field-select', 'aria-label': tr('Написание') }, ...CASES.map((c) => h('option', { value: c.id }, c.label)));
  const latin = h('input', { type: 'checkbox' });
  const codeNames = h('input', { type: 'checkbox' });
  const example = h('p', { class: 'hint small tc-example' });
  const preview = h('textarea', { class: 'tc-preview', readonly: true, spellcheck: false, 'aria-label': tr('Код') });
  const copy = h('button', { class: 'text-button', type: 'button' }, icon('copy', 14), h('span', {}, tr('Копировать')));
  const save = h('button', { class: 'text-button primary', type: 'button' }, h('span', {}, tr('Скачать')));
  const picks = h('div', { class: 'tc-collections' });

  const sync = () => {
    format.value = o.format;
    template.value = o.template;
    nameCase.value = o.nameCase;
    latin.checked = o.latin;
    codeNames.checked = o.useCodeNames;
    const sample = doc.collections().flatMap((c) => doc.children(c))[0];
    example.textContent = sample
      ? tr('Например: «{0}» → {1}', doc.get(sample, 'name'), tokenName(o, doc.get(doc.parent(sample)!, 'name'), doc.get(sample, 'name')))
      : '';
    const r = tokensToCode(doc, { ...o, collections: collections.length > 1 ? [...chosen] : null });
    preview.value = r.text || tr('Нет переменных для выгрузки: создайте их в таблице переменных.');
    copy.disabled = save.disabled = !r.text;
    save.querySelector('span')!.textContent = tr('Скачать {0}', r.file);
  };
  format.addEventListener('change', () => {
    // A new language brings its usual case and Latin letters; the template stays.
    const d = defaultTokenOptions(format.value as TokenFormat);
    o = { ...o, format: d.format, nameCase: d.nameCase, latin: d.latin };
    remember(o);
    sync();
  });
  template.addEventListener('input', () => {
    o = { ...o, template: template.value };
    remember(o);
    sync();
  });
  nameCase.addEventListener('change', () => {
    o = { ...o, nameCase: nameCase.value as NameCase };
    remember(o);
    sync();
  });
  latin.addEventListener('change', () => {
    o = { ...o, latin: latin.checked };
    remember(o);
    sync();
  });
  codeNames.addEventListener('change', () => {
    o = { ...o, useCodeNames: codeNames.checked };
    remember(o);
    sync();
  });
  if (collections.length > 1) {
    for (const c of collections) {
      const box = h('input', { type: 'checkbox', checked: true });
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(c);
        else chosen.delete(c);
        sync();
      });
      picks.append(h('label', { class: 'checkbox' }, box, h('span', {}, doc.get(c, 'name'))));
    }
  }
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(preview.value).then(
      () => toast(tr('Код скопирован')),
      () => {
        preview.select();
        toast(tr('Не удалось скопировать — выделил текст, нажмите ⌘C'));
      },
    );
  });
  save.addEventListener('click', () => {
    const r = tokensToCode(doc, { ...o, collections: collections.length > 1 ? [...chosen] : null });
    download(new Blob([r.text], { type: 'text/plain;charset=utf-8' }), r.file);
  });
  for (const el of [template]) el.addEventListener('keydown', (e) => e.stopPropagation());

  const closeButton = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: close }, icon('close'));
  const dialog = h(
    'div',
    { class: 'dialog tc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Переменные в код') },
    h('header', { class: 'dialog-header' }, h('h2', {}, tr('Переменные в код')), closeButton),
    h(
      'div',
      { class: 'dialog-body tc-body' },
      h(
        'div',
        { class: 'tc-options' },
        h('label', { class: 'tc-field' }, h('span', { class: 'tc-label' }, tr('Язык')), h('div', { class: 'field select-wrap' }, format)),
        h('label', { class: 'tc-field tc-template', title: tr('{collection} — коллекция, {group} — группа, {name} — имя, {path} — группа и имя') }, h('span', { class: 'tc-label' }, tr('Имя: {collection}, {group}, {name}, {path}')), h('div', { class: 'field text-field' }, template)),
        h('label', { class: 'tc-field' }, h('span', { class: 'tc-label' }, tr('Написание')), h('div', { class: 'field select-wrap' }, nameCase)),
        h('label', { class: 'checkbox' }, latin, h('span', {}, tr('Латиницей'))),
        h('label', { class: 'checkbox', title: tr('Имена, заданные у переменной в «Имена в коде», важнее шаблона') }, codeNames, h('span', {}, tr('Свои имена в коде'))),
      ),
      example,
      collections.length > 1 ? picks : null,
      preview,
    ),
    h('footer', { class: 'dialog-footer' }, h('button', { class: 'text-button', type: 'button', onclick: close }, tr('Закрыть')), copy, save),
  );
  const overlay = h('div', { class: 'dialog-overlay' }, dialog);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  document.body.append(overlay);
  sync();
  format.focus();
}

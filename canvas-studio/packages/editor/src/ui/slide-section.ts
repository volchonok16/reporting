// The «Слайд» section of the right panel in a presentation (FEAT-157): how the
// slide the selection is on comes in during the show, and whether the show skips
// it. Its speaker's notes are under the slide (slide-notes.ts).

import { tr, type NodeId, type SlideFile, type SlideTransition } from '#core';
import type { Editor } from '../editor.ts';
import { fileAnchor, openSlideFile } from '../slide-files.ts';
import { slideInfo } from '../slides.ts';
import { h } from './dom.ts';

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 8;

const TRANSITIONS = (): [SlideTransition['type'], string][] => [
  ['NONE', tr('Без перехода')],
  ['DISSOLVE', tr('Растворение')],
  ['MOVE_IN', tr('Наплыв справа')],
  ['PUSH', tr('Сдвиг')],
  ['SLIDE_UP', tr('Снизу вверх')],
];

export function buildSlideSection(editor: Editor, section: (title: string, ...actions: HTMLElement[]) => HTMLElement, slide: NodeId, onPresent: () => void): void {
  const d = editor.doc;
  const info = slideInfo(d, slide);
  const ro = d.readOnly;
  const write = (label: string, patch: Partial<typeof info>) => editor.commit(label, (tx) => tx.set(slide, 'slide', { ...slideInfo(d, slide), ...patch }));
  const play = h('button', { class: 'icon-button', type: 'button', title: tr('Показ с этого слайда'), 'aria-label': tr('Показ с этого слайда'), onclick: onPresent }, '▶');
  const body = section(tr('Слайд'), play);
  const t = info.transition ?? { type: 'NONE', duration: 400 };
  const kind = h('select', { class: 'field-select', disabled: ro, 'aria-label': tr('Переход') }, ...TRANSITIONS().map(([v, label]) => h('option', { value: v, selected: v === t.type }, label))) as HTMLSelectElement;
  const duration = h('select', { class: 'field-select', disabled: ro || t.type === 'NONE', 'aria-label': tr('Длительность перехода') }, ...[200, 300, 400, 600, 800, 1000].map((ms) => h('option', { value: String(ms), selected: ms === t.duration }, tr('{0} мс', ms)))) as HTMLSelectElement;
  const setTransition = () => write(tr('Переход слайда'), { transition: { type: kind.value as SlideTransition['type'], duration: Number(duration.value) } });
  kind.addEventListener('change', () => {
    duration.disabled = kind.value === 'NONE';
    setTransition();
  });
  duration.addEventListener('change', setTransition);
  const skip = h('input', { type: 'checkbox', checked: !!info.skip, disabled: ro }) as HTMLInputElement;
  skip.addEventListener('change', () => write(skip.checked ? tr('Пропускать слайд') : tr('Показывать слайд'), { skip: skip.checked }));
  // The notes are under the slide (FEAT-166), as in Figma Slides.
  const filesHost = h('div', { class: 'slide-files' });
  const paintFiles = () => {
    const files = slideInfo(d, slide).files ?? [];
    filesHost.replaceChildren(
      ...files.map((file, index) =>
        h(
          'div',
          { class: 'slide-file' },
          h('span', { class: 'slide-file-name', title: file.name }, file.name),
          h('button', { class: 'link-button', type: 'button', onclick: () => openSlideFile(d, file, 'open') || editor.toast(tr('Файл не найден')) }, tr('Открыть')),
          h('button', { class: 'link-button', type: 'button', onclick: () => openSlideFile(d, file, 'download') || editor.toast(tr('Файл не найден')) }, tr('Скачать')),
          ro
            ? ''
            : h('button', { class: 'link-button', type: 'button', onclick: () => removeFile(index) }, tr('Убрать')),
        ),
      ),
    );
  };
  const removeFile = (index: number) => {
    const files = (slideInfo(d, slide).files ?? []).filter((_, i) => i !== index);
    write(tr('Убрать файл слайда'), { files });
    paintFiles();
  };
  const input = h('input', { type: 'file', multiple: true, hidden: true }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const picked = [...(input.files ?? [])];
    input.value = '';
    void addFiles(picked);
  });
  const addFiles = async (picked: File[]) => {
    if (d.readOnly || picked.length === 0) return;
    const current = slideInfo(d, slide).files ?? [];
    const room = MAX_FILES - current.length;
    if (room <= 0) {
      editor.toast(tr('На слайде уже {0} файлов', MAX_FILES), 'error');
      return;
    }
    const accepted: { name: string; bytes: Uint8Array; mime: string }[] = [];
    for (const file of picked.slice(0, room)) {
      if (file.size > MAX_FILE_BYTES) {
        editor.toast(tr('«{0}» больше 15 МБ', file.name), 'error');
        continue;
      }
      accepted.push({
        name: file.name.replace(/[/\\]/g, ' ').trim().slice(0, 120) || tr('Файл'),
        bytes: new Uint8Array(await file.arrayBuffer()),
        mime: file.type || 'application/octet-stream',
      });
    }
    if (!accepted.length) return;
    const height = d.get(slide, 'height');
    editor.commit(tr('Файл на слайде'), (tx) => {
      const files: SlideFile[] = [...current];
      for (const item of accepted) {
        files.push({ name: item.name, hash: tx.addBlob(item.bytes, item.mime), mime: item.mime, ...fileAnchor(files.length, height) });
      }
      tx.set(slide, 'slide', { ...slideInfo(d, slide), files });
    });
    paintFiles();
  };
  paintFiles();
  body.append(
    h('div', { class: 'slide-row' }, h('span', { class: 'field-label' }, tr('Переход')), kind, duration),
    h('label', { class: 'slide-check' }, skip, h('span', {}, tr('Пропускать при показе'))),
    h('div', { class: 'slide-file-head' }, h('span', { class: 'field-label' }, tr('Файлы')), ro ? '' : h('button', { class: 'link-button', type: 'button', onclick: () => input.click() }, tr('Прикрепить'))),
    input,
    filesHost,
  );
}

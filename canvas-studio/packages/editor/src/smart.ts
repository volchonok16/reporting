// Smart actions (✦): a layout from a description (FEAT-172 — a model on the
// server writes it), tidying a layout up and renaming layers by their content,
// in one menu that offers only what fits the selection. Each action says what
// it will do, with a number or an example; an action with nothing to do is not
// offered at all.

import { isBoard } from './board.ts';
import { plural, tr, type NodeId } from '#core';
import { planTidy, tidyKinds, tidySummary } from './tidy.ts';
import { nameLayers, unnamedLayers, writableTexts, writeTexts } from './ai-text.ts';
import type { Editor } from './editor.ts';
import { IS_MAC } from './keyboard.ts';

export interface SmartAction {
  /** The command that does it (commands.ts). */
  command: string;
  title: string;
  /** What exactly will happen: one line. */
  desc: string;
  /** The main one: stands out in the menu. */
  primary?: boolean;
  /** Asks a few words first (the menu turns into a field with ready wishes), then runs with them instead of the command. */
  ask?: { placeholder: string; chips: string[]; button: string; run: (text: string) => void };
}

export interface SmartMenu {
  /** What the actions are for: «Для «Главная»», «Для 3 слоёв», «Для страницы». */
  heading: string;
  actions: SmartAction[];
  /** Nothing fits: what to select instead. */
  empty: string;
}

/** A name for a new text style by its size. */
export function textStyleName(size: number): string {
  const base = size >= 28 ? tr('Заголовок') : size >= 18 ? tr('Подзаголовок') : size >= 14 ? tr('Основной') : tr('Подпись');
  return `${base} ${Math.round(size)}`;
}

export function smartActions(editor: Editor): SmartMenu {
  // A board has no ✦: its sorting is on the bar over the selected stickies (BUG-071).
  if (isBoard(editor.doc)) return { heading: '', actions: [], empty: '' };
  const d = editor.doc;
  if (d.readOnly) return { heading: '', actions: [], empty: tr('Только просмотр: умные действия меняют файл.') };
  const ids = editor.topLevelSelection();
  const roots = ids.length ? ids : [...d.children(editor.pageId)];
  // Only what works well (28 October): a layout from a description, tidying, names. The rest
  // (repeats, contrast, data, styles, raster…) did poorly and is gone from the menu; their
  // commands stay in the palette. Screen templates moved to «Макеты, иконки, контент».
  const actions: SmartAction[] = [];

  if (ids.length === 0) {
    actions.push({ command: 'smart.generate', title: tr('Макет по описанию'), desc: tr('Опишите экран словами — нейросеть сверстает его, и он станет слоями') });
  }

  // Pixels, gaps, variables (and names) at once; names alone are the next item.
  const plan = planTidy(editor, roots);
  if (tidyKinds(plan) - (plan.names.size ? 1 : 0) > 0) {
    actions.push({ command: 'object.tidy', title: tr('Привести в порядок'), desc: tidySummary(plan), primary: true });
  }

  // One frame with layers: changed by a description, as a layout from a description is (FEAT-172).
  // In a presentation with nothing selected — the slide on show, whoever made it.
  const slide = ids.length === 0 ? editor.slideStage?.current() : null;
  if (slide && d.store.isAlive(slide) && d.children(slide).length > 0) {
    actions.push({ command: 'smart.editLayout', title: tr('Изменить слайд по описанию'), desc: tr('Скажите словами, что улучшить: нейросеть переделает «{0}» — заметки и тема останутся', String(d.get(slide, 'name'))) });
  } else if (ids.length === 1 && d.type(ids[0]!) === 'FRAME' && d.children(ids[0]!).length > 0 && (editor.canTransform(ids[0]!) || editor.isSlide(ids[0]!))) {
    actions.push({ command: 'smart.editLayout', title: tr('Изменить по описанию'), desc: tr('Скажите словами, что поправить: нейросеть переделает «{0}», а вы сравните до и после', String(d.get(ids[0]!, 'name'))) });
  }

  // Texts of a layout: the model writes real ones for this screen (ai-text.ts).
  const texts = ids.length ? writableTexts(editor, roots).length : 0;
  if (texts > 0) {
    actions.push({
      command: 'smart.texts',
      title: tr('Придумать тексты'),
      desc: tr('{0} {1}: нейросеть напишет настоящие под этот экран, длина сохранится', texts, plural(texts, tr('текст'), tr('текста'), tr('текстов'))),
      ask: {
        placeholder: tr('Пожелание, если есть: о чём экран, тон, язык'),
        chips: [tr('Короче'), tr('Дружелюбнее'), tr('Официальнее'), tr('На английском'), tr('На русском')],
        button: tr('Придумать'),
        run: (hint) => {
          if (busy(editor)) return;
          editor.track(tr('Нейросеть пишет тексты…'), roots, writeTexts(editor, roots, hint)).then(
            (n) => editor.toast(n ? tr('Новых текстов: {0}. Отменить — {1}.', n, undoKey()) : tr('Нейросеть оставила тексты как есть.')),
            (error: unknown) => editor.toast(error instanceof Error ? error.message : String(error)),
          );
        },
      },
    });
  }

  // Names by what a layer is: «Rectangle 23» → «Карточка тарифа» — the model names them all, the rules stand behind it (ai-text.ts).
  // Always on offer (29 October): new layers keep coming; with none to name it says so.
  const unnamed = unnamedLayers(editor, roots).length;
  actions.push({
    command: 'object.autoName',
    title: ids.length ? tr('Переименовать слои') : tr('Переименовать слои на странице'),
    desc: unnamed
      ? tr('{0} {1} без своего имени: нейросеть назовёт по смыслу', unnamed, plural(unnamed, tr('слой'), tr('слоя'), tr('слоёв')))
      : tr('Сейчас все слои названы; новые нейросеть назовёт по смыслу. Имена, которые вы дали сами, не меняются'),
  });

  const heading =
    ids.length === 0 ? tr('Для страницы') : ids.length === 1 ? tr('Для «{0}»', d.get(ids[0]!, 'name')) : tr('Для {0} {1}', ids.length, plural(ids.length, tr('слоя'), tr('слоёв'), tr('слоёв')));
  return {
    heading,
    actions,
    empty: ids.length ? tr('Для этого слоя действий нет: имена, отступы и цвета уже в порядке. Попробуйте выделить фрейм целиком или несколько слоёв.') : tr('На странице нечего приводить в порядок.'),
  };
}

const undoKey = () => (IS_MAC ? '⌘Z' : 'Ctrl+Z');

/** One model job at a time: a second one waits for the first (its glow is on the canvas). */
function busy(editor: Editor): boolean {
  if (!editor.works.size) return false;
  editor.toast(tr('Нейросеть ещё работает — дождитесь, пока закончит.'));
  return true;
}

/** The rename command: the model names every layer with a default name; unreachable — the rules do (one step either way). */
export function renameLayers(editor: Editor): void {
  const roots = editor.selection.length ? editor.topLevelSelection() : [...editor.doc.children(editor.pageId)];
  if (busy(editor)) return;
  if (!unnamedLayers(editor, roots).length) return editor.toast(tr('Нечего переименовывать: у слоёв уже свои имена.'));
  editor.track(tr('Нейросеть называет слои…'), roots, nameLayers(editor, roots)).then(
    (n) => editor.toast(n ? tr('Переименовано слоёв: {0}. Отменить — {1}.', n, undoKey()) : tr('Нейросеть оставила имена как есть.')),
    (error: unknown) => {
      const why = error instanceof Error ? error.message : String(error);
      const n = editor.autoName();
      editor.toast(n ? tr('{0}. Назвал по правилам: {1}. Отменить — {2}.', why, n, undoKey()) : why);
    },
  );
}

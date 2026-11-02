// Ready boards to start from (FEAT-086): a retro, a brainstorm, a kanban, a
// flowchart, a user journey, a team intro. Each is built of the board's own
// objects (sections, stickies, shapes, connectors) at the middle of the view,
// as one step to undo.

import { solid, tr, type NodeId } from '#core';
import type { Point } from '#geometry';
import { connectorLabel, createConnector, createShape, createSticky, STICKY_COLORS } from './board.ts';
import { boardTextOf } from '#components';
import type { Editor } from './editor.ts';

export interface BoardTemplate {
  id: string;
  name: string;
  description: string;
  /** Size of what it builds (to centre it). */
  width: number;
  height: number;
  build: (b: Builder) => void;
}

const YELLOW = STICKY_COLORS[0]!.hex;
const GREEN = STICKY_COLORS[6]!.hex;
const RED = STICKY_COLORS[2]!.hex;
const BLUE = STICKY_COLORS[5]!.hex;
const VIOLET = STICKY_COLORS[4]!.hex;
const ORANGE = STICKY_COLORS[1]!.hex;

/** Builds at an origin (the template's top-left in the page). */
class Builder {
  readonly editor: Editor;
  readonly origin: Point;
  readonly made: NodeId[] = [];

  constructor(editor: Editor, origin: Point) {
    this.editor = editor;
    this.origin = origin;
  }

  private at(x: number, y: number): Point {
    return { x: this.origin.x + x, y: this.origin.y + y };
  }

  section(name: string, x: number, y: number, width: number, height: number, fill = '#FFFFFF'): NodeId {
    const p = this.at(x, y);
    const id = this.editor.doc.transact((tx) =>
      tx.create('SECTION', this.editor.pageId, { name, x: Math.round(p.x), y: Math.round(p.y), width, height, fills: [solid(hex(fill))] }),
    );
    this.made.push(id);
    return id;
  }

  /** A heading text inside a section (its coordinates are the section's). */
  heading(parent: NodeId, text: string, x: number, y: number, size = 24): void {
    this.editor.doc.transact((tx) => tx.create('TEXT', parent, { name: text, x, y, characters: text, fontSize: size, fontWeight: 700, fills: [solid(hex('#1E1E1E'))] }));
  }

  sticky(x: number, y: number, color: string, text = '', into?: NodeId, size = 240): NodeId {
    // A template's stickies have no author yet: whoever writes in one first signs it.
    const author = this.editor.boardPrefs.author;
    this.editor.boardPrefs.author = '';
    const id = createSticky(this.editor, this.at(x + size / 2, y + size / 2), color, size, into);
    this.editor.boardPrefs.author = author;
    if (text) this.write(id, text);
    if (!into) this.made.push(id);
    return id;
  }

  shape(x: number, y: number, width: number, height: number, shape: Parameters<typeof createShape>[2], fill: string, text: string, into?: NodeId): NodeId {
    const p = this.at(x, y);
    const id = createShape(this.editor, { x: p.x, y: p.y, width, height }, shape, fill, into);
    this.write(id, text);
    if (!into) this.made.push(id);
    return id;
  }

  connect(a: NodeId, b: NodeId, label = '', sides: [string, string] = ['AUTO', 'AUTO']): void {
    const id = createConnector(this.editor, { node: a, side: sides[0] as 'AUTO', x: 0, y: 0 }, { node: b, side: sides[1] as 'AUTO', x: 0, y: 0 }, 'ELBOW', '#1E1E1E');
    this.made.push(id);
    if (label) {
      const l = connectorLabel(this.editor, id);
      const t = this.editor.doc.children(l)[0];
      if (t) this.editor.doc.transact((tx) => tx.set(t, 'characters', label));
      this.made.push(l);
    }
  }

  private write(id: NodeId, text: string): void {
    const t = boardTextOf(this.editor.doc, id);
    if (t) this.editor.doc.transact((tx) => tx.set(t, 'characters', text));
  }
}

function hex(h: string) {
  const n = parseInt(h.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
}

export function boardTemplates(): BoardTemplate[] {
  return [
    {
      id: 'retro',
      name: tr('Ретроспектива'),
      description: tr('Три колонки: что было хорошо, что мешало, что попробуем. Каждый пишет стикеры, потом голосуете.'),
      width: 1040,
      height: 760,
      build: (b) => {
        const s = b.section(tr('Ретроспектива'), 0, 0, 1040, 760);
        const cols: [string, string][] = [[tr('Что было хорошо'), GREEN], [tr('Что мешало'), RED], [tr('Что попробуем'), BLUE]];
        cols.forEach(([title, color], i) => {
          b.heading(s, title, 40 + i * 330, 40);
          b.sticky(40 + i * 330, 100, color, '', s);
          b.sticky(40 + i * 330, 380, color, '', s);
        });
      },
    },
    {
      id: 'brainstorm',
      name: tr('Мозговой штурм'),
      description: tr('Вопрос в центре и место для идей вокруг: пишите всё, что приходит в голову, потом сгруппируйте.'),
      width: 1200,
      height: 900,
      build: (b) => {
        const s = b.section(tr('Мозговой штурм'), 0, 0, 1200, 900);
        b.shape(470, 370, 260, 160, 'ELLIPSE', '#E8DBFF', tr('Вопрос: как…?'), s);
        const spots: [number, number][] = [[60, 60], [480, 60], [900, 60], [60, 600], [480, 640], [900, 600]];
        const colors = [YELLOW, ORANGE, GREEN, BLUE, VIOLET, YELLOW];
        spots.forEach(([x, y], i) => b.sticky(x, y, colors[i]!, '', s, 220));
      },
    },
    {
      id: 'kanban',
      name: tr('Канбан'),
      description: tr('Сделать, в работе, готово: перетаскивайте стикеры-задачи из колонки в колонку.'),
      width: 1060,
      height: 860,
      build: (b) => {
        const cols = [tr('Сделать'), tr('В работе'), tr('Готово')];
        const fills = ['#F4F4F4', '#FFF8E0', '#EAF7E8'];
        cols.forEach((title, i) => {
          // The column's name is the section's own (a heading inside repeated it — BUG-076).
          const s = b.section(title, i * 360, 0, 340, 860, fills[i]);
          if (i === 0) {
            b.sticky(30, 60, YELLOW, tr('Задача'), s, 280);
            b.sticky(30, 370, YELLOW, '', s, 280);
          }
        });
      },
    },
    {
      id: 'flowchart',
      name: tr('Блок-схема'),
      description: tr('Начало, шаг, развилка и два исхода со связями: дописывайте шаги кнопкой «+» у фигуры.'),
      width: 940,
      height: 620,
      build: (b) => {
        const start = b.shape(0, 40, 200, 90, 'ROUNDED', '#E8DBFF', tr('Начало'));
        const step = b.shape(320, 40, 200, 90, 'RECTANGLE', '#FFFFFF', tr('Шаг'));
        const fork = b.shape(320, 220, 200, 150, 'DIAMOND', '#FFF1B8', tr('Условие?'));
        const yes = b.shape(680, 250, 220, 90, 'RECTANGLE', '#D6EBFF', tr('Если да'));
        const no = b.shape(320, 480, 200, 90, 'RECTANGLE', '#FFD1D1', tr('Если нет'));
        b.connect(start, step);
        b.connect(step, fork);
        b.connect(fork, yes, tr('да'), ['RIGHT', 'LEFT']);
        b.connect(fork, no, tr('нет'), ['BOTTOM', 'TOP']);
      },
    },
    {
      id: 'journey',
      name: tr('Путь пользователя'),
      description: tr('Этапы по горизонтали, действия, мысли и чувства по строкам: где человеку трудно и что поменять.'),
      width: 1340,
      height: 960,
      build: (b) => {
        const s = b.section(tr('Путь пользователя'), 0, 0, 1340, 960);
        const stages = [tr('Узнаёт'), tr('Выбирает'), tr('Покупает'), tr('Пользуется')];
        const rows: [string, string][] = [[tr('Действия'), YELLOW], [tr('Мысли'), BLUE], [tr('Чувства'), ORANGE]];
        stages.forEach((st, i) => b.shape(220 + i * 280, 40, 240, 80, 'ROUNDED', '#E8DBFF', st, s));
        rows.forEach(([title, color], r) => {
          b.heading(s, title, 40, 190 + r * 260, 20);
          stages.forEach((_, i) => b.sticky(220 + i * 280, 150 + r * 260, color, '', s, 220));
        });
      },
    },
    {
      id: 'intro',
      name: tr('Знакомство команды'),
      description: tr('По стикеру на человека: имя, роль и что-нибудь интересное о себе.'),
      width: 1040,
      height: 720,
      build: (b) => {
        const s = b.section(tr('Знакомство команды'), 0, 0, 1040, 720);
        b.heading(s, tr('Давайте знакомиться'), 40, 36);
        const colors = [YELLOW, ORANGE, GREEN, BLUE, VIOLET, RED];
        colors.forEach((color, i) => b.sticky(40 + (i % 3) * 330, 100 + Math.floor(i / 3) * 300, color, tr('Имя:\nРоль:\nИнтересный факт:'), s));
      },
    },
  ];
}

/**
 * The board of «Попробовать доску» (29 October: each kind has an example to look at): a team's
 * retro filled in, and the flowchart of the app's sign-in next to it — what a board is for, at a glance.
 */
export function boardExample(): BoardTemplate {
  return {
    id: 'example',
    name: tr('Пример'),
    description: '',
    width: 1900,
    height: 760,
    build: (b) => {
      const s = b.section(tr('Ретро: спринт 14'), 0, 0, 1040, 760);
      const cols: [string, string, string, string][] = [
        [tr('Что было хорошо'), GREEN, tr('Релиз вышел без переносов'), tr('Быстрые ревью в ветках')],
        [tr('Что мешало'), RED, tr('Долгие согласования макетов'), tr('Тесты падали по пятницам')],
        [tr('Что попробуем'), BLUE, tr('Ретро каждые две недели'), tr('Демо для всех по четвергам')],
      ];
      cols.forEach(([title, color, a, c], i) => {
        b.heading(s, title, 40 + i * 330, 40);
        b.sticky(40 + i * 330, 100, color, a, s);
        b.sticky(40 + i * 330, 380, color, c, s);
      });
      const open = b.shape(1240, 60, 240, 90, 'ROUNDED', '#E8DBFF', tr('Открыть приложение'));
      const fork = b.shape(1240, 230, 240, 160, 'DIAMOND', '#FFF1B8', tr('Есть аккаунт?'));
      const home = b.shape(1620, 265, 260, 90, 'RECTANGLE', '#FFFFFF', tr('Главный экран'));
      const join = b.shape(1240, 480, 240, 90, 'RECTANGLE', '#FFFFFF', tr('Регистрация'));
      const saved = b.shape(1620, 480, 260, 90, 'ROUNDED', '#D6EBFF', tr('Профиль сохранён'));
      b.connect(open, fork);
      b.connect(fork, home, tr('да'), ['RIGHT', 'LEFT']);
      b.connect(fork, join, tr('нет'), ['BOTTOM', 'TOP']);
      b.connect(join, saved, '', ['RIGHT', 'LEFT']);
      b.connect(saved, home, '', ['TOP', 'BOTTOM']);
    },
  };
}

/** Builds a template at the middle of the view, as one undo step, and shows it. */
export function insertBoardTemplate(editor: Editor, t: BoardTemplate): void {
  const { width, height } = editor.screenSize;
  const center = editor.viewport.screenToWorld({ x: width / 2, y: height / 2 });
  const origin = { x: Math.round(center.x - t.width / 2), y: Math.round(center.y - t.height / 2) };
  let made: NodeId[] = [];
  editor.commit(tr('Шаблон «{0}»', t.name), () => {
    const b = new Builder(editor, origin);
    t.build(b);
    made = b.made;
  });
  editor.setSelection(made.filter((id) => editor.doc.store.isAlive(id) && editor.doc.parent(id) === editor.pageId));
  editor.zoomToSelection();
  editor.setSelection([]);
}

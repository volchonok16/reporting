// Editing variables (section 11, FR-VAR): collections, modes, variables and
// their values, bindings of layer fields, modes of pages and frames, usages and
// the alias graph. Every change is one undoable step through Editor.commit, so
// bound layers are re-resolved by the transaction pipeline.

import { tr } from '#core';
import {
  BINDABLE_FIELDS,
  aliasChain,
  aliasDependents,
  allValuesOf,
  allVariables,
  baseCollection,
  contextFor,
  explainInMode,
  expressionError,
  extensionsOf,
  fieldSpec,
  isExtension,
  isVariable,
  mapReferences,
  modeFor,
  overrideOf,
  resolveVariable,
  valueFits,
  variableFits,
  variableUsers,
  wouldCycle,
} from '#components';
import { colorToHex, hexToColor, isAlias, isExpression, keyBetween, isColorValue, valueEquals, type Color, type NodeId, type NodeProps, type Position, type VariableLiteral, type VariableScope, type VariableType, type VariableValue } from '#core';
import type { Editor } from './editor.ts';

export const TYPE_NAMES: Record<VariableType, string> = { COLOR: tr('Цвет'), FLOAT: tr('Число'), STRING: tr('Строка'), BOOLEAN: tr('Логическое') };

const DEFAULT_VALUES: Record<VariableType, VariableLiteral> = {
  COLOR: { r: 1, g: 1, b: 1, a: 1 },
  FLOAT: 0,
  STRING: '',
  BOOLEAN: true,
};

/** Name as typed in an alias: "Color/Grey/500" and "color.grey.500" are the same. */
function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s*[/.]\s*/g, '/');
}

export class VariablesController {
  private readonly editor: Editor;

  constructor(editor: Editor) {
    this.editor = editor;
  }

  private get doc() {
    return this.editor.doc;
  }

  private newId(): string {
    return this.doc.ids.next();
  }

  // ---------- collections and modes ----------

  createCollection(name?: string): NodeId {
    const d = this.doc;
    const names = new Set(d.collections().map((c) => d.get(c, 'name')));
    let n = name?.trim() || tr('Коллекция');
    if (!name) for (let i = 1; names.has(n); i++) n = tr('Коллекция {0}', i + 1);
    let id = '';
    this.editor.commit(tr('Создать коллекцию'), (tx) => {
      id = tx.create('VARIABLE_COLLECTION', d.rootId, { name: n, modes: [{ id: this.newId(), name: tr('Режим 1') }] });
    });
    return id;
  }

  /**
   * A ready example to learn from: collection «Тема» with modes «Светлая» and
   * «Тёмная» and five colours that differ between them. One undo step.
   */
  createThemeExample(): NodeId {
    const d = this.doc;
    const light = this.newId();
    const dark = this.newId();
    const hex = (v: string) => parseColor(v)!;
    const vars: [string, string, string][] = [
      ['color/bg', '#FFFFFF', '#121212'],
      ['color/surface', '#F5F5F5', '#1E1E1E'],
      ['color/text', '#1E1E1E', '#F2F2F2'],
      ['color/muted', '#5C5C5C', '#A6A6A6'],
      ['color/accent', '#4F5BD5', '#838CF0'],
    ];
    const names = new Set(d.collections().map((c) => d.get(c, 'name')));
    let name = tr('Тема');
    for (let i = 2; names.has(name); i++) name = `${tr('Тема')} ${i}`;
    let id = '';
    this.editor.commit(tr('Пример: светлая и тёмная тема'), (tx) => {
      id = tx.create('VARIABLE_COLLECTION', d.rootId, { name, modes: [{ id: light, name: tr('Светлая') }, { id: dark, name: tr('Тёмная') }] });
      for (const [n, l, dk] of vars) tx.create('VARIABLE', id, { name: n, varType: 'COLOR', varValues: { [light]: hex(l), [dark]: hex(dk) } });
    });
    return id;
  }

  renameCollection(collection: NodeId, name: string): void {
    const v = name.trim();
    if (v) this.editor.commit(tr('Переименовать коллекцию'), (tx) => tx.set(collection, 'name', v));
  }

  /** Deletes a collection with its extensions; layers keep the values of its variables. */
  deleteCollection(collection: NodeId): void {
    const users = variableUsers(this.doc, new Set(this.doc.children(collection))).length;
    const extensions = extensionsOf(this.doc, collection);
    this.editor.commit(tr('Удалить коллекцию'), (tx) => {
      for (const e of extensions) tx.delete(e);
      tx.delete(collection);
    });
    if (users > 0) this.editor.toast(tr('Коллекция удалена; {0} привязок отвязаны, значения сохранены', users));
  }

  /**
   * An extended collection (FR-VAR-013): every variable of `parent` (new ones
   * too) with its modes; the extension overrides only some values. A frame
   * chooses it like a mode: "Бренд Б · Тёмная".
   */
  createExtension(parent: NodeId, name?: string): NodeId {
    const d = this.doc;
    const names = new Set(d.collections().map((c) => d.get(c, 'name')));
    let n = name?.trim() || tr('{0} — расширение', d.get(parent, 'name'));
    for (let i = 2; names.has(n); i++) n = `${name?.trim() || tr('{0} — расширение', d.get(parent, 'name'))} ${i}`;
    let id = '';
    this.editor.commit(tr('Расширить коллекцию'), (tx) => {
      id = tx.create('VARIABLE_COLLECTION', d.rootId, { name: n, extendsCollection: parent, modes: d.get(parent, 'modes').map((m) => ({ ...m })) }, { after: parent });
    });
    return id;
  }

  /** Back to the parent's value for a variable in a mode of an extension (null mode: in every mode). */
  resetOverride(extension: NodeId, variables: readonly NodeId[], mode: string | null): void {
    const all = this.doc.get(extension, 'varOverrides');
    const next = { ...all };
    let changed = false;
    for (const v of variables) {
      const own = next[v];
      if (!own) continue;
      if (mode === null) delete next[v];
      else if (mode in own) {
        const rest = { ...own };
        delete rest[mode];
        if (Object.keys(rest).length > 0) next[v] = rest;
        else delete next[v];
      } else continue;
      changed = true;
    }
    if (changed) this.editor.commit(tr('Вернуть значение родительской коллекции'), (tx) => tx.set(extension, 'varOverrides', next));
  }

  /** The collection whose variables a collection shows: itself, or an extension's base. */
  variablesOf(collection: NodeId): NodeId[] {
    return [...this.doc.children(baseCollection(this.doc, collection))];
  }

  /** Adds a mode; its values start as copies of the default mode (as in Figma). */
  addMode(collection: NodeId, name?: string): string {
    const d = this.doc;
    const modes = d.get(collection, 'modes');
    const id = this.newId();
    const base = modes[0]?.id;
    this.editor.commit(tr('Добавить режим'), (tx) => {
      tx.set(collection, 'modes', [...modes, { id, name: name?.trim() || tr('Режим {0}', modes.length + 1) }]);
      for (const v of d.children(collection)) {
        const values = d.get(v, 'varValues');
        if (base && values[base] !== undefined) tx.set(v, 'varValues', { ...values, [id]: values[base]! });
      }
    });
    return id;
  }

  renameMode(collection: NodeId, mode: string, name: string): void {
    const v = name.trim();
    if (!v) return;
    const modes = this.doc.get(collection, 'modes').map((m) => (m.id === mode ? { ...m, name: v } : m));
    this.editor.commit(tr('Переименовать режим'), (tx) => tx.set(collection, 'modes', modes));
  }

  /** Removes a mode with its values; frames that chose it fall back to the default. */
  deleteMode(collection: NodeId, mode: string): boolean {
    const d = this.doc;
    const modes = d.get(collection, 'modes');
    if (modes.length <= 1) {
      this.editor.toast(tr('В коллекции должен остаться хотя бы один режим'), 'error');
      return false;
    }
    this.editor.commit(tr('Удалить режим'), (tx) => {
      tx.set(collection, 'modes', modes.filter((m) => m.id !== mode));
      for (const v of d.children(collection)) {
        const values = { ...d.get(v, 'varValues') };
        if (mode in values) {
          delete values[mode];
          tx.set(v, 'varValues', values);
        }
      }
    });
    return true;
  }

  /** Makes a mode the default (first). */
  setDefaultMode(collection: NodeId, mode: string): void {
    const modes = this.doc.get(collection, 'modes');
    const m = modes.find((x) => x.id === mode);
    if (!m || modes[0]?.id === mode) return;
    this.editor.commit(tr('Режим по умолчанию'), (tx) => tx.set(collection, 'modes', [m, ...modes.filter((x) => x.id !== mode)]));
  }

  /** Moves a mode column (index in the new order). */
  moveMode(collection: NodeId, mode: string, index: number): void {
    const modes = [...this.doc.get(collection, 'modes')];
    const from = modes.findIndex((m) => m.id === mode);
    if (from < 0) return;
    const [m] = modes.splice(from, 1);
    modes.splice(Math.max(0, Math.min(modes.length, index)), 0, m!);
    this.editor.commit(tr('Переместить режим'), (tx) => tx.set(collection, 'modes', modes));
  }

  // ---------- variables ----------

  /** Unique name inside a collection: "Цвет", "Цвет 2", … (FR-VAR-026 binds by id, names are for people). */
  private uniqueName(collection: NodeId, base: string): string {
    const names = new Set(this.doc.children(collection).map((v) => normName(this.doc.get(v, 'name'))));
    if (!names.has(normName(base))) return base;
    for (let i = 2; ; i++) if (!names.has(normName(`${base} ${i}`))) return `${base} ${i}`;
  }

  createVariable(collection: NodeId, type: VariableType, name?: string, value?: VariableValue, position: Position = { at: 'end' }): NodeId {
    const d = this.doc;
    const v0 = value ?? DEFAULT_VALUES[type];
    const values: Record<string, VariableValue> = {};
    for (const m of d.get(collection, 'modes')) values[m.id] = structuredClone(v0);
    const n = this.uniqueName(collection, name?.trim() || TYPE_NAMES[type]);
    let id = '';
    this.editor.commit(tr('Создать переменную'), (tx) => {
      id = tx.create('VARIABLE', collection, { name: n, varType: type, varValues: values }, position);
    });
    return id;
  }

  renameVariable(variable: NodeId, name: string): boolean {
    const v = name.trim().replace(/\s*\/\s*/g, '/');
    if (!v) return false;
    const collection = this.doc.parent(variable)!;
    const taken = this.doc.children(collection).some((o) => o !== variable && normName(this.doc.get(o, 'name')) === normName(v));
    if (taken) {
      this.editor.toast(tr('Имя «{0}» уже занято в этой коллекции', v), 'error');
      return false;
    }
    this.editor.commit(tr('Переименовать переменную'), (tx) => tx.set(variable, 'name', v));
    return true;
  }

  /**
   * Sets a value (alias or expression) in one mode; refuses wrong types and
   * cycles. With `scope` an extension, the value is the extension's own (FR-VAR-013).
   */
  setValue(variable: NodeId, mode: string, value: VariableValue, scope?: NodeId): boolean {
    const d = this.doc;
    const type = d.get(variable, 'varType');
    if (!valueFits(type, value)) {
      this.editor.toast(tr('Значение не подходит для типа «{0}»', TYPE_NAMES[type]), 'error');
      return false;
    }
    if (isAlias(value)) {
      if (!isVariable(d, value.id) || d.get(value.id, 'varType') !== type) {
        this.editor.toast(tr('Ссылаться можно только на переменную того же типа'), 'error');
        return false;
      }
    }
    if (isExpression(value)) {
      const error = expressionError(value.expr);
      if (error) {
        this.editor.toast(error, 'error');
        return false;
      }
    }
    if (wouldCycle(d, variable, value)) {
      this.editor.toast(tr('Так получится цикл ссылок'), 'error');
      return false;
    }
    if (scope && isExtension(d, scope)) {
      const all = d.get(scope, 'varOverrides');
      if (valueEquals(all[variable]?.[mode], value)) return true;
      this.editor.commit(tr('Значение в расширении'), (tx) => tx.set(scope, 'varOverrides', { ...all, [variable]: { ...(all[variable] ?? {}), [mode]: value } }));
      return true;
    }
    const values = d.get(variable, 'varValues');
    if (valueEquals(values[mode], value)) return true;
    this.editor.commit(tr('Значение переменной'), (tx) => tx.set(variable, 'varValues', { ...values, [mode]: value }));
    return true;
  }

  /** Description, scopes, code names, hiding (FR-VAR-023). */
  setDetails(variable: NodeId, props: Partial<Pick<NodeProps, 'description' | 'scopes' | 'codeSyntax' | 'hiddenFromPublishing'>>): void {
    this.editor.commit(tr('Свойства переменной'), (tx) => tx.update(variable, props));
  }

  duplicateVariable(variable: NodeId): NodeId {
    const d = this.doc;
    const collection = d.parent(variable)!;
    let id = '';
    this.editor.commit(tr('Дублировать переменную'), (tx) => {
      id = tx.create(
        'VARIABLE',
        collection,
        {
          name: this.uniqueName(collection, tr('{0} копия', d.get(variable, 'name'))),
          varType: d.get(variable, 'varType'),
          varValues: structuredClone(d.get(variable, 'varValues')),
          description: d.get(variable, 'description'),
          scopes: [...d.get(variable, 'scopes')],
          codeSyntax: { ...d.get(variable, 'codeSyntax') },
        },
        { after: variable },
      );
    });
    return id;
  }

  /** Deletes variables; bound fields keep their last values (FR-VAR-022 shows the number of usages first). */
  deleteVariables(variables: readonly NodeId[]): void {
    if (variables.length === 0) return;
    this.editor.commit(variables.length === 1 ? tr('Удалить переменную') : tr('Удалить переменные'), (tx) => {
      for (const v of variables) tx.delete(v);
    });
  }

  /** Bulk rename by template: plain text or /regexp/ with $1… (FR-VAR-022). */
  renameByPattern(variables: readonly NodeId[], find: string, replace: string): number {
    const d = this.doc;
    let re: RegExp;
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(find);
    try {
      re = m ? new RegExp(m[1]!, m[2]!.includes('g') ? m[2] : `${m[2]}g`) : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    } catch {
      this.editor.toast(tr('Ошибка в регулярном выражении'), 'error');
      return 0;
    }
    let count = 0;
    this.editor.commit(tr('Переименовать переменные'), (tx) => {
      for (const v of variables) {
        const name = d.get(v, 'name');
        const next = name.replace(re, replace).trim();
        if (next && next !== name) {
          tx.set(v, 'name', next);
          count++;
        }
      }
    });
    return count;
  }

  /** Moves variables into a group ("Brand/Primary" + name's last part) (FR-VAR-022). */
  moveToGroup(variables: readonly NodeId[], group: string): void {
    const g = group.trim().replace(/^\/+|\/+$/g, '');
    this.editor.commit(tr('Переместить в группу'), (tx) => {
      for (const v of variables) {
        const leaf = this.doc.get(v, 'name').split('/').pop()!;
        tx.set(v, 'name', g ? `${g}/${leaf}` : leaf);
      }
    });
  }

  setScopes(variables: readonly NodeId[], scopes: VariableScope[]): void {
    this.editor.commit(tr('Область применения'), (tx) => {
      for (const v of variables) tx.set(v, 'scopes', [...scopes]);
    });
  }

  /** Moves a variable within its collection or into another one (values of unknown modes become defaults). */
  moveVariable(variable: NodeId, collection: NodeId, position: Position = { at: 'end' }): void {
    const d = this.doc;
    const from = d.parent(variable)!;
    this.editor.commit(tr('Переместить переменную'), (tx) => {
      if (from !== collection) {
        const values = d.get(variable, 'varValues');
        const base = values[d.get(from, 'modes')[0]?.id ?? ''] ?? DEFAULT_VALUES[d.get(variable, 'varType')];
        const next: Record<string, VariableValue> = {};
        d.get(collection, 'modes').forEach((m, i) => {
          const sourceMode = d.get(from, 'modes')[i];
          next[m.id] = structuredClone((sourceMode ? values[sourceMode.id] : undefined) ?? base);
        });
        tx.set(variable, 'varValues', next);
      }
      tx.move(variable, collection, position);
    });
  }

  // ---------- lookup and parsing ----------

  /** Variable by name for aliases, preferring `collection`: "{color/grey/500}" or "color.grey.500". */
  findByName(name: string, collection?: NodeId): NodeId | null {
    const d = this.doc;
    const want = normName(name.replace(/^\{|\}$/g, ''));
    const all = d.collections().flatMap((c) => d.children(c).map((v) => ({ v, c })));
    const matches = all.filter(({ v }) => normName(d.get(v, 'name')) === want);
    const qualified = all.filter(({ v, c }) => normName(`${d.get(c, 'name')}/${d.get(v, 'name')}`) === want);
    const pick = [...matches, ...qualified];
    return (pick.find((x) => x.c === collection) ?? pick[0])?.v ?? null;
  }

  /** Why the last parseInput returned null, in words for a toast. */
  parseError = '';

  /**
   * Parses what was typed in a cell: "#RRGGBB[AA]", "rgba(…)", numbers ("16", "16px",
   * "1.5rem" → 24 at base 16), "true/false/да/нет", text; "{name}" or "{name} @ 60%"
   * makes an alias (FR-VAR-002); "= …" or anything else with a {name} or a function
   * is an expression (FR-VAR-003): "{space/base} * 2", "lighten({brand}, 10%)".
   */
  parseInput(type: VariableType, text: string, collection?: NodeId): VariableValue | null {
    this.parseError = '';
    const literal = this.parsePlain(type, text, collection);
    if (literal !== null) return literal;
    const t = text.trim();
    // A string is text as typed: an expression there starts with "=".
    const wanted = t.startsWith('=') || (type !== 'STRING' && /[{(]/.test(t));
    if (!wanted) {
      this.parseError = /^\{/.test(t) ? tr('Нет переменной с таким именем') : tr('Не похоже на значение типа «{0}»', TYPE_NAMES[type]);
      return null;
    }
    const source = t.startsWith('=') ? t.slice(1).trim() : t;
    let missing = '';
    const expr = mapReferences(source, (ref) => {
      const id = this.findByName(ref, collection);
      if (!id) missing ||= ref;
      return id ? `#${id}` : null;
    });
    if (missing) {
      this.parseError = tr('Нет переменной {{0}}', missing);
      return null;
    }
    const error = expressionError(expr);
    if (error) {
      this.parseError = error;
      return null;
    }
    return { type: 'EXPRESSION', expr };
  }

  private parsePlain(type: VariableType, text: string, collection?: NodeId): VariableValue | null {
    const t = text.trim();
    if (t.startsWith('=')) return null;
    const alias = /^\{([^}]+)\}\s*(?:@\s*(\d+(?:[.,]\d+)?)\s*%)?$/.exec(t);
    if (alias) {
      const id = this.findByName(alias[1]!, collection);
      if (!id) return null;
      const value: VariableValue = { type: 'ALIAS', id };
      if (alias[2] !== undefined && type === 'COLOR') value.opacity = Math.max(0, Math.min(1, Number(alias[2].replace(',', '.')) / 100));
      return value;
    }
    switch (type) {
      case 'COLOR':
        return parseColor(t);
      case 'FLOAT': {
        const m = /^(-?\d+(?:[.,]\d+)?)\s*(px|rem|em|%)?$/i.exec(t);
        if (!m) return null;
        const n = Number(m[1]!.replace(',', '.'));
        const unit = m[2]?.toLowerCase();
        // rem / em are converted with the file's base size of 16 px (FR-VAR-004).
        return unit === 'rem' || unit === 'em' ? n * 16 : n;
      }
      case 'BOOLEAN': {
        const v = t.toLowerCase();
        if (['true', '1', 'да', 'yes', 'вкл', 'on'].includes(v)) return true;
        if (['false', '0', 'нет', 'no', 'выкл', 'off'].includes(v)) return false;
        return null;
      }
      case 'STRING':
        return text;
    }
  }

  /** The raw value of a cell: the variable's own, or (with `scope` an extension) the one in effect there. */
  rawOf(variable: NodeId, mode: string, scope?: NodeId): VariableValue | undefined {
    const d = this.doc;
    if (scope && isExtension(d, scope)) {
      for (let c: NodeId | null = scope; c && isExtension(d, c); c = d.get(c, 'extendsCollection')) {
        const own = overrideOf(d, c, variable, mode);
        if (own !== undefined) return own;
      }
    }
    return d.get(variable, 'varValues')[mode];
  }

  /** An expression as a person reads it: ids back to names. */
  expressionText(expr: string): string {
    const d = this.doc;
    return mapReferences(expr, (ref) => (ref.startsWith('#') && isVariable(d, ref.slice(1)) ? d.get(ref.slice(1), 'name') : ref.startsWith('#') ? '?' : null));
  }

  /** Text shown in a cell for editing (inverse of parseInput). */
  formatValue(variable: NodeId, mode: string, scope?: NodeId): string {
    const d = this.doc;
    const value = this.rawOf(variable, mode, scope);
    if (value === undefined) return '';
    if (isExpression(value)) return `= ${this.expressionText(value.expr)}`;
    if (isAlias(value)) {
      const name = isVariable(d, value.id) ? d.get(value.id, 'name') : '?';
      return `{${name}}${value.opacity !== undefined ? ` @ ${Math.round(value.opacity * 100)}%` : ''}`;
    }
    return formatLiteral(value);
  }

  /**
   * Pastes a block of cells (TSV from a spreadsheet) starting at a variable and a
   * mode column; rows beyond the list create new variables of the same type (FR-VAR-020).
   */
  pasteTable(collection: NodeId, startVariable: NodeId | null, startMode: number, text: string): number {
    const d = this.doc;
    const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((r) => r.split('\t'));
    const modes = d.get(collection, 'modes');
    if (isExtension(d, collection)) return this.pasteOverrides(collection, startVariable, startMode, rows);
    const list = [...d.children(collection)];
    let index = startVariable ? list.indexOf(startVariable) : list.length;
    if (index < 0) index = list.length;
    const type: VariableType = startVariable ? d.get(startVariable, 'varType') : 'COLOR';
    // Bulk-friendly: names and order keys are computed in sequence, never by rescanning the list.
    const names = new Set(list.map((v) => normName(d.get(v, 'name'))));
    let key = d.lastChildKey(collection);
    let counter = list.length;
    const nextName = () => {
      let n: string;
      do n = `${TYPE_NAMES[type]} ${++counter}`;
      while (names.has(normName(n)));
      names.add(normName(n));
      return n;
    };
    let changed = 0;
    this.editor.commit(tr('Вставить значения'), (tx) => {
      rows.forEach((cells, r) => {
        let v = list[index + r];
        const values: Record<string, VariableValue> = v ? { ...d.get(v, 'varValues') } : {};
        const vt = v ? d.get(v, 'varType') : type;
        let dirty = false;
        cells.forEach((cell, c) => {
          const mode = modes[startMode + c];
          if (!mode) return;
          const parsed = this.parseInput(vt, cell, collection);
          if (parsed === null || (v && wouldCycle(d, v, parsed))) return;
          values[mode.id] = parsed;
          dirty = true;
          changed++;
        });
        if (!v) {
          for (const m of modes) if (values[m.id] === undefined) values[m.id] = structuredClone(DEFAULT_VALUES[type]);
          key = keyBetween(key, null);
          v = tx.create('VARIABLE', collection, { name: nextName(), varType: type, varValues: values }, { key });
          list.push(v);
        } else if (dirty) tx.set(v, 'varValues', values);
      });
    });
    return changed;
  }

  /** Pasting into an extension: its own values for the parent's variables; no new rows (FR-VAR-013). */
  private pasteOverrides(extension: NodeId, startVariable: NodeId | null, startMode: number, rows: string[][]): number {
    const d = this.doc;
    const modes = d.get(extension, 'modes');
    const list = this.variablesOf(extension);
    const index = startVariable ? Math.max(0, list.indexOf(startVariable)) : 0;
    const all = { ...d.get(extension, 'varOverrides') };
    let changed = 0;
    rows.forEach((cells, r) => {
      const v = list[index + r];
      if (!v) return;
      const own = { ...(all[v] ?? {}) };
      cells.forEach((cell, c) => {
        const mode = modes[startMode + c];
        const parsed = mode ? this.parseInput(d.get(v, 'varType'), cell, extension) : null;
        if (!mode || parsed === null || wouldCycle(d, v, parsed)) return;
        own[mode.id] = parsed;
        changed++;
      });
      all[v] = own;
    });
    if (changed > 0) this.editor.commit(tr('Вставить значения'), (tx) => tx.set(extension, 'varOverrides', all));
    return changed;
  }

  /** Cells as TSV for copying (FR-VAR-020). */
  copyTable(variables: readonly NodeId[], modes: readonly string[], scope?: NodeId): string {
    return variables.map((v) => modes.map((m) => this.formatValue(v, m, scope)).join('\t')).join('\n');
  }

  // ---------- bindings ----------

  /** Selected nodes a field applies to. */
  private targets(field: string, ids: readonly NodeId[] = this.editor.selection): NodeId[] {
    const spec = fieldSpec(field);
    if (!spec) return [];
    return ids.filter((id) => this.doc.store.isAlive(id) && spec.read(this.doc, id) !== undefined);
  }

  /** Binds a field of the selected layers (or of `ids`) to a variable; null unbinds keeping the value. */
  bind(field: string, variable: NodeId | null, ids?: readonly NodeId[]): number {
    const d = this.doc;
    const spec = fieldSpec(field);
    if (!spec) return 0;
    const targets = this.targets(field, ids).filter((id) => variable === null || variableFits(d, variable, spec, d.type(id)));
    if (targets.length === 0) return 0;
    this.editor.commit(variable ? tr('Применить переменную') : tr('Отвязать переменную'), (tx) => {
      for (const id of targets) {
        const bound = { ...(d.get(id, 'boundVariables') ?? {}) };
        if (variable) bound[field] = variable;
        else delete bound[field];
        tx.set(id, 'boundVariables', Object.keys(bound).length > 0 ? bound : null);
        if (variable && (field === 'width' || field === 'height')) {
          // A size from a variable is a fixed size.
          tx.set(id, field === 'width' ? 'sizingH' : 'sizingV', { mode: 'FIXED' });
          if (d.type(id) === 'TEXT') tx.set(id, 'textAutoResize', field === 'width' ? 'HEIGHT' : 'NONE');
        }
        if (variable && field === 'lineHeight' && d.get(id, 'lineHeight').unit !== 'PX') tx.set(id, 'lineHeight', { unit: 'PX', value: d.get(id, 'fontSize') * 1.4 });
      }
    });
    return targets.length;
  }

  /** The variable the whole selection uses for a field: id, null or 'mixed'. */
  boundOf(field: string, ids: readonly NodeId[] = this.editor.selection): NodeId | null | 'mixed' {
    const targets = this.targets(field, ids);
    if (targets.length === 0) return null;
    const first = this.doc.get(targets[0]!, 'boundVariables')?.[field] ?? null;
    return targets.every((id) => (this.doc.get(id, 'boundVariables')?.[field] ?? null) === first) ? first : 'mixed';
  }

  /** Variables offered for a field of the selection, in collection order (FR-VAR-030). */
  candidates(field: string, ids: readonly NodeId[] = this.editor.selection): NodeId[] {
    const d = this.doc;
    const spec = fieldSpec(field);
    if (!spec) return [];
    const targets = this.targets(field, ids);
    const types = new Set(targets.map((id) => d.type(id)));
    return d
      .collections()
      .flatMap((c) => [...d.children(c)])
      .filter((v) => [...types].every((t) => variableFits(d, v, spec, t)));
  }

  /** Value of a variable as the first selected layer sees it (preview in the picker). */
  previewValue(variable: NodeId, ids: readonly NodeId[] = this.editor.selection): VariableLiteral | undefined {
    return resolveVariable(this.doc, variable, ids[0] ?? null);
  }

  /** Variables whose value equals `value` for a field of the selection (FR-VAR-031 suggestion). */
  matching(field: string, value: VariableLiteral, ids: readonly NodeId[] = this.editor.selection): NodeId[] {
    return this.candidates(field, ids).filter((v) => {
      const r = this.previewValue(v, ids);
      return r !== undefined && (isColorValue(r) && isColorValue(value) ? colorToHex(r, true) === colorToHex(value, true) : valueEquals(r, value));
    });
  }

  /**
   * "Find unbound values" (FR-VAR-032): fields of the selection (or the page)
   * whose value equals a variable but is not bound. Width, height and texts are
   * left out: equal numbers there are usually a coincidence.
   */
  findUnbound(roots?: readonly NodeId[]): { id: NodeId; field: string; variables: NodeId[] }[] {
    const d = this.doc;
    const out: { id: NodeId; field: string; variables: NodeId[] }[] = [];
    const skip = new Set(['width', 'height', 'visible', 'characters', 'fontFamily']);
    const visit = (id: NodeId) => {
      const bound = d.get(id, 'boundVariables') ?? {};
      const fields = [
        ...BINDABLE_FIELDS.filter((f) => !skip.has(f.field)).map((f) => f.field),
        ...d.get(id, 'fills').map((_, i) => `fills/${i}`),
        ...d.get(id, 'strokes').map((_, i) => `strokes/${i}`),
        ...d.get(id, 'effects').map((_, i) => `effects/${i}`),
      ];
      for (const field of fields) {
        if (bound[field]) continue;
        const spec = fieldSpec(field);
        const value = spec?.read(d, id);
        if (value === undefined || value === 0 || (spec && spec.type !== 'COLOR' && spec.type !== 'FLOAT')) continue;
        const variables = this.matching(field, value, [id]);
        if (variables.length > 0) out.push({ id, field, variables });
      }
    };
    const starts = roots && roots.length > 0 ? roots : [this.editor.pageId];
    for (const r of starts) {
      if (d.type(r) !== 'PAGE') visit(r);
      d.store.walk(r, (id) => {
        visit(id);
      });
    }
    return out;
  }

  /** Binds every unambiguous unbound value found by findUnbound in one step. Returns [bound, ambiguous]. */
  bindUnbound(roots?: readonly NodeId[]): [number, number] {
    const found = this.findUnbound(roots);
    const sure = found.filter((f) => f.variables.length === 1);
    if (sure.length > 0) {
      const d = this.doc;
      this.editor.commit(tr('Привязать значения к переменным'), (tx) => {
        for (const f of sure) tx.set(f.id, 'boundVariables', { ...(d.get(f.id, 'boundVariables') ?? {}), [f.field]: f.variables[0]! });
      });
    }
    return [sure.length, found.length - sure.length];
  }

  // ---------- modes of pages and frames ----------

  /**
   * Chooses the mode of a collection for nodes (page, frame, group, instance);
   * null = inherit. `collection` may be an extension (FR-VAR-013): the choice
   * replaces any other choice of the same family on these nodes.
   */
  setMode(ids: readonly NodeId[], collection: NodeId, mode: string | null): void {
    const d = this.doc;
    const base = baseCollection(d, collection);
    const family = new Set([base, ...extensionsOf(d, base)]);
    this.editor.commit(tr('Режим переменных'), (tx) => {
      for (const id of ids) {
        const modes = { ...(d.get(id, 'variableModes') ?? {}) };
        for (const k of Object.keys(modes)) if (family.has(k)) delete modes[k];
        if (mode) modes[collection] = mode;
        tx.set(id, 'variableModes', Object.keys(modes).length > 0 ? modes : null);
      }
    });
  }

  /** Explicit mode of a node, or null when inherited. */
  explicitMode(id: NodeId, collection: NodeId): string | null {
    return this.doc.get(id, 'variableModes')?.[collection] ?? null;
  }

  /** Explicit choice for a collection's family on a node: which collection or extension, and the mode. */
  explicitChoice(id: NodeId, collection: NodeId): { scope: NodeId; mode: string } | null {
    const d = this.doc;
    const base = baseCollection(d, collection);
    const own = d.get(id, 'variableModes');
    if (!own) return null;
    const c = contextFor(d, null, base, own);
    return c.mode && Object.keys(own).some((k) => k === c.scope) ? { scope: c.scope, mode: c.mode } : null;
  }

  /** Mode in effect for a node. */
  effectiveMode(id: NodeId, collection: NodeId): string | null {
    return modeFor(this.doc, id, collection);
  }

  /** Collection (or extension) and mode in effect for a node. */
  effectiveChoice(id: NodeId | null, collection: NodeId): { scope: NodeId; mode: string | null } {
    return contextFor(this.doc, id, collection);
  }

  // ---------- usages and dependencies (FR-VAR-024, 025) ----------

  /** Layers and styles using a variable, directly or through aliases. */
  usages(variable: NodeId): { direct: { id: NodeId; field: string }[]; viaAlias: { id: NodeId; field: string; through: NodeId }[] } {
    const d = this.doc;
    const direct = variableUsers(d, new Set([variable])).map((u) => ({ id: u.id, field: u.field }));
    const dependents = aliasDependents(d, [variable]);
    const viaAlias = variableUsers(d, dependents).map((u) => ({ id: u.id, field: u.field, through: u.variable }));
    return { direct, viaAlias };
  }

  /** Whether a variable takes its value from others somewhere (an alias or an expression). */
  refersToOthers(variable: NodeId): boolean {
    return allValuesOf(this.doc, variable).some((x) => isAlias(x) || isExpression(x));
  }

  dependsOn(variable: NodeId): NodeId[] {
    return aliasChain(this.doc, variable);
  }

  dependents(variable: NodeId): NodeId[] {
    return [...aliasDependents(this.doc, [variable])];
  }

  /** Selects the layers of a usage list (on the first page that has any). */
  selectUsers(ids: readonly NodeId[]): void {
    const d = this.doc;
    const layers = ids.filter((id) => d.pageOf(id) !== null);
    if (layers.length === 0) {
      this.editor.toast(tr('Переменная не используется в слоях'));
      return;
    }
    const page = layers.some((id) => d.pageOf(id) === this.editor.pageId) ? this.editor.pageId : d.pageOf(layers[0]!)!;
    if (page !== this.editor.pageId) this.editor.setPage(page);
    this.editor.setSelection(layers.filter((id) => d.pageOf(id) === page));
    this.editor.zoomToSelection();
  }

  /**
   * Values of a variable in each mode of its collection, resolved (for previews);
   * `error` says why there is none (an expression's mistake). With `scope` an
   * extension: as seen there, `own` — whether the extension sets it itself.
   */
  valuesByMode(variable: NodeId, scope?: NodeId): { mode: string; value: VariableLiteral | undefined; raw: VariableValue | undefined; error?: string; own: boolean }[] {
    const d = this.doc;
    const collection = d.parent(variable)!;
    const ext = scope && isExtension(d, scope) ? scope : undefined;
    return d.get(collection, 'modes').map((m) => {
      const r = explainInMode(d, variable, m.id, ext);
      const raw = this.rawOf(variable, m.id, ext);
      return { mode: m.id, value: 'value' in r ? r.value : undefined, raw, ...('error' in r ? { error: r.error } : {}), own: ext ? overrideOf(d, ext, variable, m.id) !== undefined : true };
    });
  }

  /** Search by name, value and description; filters by type, usage and alias (FR-VAR-021). */
  search(collection: NodeId, query: string, filters: { type?: VariableType | null; used?: boolean | null; alias?: boolean | null } = {}): NodeId[] {
    const d = this.doc;
    const q = query.trim().toLowerCase();
    let used: Set<NodeId> | null = null;
    if (filters.used !== undefined && filters.used !== null) {
      // Used directly by any layer or style (any collection, so aliases from other collections count) …
      const direct = new Set(variableUsers(d, new Set(allVariables(d))).map((u) => u.variable));
      used = new Set(direct);
      // … or through an alias of a used variable.
      for (const v of direct) for (const dep of aliasChain(d, v)) used.add(dep);
    }
    const scope = isExtension(d, collection) ? collection : undefined;
    return this.variablesOf(collection).filter((v) => {
      if (filters.type && d.get(v, 'varType') !== filters.type) return false;
      if (used && filters.used !== used.has(v)) return false;
      const values = d.get(collection, 'modes').map((m) => this.rawOf(v, m.id, scope));
      if (filters.alias !== undefined && filters.alias !== null && filters.alias !== values.some((x) => isAlias(x) || isExpression(x))) return false;
      if (!q) return true;
      const text = [d.get(v, 'name'), d.get(v, 'description'), ...d.get(collection, 'modes').map((m) => this.formatValue(v, m.id, scope))].join(' ').toLowerCase();
      return text.includes(q);
    });
  }
}

export function parseColor(text: string): Color | null {
  const t = text.trim();
  const hex = hexToColor(t.startsWith('#') ? t : `#${t}`);
  if (hex) return hex;
  const m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*(?:[,/]\s*(\d+(?:\.\d+)?)(%?))?\s*\)$/i.exec(t);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
  return { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255, a: Math.max(0, Math.min(1, a)) };
}

export function formatLiteral(value: VariableLiteral): string {
  if (isColorValue(value)) return colorToHex(value, value.a < 1);
  if (typeof value === 'number') return String(Math.round(value * 1000) / 1000);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

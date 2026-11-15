// Песочница компонента (step 7, Dev Mode's component playground): a developer
// tries a component's variants and properties — State=Hover, a longer label,
// the icon hidden — and sees the picture and the code, while the file stays
// as it is. The playground is a copy of the document in memory with an editor
// of its own: switching a variant or a property is the same edit as in the
// file (instances sync, auto layout settles), only done to the copy.

import { fromSnapshot, toSnapshot, tr, type ComponentPropDef, type NodeId } from '#core';
import { componentSetOf, createInstance, instancePropertyValue, listComponents, parseVariantName, propertyDefs, variantAxes, wouldCreateCycle } from '#components';
import { layerCode, type CodeLang, type CodeOptions, DEFAULT_CODE_OPTIONS } from './dev-code.ts';
import { Editor } from './editor.ts';

export interface Playground {
  /** The copy of the file the playground edits. */
  editor: Editor;
  /** The instance being tried. */
  instance: NodeId;
  /** The component (or set) it shows, for the title. */
  title: string;
}

export interface AxisControl {
  name: string;
  values: string[];
  value: string;
}

export interface PropControl {
  def: ComponentPropDef;
  value: string | boolean | null;
  /** INSTANCE_SWAP: components it may show (preferred ones when the property has them). */
  options: { id: NodeId; name: string }[];
}

/** What can be tried with a layer: an instance, a component, a variant or a set; null — anything else. */
export function playgroundTarget(source: Editor, id: NodeId): NodeId | null {
  const doc = source.doc;
  if (!doc.store.isAlive(id)) return null;
  const type = doc.type(id);
  if (type === 'INSTANCE') {
    const main = doc.get(id, 'mainComponent');
    return typeof main === 'string' && doc.store.isAlive(main) ? id : null;
  }
  if (type === 'COMPONENT') return id;
  if (type === 'COMPONENT_SET') return doc.children(id).find((c) => doc.type(c) === 'COMPONENT') ?? null;
  return null;
}

/** Opens a playground for a layer of the source file; null — the layer is not a component or an instance. */
export function openPlayground(source: Editor, id: NodeId): Playground | null {
  const target = playgroundTarget(source, id);
  if (!target) return null;
  const doc = fromSnapshot(toSnapshot(source.doc));
  const editor = new Editor(doc, source.measurer);
  let instance = target;
  if (doc.type(target) === 'COMPONENT') {
    const page = doc.pageOf(target) ?? doc.pages()[0]!;
    // Far from everything on its page: nothing of the file overlaps it.
    instance = editor.commit(tr('Песочница'), (tx) => createInstance(doc, tx, target, page, { x: -100_000, y: -100_000 }));
  }
  const main = doc.get(instance, 'mainComponent') as NodeId;
  const set = componentSetOf(doc, main);
  const title = String(doc.get(set ?? main, 'name') ?? '');
  return { editor, instance, title };
}

/** Variant axes of the instance's set, with the current values. */
export function axisControls(pg: Playground): AxisControl[] {
  const doc = pg.editor.doc;
  const main = doc.get(pg.instance, 'mainComponent') as NodeId;
  const set = componentSetOf(doc, main);
  if (!set) return [];
  const current = parseVariantName(String(doc.get(main, 'name') ?? ''));
  return variantAxes(doc, set).map((a) => ({ name: a.name, values: a.values, value: current[a.name] ?? a.values[0] ?? '' }));
}

/** Text, on/off and swap properties of the instance, with the current values. */
export function propControls(pg: Playground): PropControl[] {
  const doc = pg.editor.doc;
  const main = doc.get(pg.instance, 'mainComponent') as NodeId;
  return propertyDefs(doc, main).map((def) => {
    let options: { id: NodeId; name: string }[] = [];
    if (def.type === 'INSTANCE_SWAP') {
      const preferred = (def.preferred ?? []).filter((c) => doc.store.isAlive(c) && doc.type(c) === 'COMPONENT');
      const pool = preferred.length ? preferred : listComponents(doc).map((c) => c.id);
      options = pool
        .filter((c) => !wouldCreateCycle(doc, c, pg.instance))
        .slice(0, 300)
        .map((c) => {
          const set = componentSetOf(doc, c);
          return { id: c, name: set ? `${doc.get(set, 'name')} / ${doc.get(c, 'name')}` : String(doc.get(c, 'name') ?? '') };
        });
      const value = instancePropertyValue(doc, pg.instance, def);
      if (typeof value === 'string' && doc.store.isAlive(value) && !options.some((o) => o.id === value)) options.unshift({ id: value, name: String(doc.get(value, 'name') ?? '') });
    }
    return { def, value: instancePropertyValue(doc, pg.instance, def), options };
  });
}

export function setAxis(pg: Playground, axis: string, value: string): void {
  pg.editor.switchVariant(pg.instance, axis, value);
}

export function setProp(pg: Playground, propId: string, value: string | boolean): void {
  pg.editor.setInstanceProperty(pg.instance, propId, value);
}

/** The instance's code as it is now in the playground (with everything inside). */
export function playgroundCode(pg: Playground, lang: CodeLang, o: CodeOptions = DEFAULT_CODE_OPTIONS): string {
  return layerCode(pg.editor.doc, pg.instance, lang, o, true);
}

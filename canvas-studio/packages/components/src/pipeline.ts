// What runs after every local edit, in order:
//  00. a layer set to fill cannot sit in a frame that hugs it (settleSizing);
//  0. style bindings: bound layers get the style's values, edited styles reach
//     their layers, directly edited values detach (styles.ts); directly edited
//     values bound to variables are unbound (variables.ts);
//  1. the user's changes to instance layers become overrides;
//  2. instances are synchronised with their components;
//  2b. variables are resolved for everything the edit may have affected;
//  2d. repeat groups rebuild the copies of their layers (repeat.ts);
//  3. groups refit their children;
//  2c. board objects place their parts (board.ts);
//  4. auto layout is recomputed for everything touched;
//  5. board connectors follow the layers they are attached to.
// Remote edits and undo/redo do not run it: their ops already contain the results.

import type { NodeId, PropKey, Transaction } from '#core';
import { applyLayout, fitGroups, settleSizing, type TextMeasurer } from '#layout';
import { syncBoard } from './board.ts';
import { syncRepeats } from './repeat.ts';
import { syncStyles } from './styles.ts';
import { resolveVariables, unbindEditedFields } from './variables.ts';
import { markOverrides, syncComponents } from './sync.ts';

export function processTransaction(tx: Transaction, measurer: TextMeasurer): void {
  const doc = tx.doc;
  if (tx.changes.isEmpty) return;
  settleSizing(doc, tx);
  const userChanges = new Map<NodeId, Set<PropKey>>();
  for (const [id, keys] of tx.changes.updated) userChanges.set(id, new Set(keys));
  // Unbinding first: a style whose bound value was typed over must lose that
  // binding before its values reach its layers.
  unbindEditedFields(doc, tx, userChanges);
  syncStyles(doc, tx, userChanges);
  const userTouched = tx.changes.touched();
  markOverrides(doc, tx, userChanges);
  syncComponents(doc, tx, userTouched);
  resolveVariables(doc, tx);
  syncBoard(doc, tx, userChanges, measurer, 'objects');
  syncRepeats(doc, tx, tx.changes.touched());
  fitGroups(doc, tx, tx.changes.touched());
  applyLayout(doc, tx, tx.changes.touched(), measurer);
  syncBoard(doc, tx, userChanges, measurer, 'connectors');
}

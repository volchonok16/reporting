// Approval (other editors, item 9; as in Filestage, Abstract): which frames
// and sections of the file are «На согласовании», «Утверждено» or «Нужны
// правки», kept on the server (packages/server/src/approvals.ts) and pushed
// to everyone in the file. An approved frame is compared with the version
// saved at the approval: once it differs — not counting moving the frame
// itself on the page — it shows «Изменено после утверждения».

import { deserialize, tr, type Document, type NodeId } from '#core';
import { approvals as api, versions, type ApprovalChange, type ApprovalInfo, type ApprovalStatus } from './cloud.ts';
import { compareLayer } from './compare-changes.ts';
import type { Editor } from './editor.ts';

export const APPROVAL_LABELS: Record<ApprovalStatus, string> = {
  REVIEW: 'На согласовании',
  APPROVED: 'Утверждено',
  CHANGES: 'Нужны правки',
};

export const APPROVAL_COLORS: Record<ApprovalStatus | 'EDITED', string> = {
  REVIEW: '#4f5bd5',
  APPROVED: '#14ae5c',
  CHANGES: '#e5484d',
  EDITED: '#e8890c',
};

/** Whether the layer changed since the version, apart from where the layer itself stands on the page. */
export function changedSince(before: Document, after: Document, root: NodeId): boolean {
  if (!after.store.isAlive(root)) return false;
  if (!before.store.isAlive(root)) return true;
  return compareLayer(before, after, root).some((c) => !(c.id === root && c.kind === 'changed' && !c.moved && c.props.every((p) => p.key === 'x' || p.key === 'y')));
}

export class Approvals {
  private readonly editor: Editor;
  private fileId: string | null = null;
  private readonly byNode = new Map<string, ApprovalInfo>();
  /** Approved frames that changed since their approval. */
  private readonly edited = new Set<string>();
  private readonly versionDocs = new Map<string, Promise<Document | null>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading = 0;
  /** Something to show changed: the canvas and the panel redraw. */
  onChange: () => void = () => {};

  constructor(editor: Editor) {
    this.editor = editor;
    editor.events.on('change', () => this.scheduleCheck());
  }

  get(id: NodeId): ApprovalInfo | undefined {
    return this.byNode.get(id);
  }

  /** «Изменено после утверждения». */
  isEdited(id: NodeId): boolean {
    return this.edited.has(id);
  }

  /** The label and colour for a frame's title on the canvas, if it has a status. */
  badge(id: NodeId): { label: string; color: string } | null {
    const a = this.byNode.get(id);
    if (!a) return null;
    if (a.status === 'APPROVED' && this.edited.has(id)) return { label: tr('Изменено после утверждения'), color: APPROVAL_COLORS.EDITED };
    return { label: tr(APPROVAL_LABELS[a.status]), color: APPROVAL_COLORS[a.status] };
  }

  /** The statuses of a file on the server; none for local files. */
  async load(fileId: string | null): Promise<void> {
    if (fileId !== this.fileId) {
      this.fileId = fileId;
      this.byNode.clear();
      this.edited.clear();
      this.versionDocs.clear();
      this.onChange();
    }
    if (!fileId) return;
    const ticket = ++this.loading;
    let list: ApprovalInfo[];
    try {
      list = await api.list(fileId);
    } catch {
      return;
    }
    if (ticket !== this.loading || fileId !== this.fileId) return;
    this.byNode.clear();
    for (const a of list) this.byNode.set(a.nodeId, a);
    await this.check();
    this.onChange();
  }

  /** A change from the server: ours (the answer to a request) or someone else's (live). */
  apply(change: ApprovalChange): void {
    if ('deleted' in change) {
      this.byNode.delete(change.nodeId);
      this.edited.delete(change.nodeId);
    } else {
      this.byNode.set(change.approval.nodeId, change.approval);
      this.edited.delete(change.approval.nodeId);
      if (change.approval.status === 'APPROVED') this.scheduleCheck(0);
    }
    this.onChange();
  }

  private scheduleCheck(delay = 600): void {
    if (![...this.byNode.values()].some((a) => a.status === 'APPROVED' && a.version)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check().then((changed) => changed && this.onChange());
    }, delay);
  }

  private versionDoc(version: string): Promise<Document | null> {
    let doc = this.versionDocs.get(version);
    if (!doc) {
      const fileId = this.fileId!;
      doc = versions.snapshot(fileId, version).then(deserialize, () => null);
      this.versionDocs.set(version, doc);
    }
    return doc;
  }

  /** Recomputes «Изменено после утверждения»; true — something changed. */
  private async check(): Promise<boolean> {
    let changed = false;
    for (const a of [...this.byNode.values()]) {
      let edited = false;
      if (a.status === 'APPROVED' && a.version && this.fileId) {
        const before = await this.versionDoc(a.version);
        edited = !!before && changedSince(before, this.editor.doc, a.nodeId);
      }
      if (edited !== this.edited.has(a.nodeId)) {
        changed = true;
        if (edited) this.edited.add(a.nodeId);
        else this.edited.delete(a.nodeId);
      }
    }
    return changed;
  }
}

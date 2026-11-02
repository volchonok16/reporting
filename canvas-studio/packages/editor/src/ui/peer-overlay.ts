// Collaborators on the canvas (live editing, part 2): each person's pointer
// with their name (or their cursor chat message) and a frame around what they
// selected, in their colour.
// Only people on the same page are shown. Drawn as a DOM layer over the
// canvas, positioned from world coordinates on every pan, zoom and change.

import type { Editor } from '../editor.ts';
import type { Peer, Presence } from '../live.ts';
import { h } from './dom.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function pointer(color: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 18 18');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M2 1.5l13 6.2-5.6 1.6-2.5 5.4z');
  path.setAttribute('fill', color);
  path.setAttribute('stroke', '#fff');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

export class PeerOverlay {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private peers = new Map<string, Peer>();
  private readonly presence = new Map<string, Presence>();
  private frame = 0;

  constructor(editor: Editor) {
    this.editor = editor;
    this.el = h('div', { class: 'peer-overlay', 'aria-hidden': 'true' });
    for (const event of ['viewport', 'change', 'page', 'view'] as const) editor.events.on(event, () => this.request());
  }

  setPeers(peers: Peer[]): void {
    this.peers = new Map(peers.map((p) => [p.id, p]));
    for (const id of [...this.presence.keys()]) if (!this.peers.has(id)) this.presence.delete(id);
    this.request();
  }

  setPresence(from: string, presence: Presence): void {
    this.presence.set(from, presence);
    this.request();
  }

  /** Last known presence of a person (to follow them at once). */
  presenceOf(id: string): Presence | undefined {
    return this.presence.get(id);
  }

  private request(): void {
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const editor = this.editor;
    const vp = editor.viewport;
    const nodes: HTMLElement[] = [];
    for (const [id, p] of this.presence) {
      const peer = this.peers.get(id);
      if (!peer || p.page !== editor.pageId) continue;
      for (const nodeId of p.selection) {
        if (!editor.doc.store.isAlive(nodeId) || editor.doc.pageOf(nodeId) !== editor.pageId) continue;
        const b = editor.scene.bounds(nodeId);
        const tl = vp.worldToScreen({ x: b.x, y: b.y });
        const br = vp.worldToScreen({ x: b.x + b.width, y: b.y + b.height });
        nodes.push(h('div', { class: 'peer-selection', style: { left: `${tl.x}px`, top: `${tl.y}px`, width: `${br.x - tl.x}px`, height: `${br.y - tl.y}px`, borderColor: peer.color } }));
      }
      if (p.cursor && editor.view.cursors) {
        const at = vp.worldToScreen(p.cursor);
        const label = p.chat
          ? h('span', { class: 'peer-name peer-chat', style: { background: peer.color } }, h('span', { class: 'peer-chat-name' }, peer.name), h('span', { class: 'peer-chat-text' }, p.chat))
          : h('span', { class: 'peer-name', style: { background: peer.color } }, peer.name);
        const cursor = h('div', { class: 'peer-cursor', style: { transform: `translate(${at.x}px, ${at.y}px)` } }, label);
        cursor.prepend(pointer(peer.color));
        nodes.push(cursor);
      }
    }
    this.el.replaceChildren(...nodes);
  }
}

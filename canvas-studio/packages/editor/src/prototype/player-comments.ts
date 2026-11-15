// Comments right in the prototype viewer (step 8, as comments in Figma's
// presentation view). «Комментарии» (C) on the viewer's bar: the prototype
// stops reacting, pins of the open discussions on the screen shown (and on
// its open overlays) appear, a click drops a new one on the layer under it —
// the same discussions as on the canvas, kept by the server, so they are seen
// in the file too and move with their layer. Pins follow scrolling and are
// hidden while screens change. C or Esc ends commenting.

import type { Comments } from '../ui/comments.ts';
import type { PrototypePlayer } from './player.ts';

/** Shows the discussions of `comments` over `player` until the returned function is called. */
export function connectComments(player: PrototypePlayer, comments: Comments): () => void {
  const layer = player.commentLayer;
  const count = () => player.setCommentCount(comments.openCount());
  comments.useSurface({
    overlay: layer,
    size: () => ({ width: layer.clientWidth, height: layer.clientHeight }),
    pointOf: (place) => player.commentPoint(place),
    placeAt: (p) => player.commentPlace(p),
    nodeName: (id) => player.layerName(id),
    pinsShown: () => player.commentMode,
    resolvedShown: () => false,
    onRender: count,
  });
  player.onDrawn = () => {
    comments.reflow();
    count();
  };
  player.onCommentMode = (on) => {
    if (!on) comments.close();
    else comments.refresh();
  };
  // A click with a discussion open closes it first, as a click beside a popover does.
  player.onCommentClick = (p) => (comments.busy ? comments.close() : comments.startAtPoint(p));
  return () => {
    player.onDrawn = undefined;
    player.onCommentMode = undefined;
    player.onCommentClick = undefined;
    comments.useSurface(null);
  };
}

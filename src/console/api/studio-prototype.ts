import type { Context, Hono } from 'hono';
import type { BoardPaths } from '../../board/store.js';
import { prototypeMap, readPrototypeFile, readSketch, setPrototypeLink, setPrototypeStart, type LinkTarget, type PrototypeMap } from '../../board/studio.js';
import { StudioNotFound, personEditing } from '../../board/studio-actions.js';
import { LinkBusy, linkProblem, linkWorking, startLinkJob } from '../../engine/studio-link.js';

/**
 * A sketch's prototype (US-54, AB-179.1), under /api/v1/studio/sketches/<id>/prototype:
 *
 *   GET                         the approved screens at their approved versions, each drawing with its buttons marked,
 *                               the links (working or broken, with a short warning), the start screen, and whether
 *                               Generate works now or what went wrong in the last one. It only reads (AB-127.1).
 *   PUT  …/prototype/link       { stamp, screen, button, to: "<screen>" | back: true | neither for no link }
 *   PUT  …/prototype/start      { stamp, screen }
 *   POST …/prototype/generate   { stamp }: the AI Designer links the screens in the background; 409 while it works.
 *   GET  …/prototype/generate   whether it still works, and what went wrong.
 *
 * Every change brings the sketch's stamp the page read (AB-129.1): an old one is 409 "Changed elsewhere, reload". A
 * change answers with the prototype as saved, with the sketch's new stamp. Nothing is added to the chat.
 */

type Run = (c: Context, fn: () => unknown) => Promise<Response>;
type Body = (c: Context) => Promise<Record<string, unknown>>;

function checkedStamp(stamp: unknown): string {
  if (typeof stamp !== 'string' || !stamp.trim()) throw new Error('Send the stamp of what you started from. Reload and try again.');
  return stamp;
}

/** The prototype as the board reads it. */
function prototypeRow(bp: BoardPaths, id: string, map?: PrototypeMap) {
  const sketch = readSketch(bp, id);
  if (!sketch) throw new StudioNotFound(`This project has no sketch "${id}".`);
  const m = map ?? prototypeMap(sketch, readPrototypeFile(bp, id));
  const inIt = new Set(m.screens.map((s) => s.id));
  return {
    sketch: { id: sketch.id, name: sketch.name, frames: sketch.frames, stamp: sketch.stamp },
    screens: m.screens,
    links: m.links,
    start: m.start,
    markedStart: m.markedStart,
    /** The sketch's screens that are not in the prototype, because they are not approved now. */
    left: sketch.screens.filter((s) => !inIt.has(s.id)).map((s) => ({ id: s.id, name: s.name })),
    working: linkWorking(bp, id),
    problem: linkProblem(bp, id),
  };
}

function targetOf(b: Record<string, unknown>): LinkTarget | null {
  if (b.back === true) return { back: true };
  if (b.to === undefined || b.to === null || b.to === '') return null;
  if (typeof b.to !== 'string') throw new Error('Pick a screen, Back or no link.');
  return { screen: b.to };
}

export function mountStudioPrototypeApi(app: Hono, bp: BoardPaths, h: { run: Run; body: Body }): void {
  const base = '/api/v1/studio/sketches/:id/prototype';
  app.get(base, (c) => h.run(c, () => prototypeRow(bp, c.req.param('id'))));
  app.put(`${base}/link`, async (c) => {
    const b = await h.body(c);
    return h.run(c, () => {
      const id = c.req.param('id');
      const saved = setPrototypeLink(bp, id, { screen: String(b.screen ?? ''), button: String(b.button ?? ''), to: targetOf(b) }, checkedStamp(b.stamp), personEditing(bp));
      return prototypeRow(bp, id, saved.map);
    });
  });
  app.put(`${base}/start`, async (c) => {
    const b = await h.body(c);
    return h.run(c, () => {
      const id = c.req.param('id');
      const saved = setPrototypeStart(bp, id, String(b.screen ?? ''), checkedStamp(b.stamp), personEditing(bp));
      return prototypeRow(bp, id, saved.map);
    });
  });
  app.post(`${base}/generate`, async (c) => {
    const b = await h.body(c);
    const id = c.req.param('id');
    try {
      if (!readSketch(bp, id)) throw new StudioNotFound(`This project has no sketch "${id}".`);
      const working = startLinkJob(bp, { sketch: id, stamp: checkedStamp(b.stamp), ...(personEditing(bp).by ? { for: personEditing(bp).by } : {}) });
      return c.json({ working });
    } catch (err) {
      if (err instanceof LinkBusy) return c.json({ error: err.message, busy: true }, 409);
      return h.run(c, () => {
        throw err;
      });
    }
  });
  app.get(`${base}/generate`, (c) => h.run(c, () => ({ working: linkWorking(bp, c.req.param('id')), problem: linkProblem(bp, c.req.param('id')) })));
}

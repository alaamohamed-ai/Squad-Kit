import fs from 'node:fs';
import path from 'node:path';
import { addActivity, ticketDir, updateTicket, type BoardPaths } from './store.js';
import { readSketch, readStudio, type Sketch, type SketchScreen } from './studio.js';
import { BoardActionError } from './actions/errors.js';
import type { Ticket } from './types.js';
import type { DesignProof, TicketDesign } from './ticket-designs-types.js';

export { designsOnDisk, designsRead, type DesignProof, type TicketDesign } from './ticket-designs-types.js';

/**
 * A ticket's designs from the Studio (US-55, AB-180.1): the approved screens the person picked for the squad to build.
 * The list lives in the ticket's own ticket.md, and each pick is a frozen copy of the screen's frames at the version
 * it was approved at, in the ticket's own folder (designs/<sketch>/<screen>/v<version>/<frame>.html). So a later
 * change in the Studio never changes what the ticket builds, and a teammate who gets the ticket through git gets the
 * same copy. Picking reads the Studio through its one store and writes nothing there (AB-127.1, AB-128.2).
 *
 * Picking is open until the build starts. Later ticket stories (the full Design tab, Open in Studio, the Tester's
 * picture comparison) read and add to this same list and copy.
 */

/** An approved screen the person may pick. */
export interface ApprovedScreen {
  sketch: string;
  screen: string;
  name: string;
  version: number;
  frames: string[];
  /** Frame id → its HTML at the approved version, for the small picture. */
  html: Record<string, string>;
  /** It is on this ticket already. */
  picked: boolean;
}

/** The stages after the build started: nothing is picked or removed then. */
const BUILT = new Set<string>(['implement', 'test', 'review', 'release', 'done']);

/** The build has started (or the ticket is past it): the designs are fixed for good. */
export function designsLocked(t: Pick<Ticket, 'stage' | 'sessions' | 'mergedAt' | 'archived'>): boolean {
  return Boolean(t.sessions?.build || t.mergedAt || t.archived) || BUILT.has(t.stage);
}

export const DESIGNS_LOCKED = 'The build has started, so the designs of this ticket stay as they are.';

/** "Booking / Form" (AB-136.1). */
export const designName = (sketch: string, screen: string) => `${sketch} / ${screen}`;

/** The version a screen was approved at, or null when it is not approved (or the version is not saved). */
function approvedVersion(s: SketchScreen): number | null {
  if (s.status !== 'approved') return null;
  const version = s.approved?.version ?? s.chosen;
  return version && s.variants.some((v) => v.version === version) ? version : null;
}

/** A screen's frames at a version, in the sketch's order, then any others. */
function framesAt(sketch: Sketch, s: SketchScreen, version: number): Record<string, string> {
  const frames = s.variants.find((v) => v.version === version)?.frames ?? {};
  const order = [...sketch.frames.filter((f) => f in frames), ...Object.keys(frames).filter((f) => !sketch.frames.includes(f)).sort()];
  return Object.fromEntries(order.map((f) => [f, frames[f]!]));
}

/**
 * Every approved screen of every sketch, as "Sketch / Screen", with its frames at the approved version. Screens that
 * are not approved are left out. Only reads the Studio (AB-127.1).
 */
export function approvedScreens(bp: BoardPaths, t?: Pick<Ticket, 'designs'>): ApprovedScreen[] {
  const out: ApprovedScreen[] = [];
  const sketches = [...readStudio(bp).sketches].sort((a, b) => a.name.localeCompare(b.name));
  for (const sketch of sketches) {
    for (const s of sketch.screens) {
      const version = approvedVersion(s);
      if (!version) continue;
      const html = framesAt(sketch, s, version);
      if (!Object.keys(html).length) continue;
      const picked = Boolean(t?.designs?.some((d) => d.sketch === sketch.id && d.screen === s.id));
      out.push({ sketch: sketch.id, screen: s.id, name: designName(sketch.name, s.name), version, frames: Object.keys(html), html, picked });
    }
  }
  return out;
}

/** Where a pick's frozen copy goes, inside the ticket's folder. */
export function designDir(bp: BoardPaths, id: string, sketch: string, screen: string, version: number): string {
  return path.join(ticketDir(bp, id), 'designs', sketch, screen, `v${version}`);
}

/** A frame's HTML file in a pick's frozen copy. */
export const designFrameFile = (d: Pick<TicketDesign, 'dir'>, frame: string) => path.join(d.dir, `${frame}.html`);

/** A frame's HTML from the frozen copy, or null when it is not there. */
export function readDesignFrame(d: Pick<TicketDesign, 'dir' | 'frames'>, frame: string): string | null {
  if (!d.frames.includes(frame)) return null;
  try {
    return fs.readFileSync(designFrameFile(d, frame), 'utf8');
  } catch {
    return null;
  }
}

/** The folders of the ticket's frozen copies, for the squad to read. */
export function designDirs(t: Pick<Ticket, 'designs'>): string[] {
  return (t.designs ?? []).map((d) => d.dir).filter((d) => fs.existsSync(d));
}

export interface DesignPick {
  sketch: string;
  screen: string;
}

/**
 * Adds approved screens to a ticket, each as a frozen copy of its frames at its approved version. Refused, with
 * nothing written, once the build has started, or for a screen that is not approved or is on the ticket already.
 */
export function addTicketDesigns(bp: BoardPaths, id: string, picks: DesignPick[], who: { by?: string } = {}): Ticket {
  if (!Array.isArray(picks) || !picks.length) throw new BoardActionError('Tick at least one approved screen.');
  return updateTicket(bp, id, (t) => {
    if (designsLocked(t)) throw new BoardActionError(DESIGNS_LOCKED);
    const found = picks.map((p) => {
      const sketch = typeof p?.sketch === 'string' ? readSketch(bp, p.sketch) : null;
      const s = sketch?.screens.find((x) => x.id === p.screen);
      if (!sketch || !s) throw new BoardActionError('That screen is not in the Studio any more. Reload and pick again.');
      const name = designName(sketch.name, s.name);
      const version = approvedVersion(s);
      if (!version) throw new BoardActionError(`${name} is not approved, so it cannot be built yet. Approve it in the Studio first.`);
      if (t.designs?.some((d) => d.sketch === sketch.id && d.screen === s.id)) throw new BoardActionError(`${name} is on this ticket already.`);
      return { sketch, s, name, version, html: framesAt(sketch, s, version) };
    });
    if (new Set(found.map((f) => `${f.sketch.id}/${f.s.id}`)).size !== found.length) throw new BoardActionError('A screen is ticked twice.');
    const at = new Date().toISOString();
    for (const f of found) {
      const dir = designDir(bp, t.id, f.sketch.id, f.s.id, f.version);
      fs.mkdirSync(dir, { recursive: true });
      for (const [frame, html] of Object.entries(f.html)) fs.writeFileSync(path.join(dir, `${frame}.html`), html);
      t.designs = [...(t.designs ?? []), { sketch: f.sketch.id, screen: f.s.id, name: f.name, version: f.version, frames: Object.keys(f.html), dir, addedAt: at, ...(who.by ? { addedBy: who.by } : {}) }];
      addActivity(t, 'you', `Added the design ${f.name} (version ${f.version})`);
    }
  });
}

/** Takes a picked screen off the ticket, with its frozen copy. Refused once the build has started. */
export function removeTicketDesign(bp: BoardPaths, id: string, pick: DesignPick): Ticket {
  return updateTicket(bp, id, (t) => {
    if (designsLocked(t)) throw new BoardActionError(DESIGNS_LOCKED);
    const d = t.designs?.find((x) => x.sketch === pick?.sketch && x.screen === pick?.screen);
    if (!d) throw new BoardActionError('That design is not on this ticket any more. Reload to see its designs.');
    t.designs = t.designs!.filter((x) => x !== d);
    if (!t.designs.length) delete t.designs;
    // Only a folder inside the ticket's own designs folder is removed.
    const root = path.join(ticketDir(bp, t.id), 'designs');
    if (path.relative(root, d.dir) && !path.relative(root, d.dir).startsWith('..')) fs.rmSync(d.dir, { recursive: true, force: true });
    addActivity(t, 'you', `Removed the design ${d.name}`);
  });
}

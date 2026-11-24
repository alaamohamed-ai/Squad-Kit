import fs from 'node:fs';
import path from 'node:path';
import { addActivity, readTicket } from '../../board/store.js';
import type { Ticket } from '../../board/types.js';
import { readDesignFrame, type DesignProof, type TicketDesign } from '../../board/ticket-designs.js';
import type { Browser } from '../../modules/browser/types.js';
import { BrowserSession, NO_BROWSER, ShotsUnavailable, SIZES, prepareShots, writeNew } from '../shots.js';
import { sealed } from '../studio-pdf.js';
import { designNamed, designShotsIn, designShotsProblem, shotSizeOf } from '../prompts/designs.js';
import { LimitReached } from '../usage-limit.js';
import { CapReached } from '../caps.js';
import { CutOff } from '../interrupt.js';
import { PassingTrouble } from './shared.js';
import type { BoardPaths } from '../../board/store.js';

/**
 * The design next to the build (US-55, AB-180.1): for each screen a ticket picked from the Studio and each of its
 * frames, the design picture beside the Tester's after picture of the page it built, at the same size. The Tester names
 * its pictures in its proof answer (designs), and is asked again for one that is missing; squad-kit draws each frame of
 * the ticket's frozen copy itself, with its own browser, scripts and the network off, at the frame's real size, so a
 * right-to-left screen reads as it does in the Studio. Both are saved with the proof, on the ticket's design list. A
 * ticket with no picked screen gets none of this.
 */

/** The design picture of one frame, in the proof folder: one per ticket, screen, version and frame. */
export function designPictureFile(id: string, d: Pick<TicketDesign, 'sketch' | 'screen' | 'version'>, frame: string): string {
  return `${id.toLowerCase()}-design-${d.sketch}-${d.screen}-v${d.version}-${frame}.png`;
}

/** The size a frame is drawn at: the same as the Tester's picture of it. */
const sizeOf = (frame: string) => SIZES[shotSizeOf(frame)];

/** The ticket's design pictures squad-kit has not drawn yet, as the pages to draw. */
function toDraw(proofDir: string, t: Ticket): { file: string; html: string; width: number; height: number }[] {
  return (t.designs ?? []).flatMap((d) =>
    d.frames.flatMap((f) => {
      const file = designPictureFile(t.id, d, f);
      const html = readDesignFrame(d, f);
      if (html === null || fs.existsSync(path.join(proofDir, file))) return [];
      return [{ file, html: sealed(html), ...sizeOf(f) }];
    }),
  );
}

/**
 * Draws every frame of the ticket's frozen copies that has no picture yet into the proof folder, with squad-kit's own
 * browser, sealed. Gives back the files drawn. Throws ShotsUnavailable when the browser cannot draw.
 */
export async function drawDesigns(proofDir: string, t: Ticket, o: { signal?: AbortSignal; browser?: () => Promise<Browser> } = {}): Promise<string[]> {
  const pages = toDraw(proofDir, t);
  if (!pages.length) return [];
  const session = o.browser ? null : new BrowserSession(o.signal ? { signal: o.signal } : {});
  try {
    if (!o.browser) await prepareShots(o.signal ? { signal: o.signal } : {});
    const browser = o.browser ? await o.browser() : await session!.browser();
    if (!browser.draw) throw new ShotsUnavailable(NO_BROWSER, 'This browser module cannot draw');
    const pngs = await browser.draw({ pages: pages.map(({ html, width, height }) => ({ html, width, height })) });
    fs.mkdirSync(proofDir, { recursive: true });
    return pages.flatMap((p, i) => (pngs[i] && writeNew(path.join(proofDir, p.file), pngs[i]!) ? [p.file] : []));
  } finally {
    await session?.close();
  }
}

/**
 * Keeps the design pictures the Tester named in one round on the ticket's design list. A new round (`fresh`) starts
 * every frame again, keeping only squad-kit's own design picture; a retake adds to what is there. A picture counts only
 * when squad-kit took it in this step, at the frame's size.
 */
export function keepDesignShots(t: Ticket, answer: unknown, taken: (file: string) => { page: string; size: string } | undefined, fresh: boolean): void {
  if (!t.designs?.length) return;
  const shots = designShotsIn(answer);
  for (const d of t.designs) {
    const before = new Map((d.proof ?? []).map((p) => [p.frame, p]));
    d.proof = d.frames.map((f): DesignProof => {
      const was = before.get(f);
      const row: DesignProof = fresh ? { frame: f, ...(was?.design ? { design: was.design } : {}) } : { frame: f, ...was };
      const shot = shots.find((s) => designNamed(t, s.screen) === d && s.frame === f && taken(s.file)?.size === shotSizeOf(f));
      if (shot) Object.assign(row, { after: shot.file, page: taken(shot.file)!.page });
      return row;
    });
  }
}

/** The screens and frames with no after picture yet, in plain words: "Booking / Form, Mobile". */
export function designsWithoutAfter(t: Pick<Ticket, 'designs'>): string[] {
  return (t.designs ?? []).flatMap((d) => d.frames.filter((f) => !d.proof?.find((p) => p.frame === f)?.after).map((f) => `${d.name}, ${f[0]!.toUpperCase()}${f.slice(1)}`));
}

/**
 * What the Tester's answer still lacks for the designs, for its check. A retake also counts the pictures kept from the
 * rounds before it; a new round counts only its own.
 */
export function designsAnswerProblem(t: Ticket, answer: unknown, taken: (file: string) => { size: string } | undefined, retake: boolean): string | null {
  if (!t.designs?.length) return null;
  if (!retake) return designShotsProblem(t, answer, (f) => taken(f)?.size);
  const left = { designs: t.designs.filter((d) => d.frames.some((f) => !d.proof?.find((p) => p.frame === f)?.after)) };
  if (!left.designs.length) return null;
  // Only what is still missing is asked for again.
  const still = { designs: left.designs.map((d) => ({ ...d, frames: d.frames.filter((f) => !d.proof?.find((p) => p.frame === f)?.after) })) };
  return designShotsProblem(still, answer, (f) => taken(f)?.size);
}

/** The Tester's ask for the design pictures still missing, for one more round. */
export function designsAgainLine(missing: string[]): string {
  return `The proof puts each design from the Studio next to a picture of the page built from it, and ${missing.length === 1 ? 'this one has' : 'these have'} no picture yet: ${missing.join('; ')}. Take one picture of each page at that frame's size, and name it in designs (screen, frame and file).`;
}

/** What the design proof needs of the squad. */
export interface DesignProofHost {
  bp: BoardPaths;
  stops: Map<string, AbortController>;
  update(id: string, change: (t: Ticket) => void): Ticket;
  log(level: 'info' | 'warn', text: string, ticket?: string): void;
  screens(id: string, when: 'after', beside: undefined, again: string[]): Promise<unknown>;
}

/**
 * The design next to the build, after the Tester's round of pictures: one more round for a screen and frame with no
 * picture of its page, then squad-kit draws the design pictures from the ticket's frozen copy. A picture that cannot be
 * taken or drawn leaves its place empty on the proof card, with one plain line on the ticket: it never stops the proof.
 */
export async function designProof(squad: DesignProofHost, id: string, o: { browser?: () => Promise<Browser> } = {}): Promise<void> {
  const t0 = readTicket(squad.bp, id);
  if (!t0?.designs?.length) return;
  const stop = squad.stops.get(id)?.signal;
  const fatal = (err: unknown) => err instanceof LimitReached || err instanceof CapReached || err instanceof CutOff || err instanceof PassingTrouble || Boolean(stop?.aborted);
  const missing = designsWithoutAfter(t0);
  if (missing.length) {
    squad.update(id, (x) => addActivity(x, 'tester', `No picture yet of the page built from ${missing.join('; ')}, so the Tester takes ${missing.length === 1 ? 'it' : 'them'}`));
    try {
      await squad.screens(id, 'after', undefined, [designsAgainLine(missing)]);
    } catch (err) {
      if (fatal(err)) throw err;
      squad.log('warn', `Could not take the pictures of the designs: ${(err as Error)?.message ?? String(err)}`, id);
    }
  }
  try {
    await drawDesigns(squad.bp.proofDir, readTicket(squad.bp, id)!, { ...(stop ? { signal: stop } : {}), ...(o.browser ? { browser: o.browser } : {}) });
  } catch (err) {
    if (fatal(err)) throw err;
    squad.log('warn', `Could not draw the design pictures: ${err instanceof ShotsUnavailable ? err.detail : ((err as Error)?.message ?? String(err))}`, id);
  }
  squad.update(id, (x) => {
    for (const d of x.designs ?? []) {
      const rows = new Map((d.proof ?? []).map((p) => [p.frame, p]));
      d.proof = d.frames.map((f) => {
        const row: DesignProof = { ...(rows.get(f) ?? {}), frame: f };
        const file = designPictureFile(x.id, d, f);
        if (fs.existsSync(path.join(squad.bp.proofDir, file))) row.design = file;
        else delete row.design;
        return row;
      });
    }
    const left = designsWithoutAfter(x);
    const drawn = (x.designs ?? []).every((d) => d.proof?.every((p) => p.design));
    addActivity(x, 'tester', left.length ? `The design sits next to the build, with no picture of the page yet for ${left.join('; ')}` : drawn ? `The design sits next to the build for ${x.designs!.length === 1 ? x.designs![0]!.name : `${x.designs!.length} screens`}` : 'The pictures of the pages are next to the designs, and squad-kit could not draw every design this time');
  });
}

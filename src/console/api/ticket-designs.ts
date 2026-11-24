import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths, requireTicket, type BoardPaths } from '../../board/store.js';
import { personEditing } from '../../board/studio-actions.js';
import { approvedScreens, designsLocked, readDesignFrame, removeTicketDesign, type DesignPick } from '../../board/ticket-designs.js';
import { answerDesign } from '../../board/design-ask.js';
import { act } from './act.js';

/**
 * A ticket's designs from the Studio (US-55, AB-180.1), under /api/v1/tickets/<id>/designs:
 *
 *   GET                         the picked screens, each with the HTML of its frames from the ticket's frozen copy (for
 *                               the small picture), and whether the build has started (no pick or remove then).
 *   GET    …/designs/approved   every approved screen of every sketch, as "Sketch / Screen", with its frames at the
 *                               approved version, and whether it is on the ticket already. It only reads the Studio.
 *   DELETE …/designs/<sketch>/<screen>
 *   POST   …/designs/answer     { picks: [{ sketch, screen }] } or { none: true }: the answer to the design step,
 *                               "Does this ticket follow a design from the Studio?" (board/design-ask.ts): the only
 *                               place screens are picked, each copied at its approved version into the ticket.
 *
 * Each change adds a line to the ticket's activity and answers with the designs as saved. Nothing in the Studio
 * changes (AB-127.1).
 */

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The ticket's designs as the board reads them. */
export function ticketDesignsRow(bp: BoardPaths, id: string) {
  const t = requireTicket(bp, id);
  return {
    locked: designsLocked(t),
    designs: (t.designs ?? []).map((d) => ({
      sketch: d.sketch,
      screen: d.screen,
      name: d.name,
      version: d.version,
      frames: d.frames,
      html: Object.fromEntries(d.frames.flatMap((f) => {
        const html = readDesignFrame(d, f);
        return html === null ? [] : [[f, html]];
      })),
      ...(d.proof?.length ? { proof: d.proof } : {}),
    })),
  };
}

export function mountTicketDesignsApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);
  const base = '/api/v1/tickets/:id/designs';
  app.get(base, (c) => act(c, () => ticketDesignsRow(bp, c.req.param('id'))));
  app.get(`${base}/approved`, (c) =>
    act(c, () => {
      const t = requireTicket(bp, c.req.param('id'));
      return { locked: designsLocked(t), screens: approvedScreens(bp, t) };
    }),
  );
  app.post(`${base}/answer`, async (c) => {
    const b = await body(c);
    return act(c, () => {
      const picks = Array.isArray(b.picks) ? (b.picks as DesignPick[]).map((p) => ({ sketch: String(p?.sketch ?? ''), screen: String(p?.screen ?? '') })) : [];
      answerDesign(bp, c.req.param('id'), b.none === true ? { none: true } : { picks }, personEditing(bp));
      return ticketDesignsRow(bp, c.req.param('id'));
    });
  });
  app.delete(`${base}/:sketch/:screen`, (c) =>
    act(c, () => {
      removeTicketDesign(bp, c.req.param('id'), { sketch: c.req.param('sketch'), screen: c.req.param('screen') });
      return ticketDesignsRow(bp, c.req.param('id'));
    }),
  );
}

import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import type { BoardPaths } from '../../board/store.js';
import type { SquadPaths } from '../../core/paths.js';
import { exportPlan, readSketch, type ExportPlan } from '../../board/studio.js';
import { StudioNotFound } from '../../board/studio-actions.js';
import { loadConfig } from '../../core/config.js';
import { writeLog } from '../../core/app-log.js';
import { ShotsUnavailable } from '../../engine/shots.js';
import { makeSketchPdf } from '../../engine/studio-pdf.js';

/**
 * Export sketch to PDF (US-46, AB-171.1): POST /api/v1/studio/sketches/<id>/export/pdf with
 * { screens: [ids], frames: [ids], allVariants: true | false } (false when left out). The answer is the PDF itself,
 * named "<sketch name>.pdf" in a way that works for Arabic names too. The server works out the pages from what is saved
 * (board/studio-export.ts) and squad-kit's own browser prints them in memory (engine/studio-pdf.ts): the PDF is never
 * saved on disk and no project file changes (AB-127.1). Nothing is added to the chat.
 *
 * Only one export per sketch runs at a time: a second one is refused with "Already making the PDF". A choice the plan
 * cannot make a file from is 400 with its words, a missing sketch 404, and a browser that cannot be set up 503 with
 * the person's words. Later exports (PNG, JPG, SVG, HTML) get a route file of their own next to this one.
 */

type Run = (c: Context, fn: () => unknown) => Promise<Response>;
type Body = (c: Context) => Promise<Record<string, unknown>>;

export const ALREADY_MAKING = 'Already making the PDF';

/** The sketches a PDF is being made for now, per project. */
const making = new Set<string>();

/** A file name with every character a file name cannot hold swapped for "-": "Booking / v2" → "Booking - v2". */
export function safeFileName(name: string, ext: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return `${clean || 'Sketch'}.${ext}`;
}

/** The download header: plain letters as they are, any other name (Arabic) in UTF-8, with a plain one for old readers. */
export function attachmentOf(file: string): string {
  if (/^[\x20-\x7e]+$/.test(file)) return `attachment; filename="${file.replace(/"/g, '')}"`;
  const plain = file.replace(/[^\x20-\x7e]/g, '').replace(/"/g, '').trim();
  const fallback = /^[^.]*[A-Za-z0-9]/.test(plain) ? plain : `sketch${path.extname(file)}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file)}`;
}

/** The project's name for the cover: its settings say it, or else its folder's name. */
function projectName(paths: SquadPaths): string {
  try {
    if (fs.existsSync(paths.configFile)) {
      const name = loadConfig(paths.configFile).project?.name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  } catch {
    // A settings file that cannot be read: the folder's name.
  }
  return path.basename(paths.root);
}

export function mountStudioExportApi(app: Hono, paths: SquadPaths, bp: BoardPaths, h: { run: Run; body: Body }): void {
  app.post('/api/v1/studio/sketches/:id/export/pdf', async (c) => {
    const id = c.req.param('id');
    const key = `${bp.root}\u0000${id}`;
    if (making.has(key)) return c.json({ error: ALREADY_MAKING, busy: true }, 409);
    making.add(key);
    try {
      const b = await h.body(c);
      let plan: ExportPlan;
      try {
        const sketch = readSketch(bp, id);
        if (!sketch) throw new StudioNotFound(`This project has no sketch "${id}".`);
        plan = exportPlan(sketch, { screens: b.screens as string[], frames: b.frames as string[], allVariants: b.allVariants === true });
      } catch (err) {
        return h.run(c, () => {
          throw err;
        });
      }
      let pdf: Buffer;
      try {
        pdf = await makeSketchPdf(plan, { project: projectName(paths), signal: c.req.raw.signal });
      } catch (err) {
        if (err instanceof ShotsUnavailable) {
          writeLog({ level: 'warn', text: `Export sketch to PDF: ${err.detail}` });
          return c.json({ error: err.message, noBrowser: true }, 503);
        }
        return h.run(c, () => {
          throw err;
        });
      }
      return new Response(new Uint8Array(pdf), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': attachmentOf(safeFileName(plan.sketch.name, 'pdf')),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } finally {
      making.delete(key);
    }
  });
}

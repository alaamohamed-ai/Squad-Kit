import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import { boardPaths } from '../../board/store.js';
import { StudioChangedElsewhere, StudioInUse, StudioNameTaken, readStudio, type DesignSystem, type Sketch } from '../../board/studio.js';
import {
  StudioNotFound,
  addScreen,
  changeDesignSystem,
  changeScreen,
  changeSketch,
  createDesignSystem,
  createSketch,
  deleteDesignSystem,
  deleteScreen,
  deleteSketch,
  designSystemList,
  duplicateSketch,
  getDesignSystem,
  getSketch,
  sketchCover,
  sketchList,
  type DesignSystemView,
  type SketchCard,
  type SketchView,
} from '../../board/studio-actions.js';
import { sketchChat, sketchChatPicture, startSketch } from '../../board/studio-start.js';
import { appPictureOption, takeAppPicture } from '../../engine/studio-app-picture.js';
import { ChatBusy } from '../../engine/studio-chat-runs.js';
import { act } from './act.js';
import { mountStudioChatApi } from './studio-chat.js';

/**
 * The Studio API (US-04, AB-129), under /api/v1/studio; the server serves it for each project at
 * /p/<id>/api/v1/studio behind the board's token check. Each route only reads the request, calls the shared Studio
 * action (board/studio-actions.ts, which the `squad studio` commands call too) and sends back its answer.
 *
 * GET /api/v1/studio is what the project's Studio holds, as this computer's squad-kit reads it from `.squad/studio/`:
 * every design system and sketch with its change stamp, versions, screens, variants and chosen variant, and the one
 * default design system.
 *
 * Every change and delete sends the `stamp` it started from (AB-129.1). A stale one comes back as 409 with "Changed
 * elsewhere, reload"; a design system that sketches follow comes back as 409 with those sketches, and a sketch name
 * another sketch uses (AB-138.1) as 409 with "A sketch called … already exists. Pick another name." A missing item is
 * 404, and any other refusal 400 with its words. Reading never writes a file and never makes a folder, so opening the
 * Studio writes nothing (AB-127.1). Lists name the HTML files a version has; reading one item also sends their HTML.
 */

function designSystemRow(ds: DesignSystem, isDefault: boolean) {
  return {
    id: ds.id,
    name: ds.name,
    /** The project's one default, worked out on read (AB-158.1): only one row is ever true. */
    isDefault,
    /** What its own system.yaml says; two can be marked after a merge. */
    markedDefault: ds.markedDefault,
    version: ds.version,
    madeAt: ds.madeAt,
    stamp: ds.stamp,
    versions: ds.versions.map((v) => ({ version: v.version, tokens: v.tokens, components: Object.keys(v.components) })),
  };
}

function sketchRow(s: Sketch | SketchView) {
  return {
    id: s.id,
    name: s.name,
    designSystem: s.designSystem,
    frames: s.frames,
    /** The newest mark on its files (AB-131.1): when, by whom, and for whom when the AI Designer did it. */
    lastEdit: s.lastEdit,
    stamp: s.stamp,
    screens: s.screens.map((sc) => ({
      id: sc.id,
      name: sc.name,
      order: sc.order,
      status: sc.status,
      chosen: sc.chosen,
      variants: sc.variants.map((v) => ({ version: v.version, frames: Object.keys(v.frames), madeAt: v.madeAt, ...(v.madeBy ? { madeBy: v.madeBy } : {}), ...(v.note ? { note: v.note } : {}) })),
    })),
  };
}

/** One card on the Sketches home (US-06): the list's row, with what its card shows. */
function sketchCardRow(s: SketchCard) {
  return { ...sketchRow(s), card: s.card };
}

/** One sketch read on its own: the list's row, with each variant's HTML by frame. */
function sketchRead(s: SketchView) {
  const row = sketchRow(s);
  return {
    ...row,
    screens: row.screens.map((sc, i) => ({ ...sc, variants: sc.variants.map((v, j) => ({ ...v, html: s.screens[i]!.variants[j]!.frames })) })),
  };
}

/** One design system read on its own: the list's row, with each version's components' HTML. */
function designSystemRead(ds: DesignSystemView) {
  const row = designSystemRow(ds, ds.isDefault);
  return { ...row, versions: row.versions.map((v, i) => ({ ...v, html: ds.versions[i]!.components })) };
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = (await c.req.json()) as unknown;
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The stamp a delete brings, in the address (?stamp=…) or in its body. */
async function deleteStamp(c: Context): Promise<unknown> {
  return c.req.query('stamp') ?? (await body(c)).stamp;
}

/** Runs one Studio action: the clashes come back as 409 and a missing item as 404; any other refusal as act() says. */
async function run(c: Context, fn: () => unknown) {
  try {
    return c.json((await fn()) as object);
  } catch (err) {
    if (err instanceof StudioChangedElsewhere) return c.json({ error: err.message, changedElsewhere: true }, 409);
    if (err instanceof StudioInUse) return c.json({ error: err.message, followedBy: err.sketches }, 409);
    if (err instanceof StudioNameTaken) return c.json({ error: err.message, nameTaken: { id: err.sketch, name: err.taken } }, 409);
    if (err instanceof StudioNotFound) return c.json({ error: err.message }, 404);
    if (err instanceof ChatBusy) return c.json({ error: err.message, busy: true }, 409);
    return act(c, () => {
      throw err;
    });
  }
}

export function mountStudioApi(app: Hono, opts: { paths: SquadPaths }): void {
  const bp = boardPaths(opts.paths.squadDir);

  // Everything at once, with the files that could not be read.
  app.get('/api/v1/studio', (c) =>
    act(c, () => {
      const studio = readStudio(bp);
      return {
        designSystems: studio.designSystems.map((ds) => designSystemRow(ds, ds.id === studio.defaultDesignSystem)),
        defaultDesignSystem: studio.defaultDesignSystem,
        sketches: studio.sketches.map(sketchRow),
        ...(studio.broken.length ? { broken: studio.broken } : {}),
      };
    }),
  );

  /* ── Design systems ── */
  // The Design systems tab's cards (US-33): the default first, each with its colours and how many sketches follow it,
  // and the design system a new sketch starts with.
  app.get('/api/v1/studio/design-systems', (c) =>
    run(c, () => {
      const list = designSystemList(bp);
      return { designSystems: list.designSystems.map((ds) => ({ ...designSystemRow(ds, ds.isDefault), colors: ds.colors, sketches: ds.sketches })), default: list.default };
    }),
  );
  app.get('/api/v1/studio/design-systems/:id', (c) => run(c, () => designSystemRead(getDesignSystem(bp, c.req.param('id')))));
  app.post('/api/v1/studio/design-systems', async (c) => {
    const b = await body(c);
    return run(c, () => designSystemRead(createDesignSystem(bp, b as never)));
  });
  app.patch('/api/v1/studio/design-systems/:id', async (c) => {
    const { stamp, ...change } = await body(c);
    return run(c, () => designSystemRead(changeDesignSystem(bp, c.req.param('id'), change, stamp)));
  });
  app.delete('/api/v1/studio/design-systems/:id', async (c) => {
    const stamp = await deleteStamp(c);
    return run(c, () => deleteDesignSystem(bp, c.req.param('id'), stamp));
  });

  /* ── Sketches ── */
  // The Sketches home's cards (US-06, AB-131), newest edit first, then by name.
  app.get('/api/v1/studio/sketches', (c) => run(c, () => ({ sketches: sketchList(bp).map(sketchCardRow) })));
  app.get('/api/v1/studio/sketches/:id', (c) => run(c, () => sketchRead(getSketch(bp, c.req.param('id')))));
  app.post('/api/v1/studio/sketches', async (c) => {
    const b = await body(c);
    return run(c, () => sketchRead(createSketch(bp, b as never)));
  });
  // The start page's Send (US-05, AB-130): makes the sketch from the first message, which is kept, with its pictures,
  // in the sketch's chat on this computer only. Nothing calls the AI Designer yet.
  app.post('/api/v1/studio/sketches/start', async (c) => {
    const b = await body(c);
    return run(c, () => startSketch(bp, b as never));
  });
  // A sketch's chat for its workspace, each picture as an address the page can show.
  app.get('/api/v1/studio/sketches/:id/chat', (c) =>
    run(c, () => {
      const id = c.req.param('id');
      const chat = sketchChat(bp, id);
      return { messages: chat.messages.map((m) => ({ ...m, pictures: (m.pictures ?? []).map((f) => `/api/v1/studio/sketches/${encodeURIComponent(id)}/chat/pictures/${encodeURIComponent(f)}`) })) };
    }),
  );
  // A card's thumbnail (US-06): the HTML of the first screen's chosen drawing, desktop and mobile as it has them. The
  // board draws it in a sealed frame with no scripts and no network. It only reads.
  app.get('/api/v1/studio/sketches/:id/cover', (c) => run(c, () => sketchCover(bp, c.req.param('id'))));
  app.get('/api/v1/studio/sketches/:id/chat/pictures/:file', (c) => {
    let picture: ReturnType<typeof sketchChatPicture> = null;
    try {
      picture = sketchChatPicture(bp, c.req.param('id'), c.req.param('file'));
    } catch {
      picture = null;
    }
    if (!picture) return c.json({ error: 'This picture is not here.' }, 404);
    return c.body(new Uint8Array(picture.bytes), 200, { 'content-type': picture.type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  });
  app.patch('/api/v1/studio/sketches/:id', async (c) => {
    const { stamp, ...change } = await body(c);
    return run(c, () => sketchRead(changeSketch(bp, c.req.param('id'), change, stamp)));
  });
  // Delete answers with the sketch's name and how many screens went with it (US-13).
  app.delete('/api/v1/studio/sketches/:id', async (c) => {
    const stamp = await deleteStamp(c);
    return run(c, () => deleteSketch(bp, c.req.param('id'), stamp));
  });
  // The card menu's Duplicate (US-13, AB-138): brings the source's stamp, answers with the copy.
  app.post('/api/v1/studio/sketches/:id/duplicate', async (c) => {
    const { stamp } = await body(c);
    return run(c, () => sketchRead(duplicateSketch(bp, c.req.param('id'), stamp)));
  });

  /* ── "A screen from your app" on the start page (US-05, AB-130) ── */
  // Whether it can be used, and why not: it starts nothing and writes no file.
  app.get('/api/v1/studio/app-picture', (c) => act(c, () => appPictureOption(bp)));
  // One picture of the running app (started first when it is not), made in a temporary folder that is deleted again.
  // The browser keeps it with the message until Send (AB-130.1).
  app.post('/api/v1/studio/app-picture', (c) =>
    act(c, async () => {
      const shot = await takeAppPicture(bp, { signal: c.req.raw.signal });
      return { picture: { name: `${shot.app}.png`, type: 'image/png', data: `data:image/png;base64,${shot.png.toString('base64')}` }, app: shot.app, page: shot.page };
    }),
  );

  /* ── Screens in a sketch: each brings the sketch's stamp ── */
  app.post('/api/v1/studio/sketches/:id/screens', async (c) => {
    const { stamp, ...input } = await body(c);
    return run(c, () => sketchRead(addScreen(bp, c.req.param('id'), input as never, stamp)));
  });
  app.patch('/api/v1/studio/sketches/:id/screens/:screen', async (c) => {
    const { stamp, ...change } = await body(c);
    return run(c, () => sketchRead(changeScreen(bp, c.req.param('id'), c.req.param('screen'), change, stamp)));
  });
  app.delete('/api/v1/studio/sketches/:id/screens/:screen', async (c) => {
    const stamp = await deleteStamp(c);
    return run(c, () => sketchRead(deleteScreen(bp, c.req.param('id'), c.req.param('screen'), stamp)));
  });

  /* ── The chat with the AI Designer, for sketches and design systems (US-52, AB-177) ── */
  mountStudioChatApi(app, bp, { run, body });
}

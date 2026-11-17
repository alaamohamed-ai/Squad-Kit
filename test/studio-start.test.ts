import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { BoardPaths } from '../src/board/store.js';

/**
 * US-05 The Studio's start page (AB-130), through the running board. Send makes the sketch in the project and keeps the
 * first message and its pictures only in this computer's chat folder for it (AB-130.1). "A screen from your app" says
 * why it cannot be used, starts nothing and leaves no file behind. No agent ever starts here.
 */

vi.mock('../src/engine/live.js', async (orig) => {
  const actual = await orig<typeof import('../src/engine/live.js')>();
  class QuietSquad {
    start() {
      return () => undefined;
    }
    ticketsRunning() {
      return 0;
    }
  }
  return { ...actual, LiveSquad: QuietSquad };
});
vi.mock('../src/planner/runtimes/auth-probe.js', async (orig) => ({
  ...(await orig<typeof import('../src/planner/runtimes/auth-probe.js')>()),
  probeClaudeAuth: async () => ({ ok: true }),
}));

const { buildPaths } = await import('../src/core/paths.js');
const { boardPaths } = await import('../src/board/store.js');
const { startConsoleServer } = await import('../src/console/server.js');
const actions = await import('../src/board/studio-actions.js');
const start = await import('../src/board/studio-start.js');
const { chatFile, chatPictureFile } = await import('../src/board/studio-paths.js');
const { NO_APP } = await import('../src/engine/studio-app-picture.js');

const TOKEN = 'd'.repeat(64);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let tmp: string;
let project: string;
let bp: BoardPaths;
let server: Awaited<ReturnType<typeof startConsoleServer>>;
let api: string;

const call = async <T = Record<string, unknown>>(method: string, p: string, body?: unknown) => {
  const res = await fetch(`${api}${p}`, { method, headers: auth, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: (await res.json()) as T };
};

/** A tiny PNG and a tiny JPEG, as the browser sends them. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a picture')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a photo')]);
const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`;

/** Every file under a folder, relative to it. */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-start-'));
  project = path.join(tmp, 'clinic');
  const paths = buildPaths(project);
  fs.mkdirSync(paths.squadDir, { recursive: true });
  fs.writeFileSync(paths.configFile, yaml.dump({ version: 1, project: { name: 'clinic', primaryLanguage: 'typescript' }, tracker: { type: 'none' }, agents: [] }));
  bp = boardPaths(paths.squadDir);
  server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
  api = `http://127.0.0.1:${server.port}/p/${encodeURIComponent(bp.projectId)}/api/v1/studio`;
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(bp.studioDir, { recursive: true, force: true });
  fs.rmSync(bp.studioLocalDir, { recursive: true, force: true });
});

describe('POST /api/v1/studio/sketches/start', () => {
  it('done when 3: makes the sketch in the project, with no design system when there is none, and keeps the message only on this computer', async () => {
    const before = filesIn(project);
    const r = await call<{ id: string; name: string }>('POST', '/sketches/start', { message: 'A page where patients book a visit with their doctor' });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ id: 'a-page-where-patients-book', name: 'A page where patients book' });

    // The project gains the sketch's own file and nothing else: no message, no picture.
    const added = filesIn(project).filter((f) => !before.includes(f));
    expect(added).toEqual(['.squad/studio/sketches/a-page-where-patients-book/sketch.yaml']);
    expect(actions.getSketch(bp, r.data.id)).toMatchObject({ name: 'A page where patients book', designSystem: null, frames: ['desktop'], screens: [] });

    // The message is in the sketch's chat in this computer's folder for the project, outside the project.
    const chat = JSON.parse(fs.readFileSync(chatFile(bp, r.data.id, 'main'), 'utf8'));
    expect(chat.messages).toEqual([{ role: 'person', text: 'A page where patients book a visit with their doctor', at: expect.any(String) }]);
    expect(path.relative(project, bp.studioLocalDir).startsWith('..')).toBe(true);

    // The list now has it, so the Sketches tab shows the list instead of the start page.
    const list = await call<{ sketches: { id: string }[] }>('GET', '/sketches');
    expect(list.data.sketches.map((s) => s.id)).toEqual(['a-page-where-patients-book']);
  });

  it('follows the Default design system, at its current version', async () => {
    actions.createDesignSystem(bp, { name: 'Patient app' });
    actions.createDesignSystem(bp, { name: 'Admin' });
    const r = await call<{ id: string }>('POST', '/sketches/start', { message: 'A login page in Arabic and English' });
    expect(r.status).toBe(200);
    expect(actions.getSketch(bp, r.data.id).designSystem).toEqual({ id: 'patient-app', version: 1, name: 'Patient app' });
  });

  it('keeps the pictures with the chat on this computer, and the workspace reads them back', async () => {
    const r = await call<{ id: string }>('POST', '/sketches/start', {
      message: 'Like this, but calmer',
      pictures: [
        { name: 'old.png', type: 'image/png', data: dataUrl('image/png', PNG) },
        { name: 'photo.jpg', type: 'image/jpeg', data: dataUrl('image/jpeg', JPEG) },
      ],
    });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(chatPictureFile(bp, r.data.id, 'm1-1.png'))).toEqual(PNG);
    expect(fs.readFileSync(chatPictureFile(bp, r.data.id, 'm1-2.jpg'))).toEqual(JPEG);
    expect(filesIn(bp.studioDir)).toEqual([`sketches/${r.data.id}/sketch.yaml`]);
    expect(filesIn(project).filter((f) => /\.(png|jpe?g|webp)$/.test(f))).toEqual([]);

    const chat = await call<{ messages: { role: string; text: string; pictures: string[] }[] }>('GET', `/sketches/${r.data.id}/chat`);
    expect(chat.data.messages).toEqual([
      {
        role: 'person',
        text: 'Like this, but calmer',
        at: expect.any(String),
        pictures: [`/api/v1/studio/sketches/${r.data.id}/chat/pictures/m1-1.png`, `/api/v1/studio/sketches/${r.data.id}/chat/pictures/m1-2.jpg`],
      },
    ]);
    const pic = await fetch(`${api}/sketches/${r.data.id}/chat/pictures/m1-1.png?t=${TOKEN}`);
    expect(pic.status).toBe(200);
    expect(pic.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await pic.arrayBuffer())).toEqual(PNG);
    expect((await fetch(`${api}/sketches/${r.data.id}/chat/pictures/..%2F..%2Fmain.json?t=${TOKEN}`)).status).toBe(404);
    expect((await fetch(`${api}/sketches/${r.data.id}/chat/pictures/m1-9.png?t=${TOKEN}`)).status).toBe(404);
  });

  it('gives the next free id when the name is taken', async () => {
    const one = await call<{ id: string }>('POST', '/sketches/start', { message: 'A profile page for patients' });
    const two = await call<{ id: string; name: string }>('POST', '/sketches/start', { message: 'A profile page for patients.' });
    expect([one.data.id, two.data.id]).toEqual(['a-profile-page-for-patients', 'a-profile-page-for-patients-2']);
    // One name per project (AB-138.1): the second sketch gets the next free name too.
    expect(two.data.name).toBe('A profile page for patients 2');
  });

  it('refuses an empty message, or a picture that is not one, and writes nothing', async () => {
    for (const body of [{ message: '' }, { message: '   ' }, {}, { message: 42 }]) {
      const r = await call('POST', '/sketches/start', body);
      expect(r.status).toBe(400);
      expect(r.data.error).toBe('Write what you want to design first.');
    }
    const fake = await call('POST', '/sketches/start', { message: 'Hi', pictures: [{ name: 'x.png', type: 'image/png', data: dataUrl('image/png', Buffer.from('<svg/>')) }] });
    expect(fake.status).toBe(400);
    expect(fake.data.error).toBe('Picture 1 is not a PNG, JPEG or WebP picture.');
    const many = await call('POST', '/sketches/start', { message: 'Hi', pictures: Array.from({ length: 5 }, () => ({ data: dataUrl('image/png', PNG) })) });
    expect(many.data.error).toBe('Add at most 4 pictures to one message.');
    expect(fs.existsSync(bp.studioDir)).toBe(false);
    expect(fs.existsSync(bp.studioLocalDir)).toBe(false);
  });
});

describe('the sketch name', () => {
  it('comes from the first words of the message, on one line', () => {
    expect(start.sketchNameFrom('A login page in Arabic and English')).toBe('A login page in Arabic');
    expect(start.sketchNameFrom('  Checkout.  ')).toBe('Checkout');
    expect(start.sketchNameFrom('صفحة دخول بالعربية')).toBe('صفحة دخول بالعربية');
    expect(start.sketchNameFrom('word\nnext line')).toBe('word next line');
  });
});

describe('/api/v1/studio/app-picture', () => {
  it('done when 4: in a project with no app, says why, starts nothing and leaves no file behind', async () => {
    const temps = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('squad-studio-app-'));
    const tempsBefore = temps();
    const before = filesIn(project);

    const option = await call('GET', '/app-picture');
    expect(option.status).toBe(200);
    expect(option.data).toEqual({ ok: false, why: NO_APP });

    const took = await call('POST', '/app-picture');
    expect(took.status).toBe(400);
    expect(took.data.error).toBe(NO_APP);

    expect(filesIn(project)).toEqual(before);
    expect(fs.existsSync(bp.studioLocalDir)).toBe(false);
    expect(temps()).toEqual(tempsBefore);
  });
});

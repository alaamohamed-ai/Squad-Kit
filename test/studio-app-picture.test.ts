import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardMeta } from '../src/board/types.js';

/**
 * "A screen from your app" on the Studio's start page (US-05, AB-130): the option says why it cannot be used, without
 * starting anything; a picture starts the app first when it is not running, is made in a temporary folder and comes
 * back as bytes, and the folder is gone afterwards (AB-130.1). The app runner and the browser are stand-ins here.
 */

let meta: BoardMeta;
let up = false;
const runner = {
  state: 'not-running' as string,
  started: 0,
  async statusOf() {
    return { state: this.state, up: this.state === 'running', address: this.state === 'running' ? 'http://localhost:3999' : undefined };
  },
  start() {
    this.started++;
    this.state = 'starting';
  },
  async settled() {
    if (this.state === 'starting') this.state = 'running';
    return this.statusOf();
  },
};

vi.mock('../src/board/store.js', async (orig) => ({
  ...(await orig<typeof import('../src/board/store.js')>()),
  boardExists: () => true,
  readMeta: () => meta,
}));
vi.mock('../src/board/apps.js', async (orig) => ({
  ...(await orig<typeof import('../src/board/apps.js')>()),
  isUp: async () => up,
}));
vi.mock('../src/engine/run-app.js', async (orig) => ({
  ...(await orig<typeof import('../src/engine/run-app.js')>()),
  appRunner: () => runner,
}));

const P = await import('../src/engine/studio-app-picture.js');
const bp = { root: '/nowhere' } as never;
const withCommands = (commands: Record<string, string>, extra: Partial<BoardMeta> = {}) => ({ project: 'Mawid', engine: 'live', commands, git: { base: 'main', remote: '' }, ...extra }) as BoardMeta;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeEach(() => {
  up = false;
  runner.state = 'not-running';
  runner.started = 0;
});

describe('whether "A screen from your app" can be used', () => {
  it('done when 4: is greyed out with the reason when the project has no app to start', async () => {
    meta = withCommands({}, { engine: 'demo' });
    expect(await P.appPictureOption(bp)).toEqual({ ok: false, why: 'This project has no app to take a picture of yet.' });
    // A live project that knows nothing of its app yet.
    meta = withCommands({});
    expect(await P.appPictureOption(bp)).toEqual({ ok: false, why: P.NO_APP });
    meta = withCommands({ test: 'flutter test' });
    expect(await P.appPictureOption(bp)).toEqual({ ok: false, why: P.PHONE_APP });
    meta = withCommands({ start: 'npm run dev' });
    expect(await P.appPictureOption(bp)).toEqual({ ok: false, why: P.NO_ADDRESS });
    expect(runner.started).toBe(0);
  });

  it('can be used for a web app squad-kit can start, or one that answers already', async () => {
    meta = withCommands({ start: 'npm run dev', url: 'http://localhost:3999' });
    expect(await P.appPictureOption(bp)).toEqual({ ok: true, app: 'Mawid' });
    meta = withCommands({ url: 'http://localhost:3999' });
    expect((await P.appPictureOption(bp)).ok).toBe(false);
    up = true;
    expect(await P.appPictureOption(bp)).toEqual({ ok: true, app: 'Mawid' });
    expect(runner.started).toBe(0);
  });
});

describe('taking the picture', () => {
  const temps = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('squad-studio-app-'));

  it('done when 4: starts the app when it is not running, takes one picture in a temporary folder and deletes it', async () => {
    meta = withCommands({ start: 'npm run dev', url: 'http://localhost:3999' });
    const before = temps();
    let at = '';
    const take = vi.fn(async (url: string, file: string) => {
      at = file;
      expect(path.dirname(file).startsWith(fs.realpathSync(os.tmpdir())) || path.dirname(file).startsWith(os.tmpdir())).toBe(true);
      fs.writeFileSync(file, PNG);
      return { page: '/' };
    });
    const shot = await P.takeAppPicture(bp, { take });
    expect(runner.started).toBe(1);
    expect(take).toHaveBeenCalledWith('http://localhost:3999', expect.any(String), {});
    expect(shot).toEqual({ png: PNG, app: 'Mawid', page: '/' });
    expect(fs.existsSync(at)).toBe(false);
    expect(fs.existsSync(path.dirname(at))).toBe(false);
    expect(temps()).toEqual(before);
  });

  it('uses the app that runs already, and cleans up when the picture fails', async () => {
    meta = withCommands({ start: 'npm run dev', url: 'http://localhost:3999' });
    runner.state = 'running';
    const before = temps();
    await expect(P.takeAppPicture(bp, { take: async () => Promise.reject(new Error('The page did not load.')) })).rejects.toThrow('The page did not load.');
    expect(runner.started).toBe(0);
    expect(temps()).toEqual(before);
  });

  it('refuses a project with no app, before starting anything or making a folder', async () => {
    meta = withCommands({}, { engine: 'demo' });
    const before = temps();
    const take = vi.fn();
    await expect(P.takeAppPicture(bp, { take })).rejects.toThrow(P.NO_APP);
    expect(take).not.toHaveBeenCalled();
    expect(runner.started).toBe(0);
    expect(temps()).toEqual(before);
  });
});

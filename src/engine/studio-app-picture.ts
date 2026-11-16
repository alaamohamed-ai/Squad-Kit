import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPhoneRepo, isUp, projectApps, type ProjectApp } from '../board/apps.js';
import { boardExists, readMeta, type BoardPaths } from '../board/store.js';
import { appRunner } from './run-app.js';
import { ShotsUnavailable, takeOne } from './shots.js';

/**
 * "A screen from your app" on the Studio's start page (US-05, AB-130). The project's web app is found the way Your apps
 * finds it; when it is not running, squad-kit starts it and waits until it answers, then takes one picture with its
 * own browser into a temporary folder, reads it back and deletes the folder. The picture goes to the browser, which
 * keeps it with the message until Send (AB-130.1): nothing lands in the project.
 */

export const NO_APP = 'This project has no app to take a picture of yet.';
export const PHONE_APP = "This project's app runs on a phone, so there is no web page to take a picture of.";
export const NO_ADDRESS = "squad-kit doesn't know your app's web address yet. Set it in Settings, under How the squad checks and runs this project.";

export interface AppPictureOption {
  ok: boolean;
  /** Why not, in one plain sentence. */
  why?: string;
  /** The app the picture is of. */
  app?: string;
}

/** The web app a picture is taken of: the first one with an address. Throws with the person's words when there is none. */
function webApp(bp: BoardPaths): ProjectApp {
  if (!boardExists(bp)) throw new Error(NO_APP);
  const meta = readMeta(bp);
  const apps = projectApps(meta);
  const web = apps.find((a) => a.url);
  if (web) return web;
  if (apps.some((a) => isPhoneRepo(meta, a.repo))) throw new Error(PHONE_APP);
  if (apps.some((a) => a.start)) throw new Error(NO_ADDRESS);
  // None, or a live project that knows nothing of its app yet.
  throw new Error(NO_APP);
}

/**
 * Whether the option can be used, and why not. It only reads: it starts nothing and writes no file. An app squad-kit
 * cannot start (no start command) counts only while something answers at its address.
 */
export async function appPictureOption(bp: BoardPaths): Promise<AppPictureOption> {
  let app: ProjectApp;
  try {
    app = webApp(bp);
  } catch (err) {
    return { ok: false, why: (err as Error).message };
  }
  if (!app.start && !(await isUp(app.url!))) return { ok: false, why: `${app.name} is not running, and squad-kit doesn't know how to start it yet. Start it yourself, or set its start command in Settings.`, app: app.name };
  return { ok: true, app: app.name };
}

/** Where the app answers now, starting it first when it does not. Throws with the person's words when it would not start. */
async function runningAt(bp: BoardPaths, app: ProjectApp): Promise<string> {
  const runner = appRunner(bp);
  let s = await runner.statusOf(app.name);
  if (s.state === 'starting') s = await runner.settled(app.name);
  // Something answers: Your apps runs it, it runs from a terminal, or the person runs it themselves.
  if (s.up) return s.address ?? app.url!;
  if (!app.start) throw new Error(`${app.name} is not running, and squad-kit doesn't know how to start it yet.`);
  if (s.state !== 'running') {
    runner.start(app.name);
    s = await runner.settled(app.name);
  }
  if (s.state !== 'running') throw new Error(s.error ?? `${app.name} did not start, so squad-kit could not take a picture of it.`);
  return s.address ?? app.url!;
}

/** One picture of the running app, as PNG bytes. The temporary folder it was made in is gone when this returns. */
export async function takeAppPicture(bp: BoardPaths, o: { signal?: AbortSignal; take?: typeof takeOne } = {}): Promise<{ png: Buffer; app: string; page: string }> {
  const app = webApp(bp);
  const url = await runningAt(bp, app);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-studio-app-'));
  try {
    const file = path.join(dir, 'app.png');
    const r = await (o.take ?? takeOne)(url, file, o.signal ? { signal: o.signal } : {});
    return { png: fs.readFileSync(file), app: app.name, page: r.page };
  } catch (err) {
    if (err instanceof ShotsUnavailable) throw new Error(err.message);
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { isPlain } from './shape.js';
import { readSketch, screenNameKey, stampOfFolder, type AskScreen, type ChatOwner, type DrawnScreen, type UnsavedMark } from './studio.js';
import { writeShared } from './studio-files.js';
import { checkedStudioId, ownerChatUnsavedFile, screenDir } from './studio-paths.js';

/**
 * What the AI Designer drew for one message and could not save (US-57, AB-182.1): the screens it drew were changed
 * elsewhere between the message and the save. The drawings are kept with the chat on this computer, like its pictures
 * (AB-130.1), never in the project, until "Save them anyway" saves them as a new version on top (AB-128.2), and the
 * kept file goes. Also here: each screen's own stamp when a message is sent, so the one save at the end can tell a
 * change to the screens it drew from a change to anything else in the sketch.
 */

export interface UnsavedWork {
  id: string;
  chat: string;
  sketch: string;
  at: string;
  /** An ask for variants (US-17), or screens drawn and changed. */
  kind: 'variants' | 'screens';
  ask?: { id: string; words?: string };
  screens: AskScreen[] | DrawnScreen[];
  by: { madeBy?: string; madeFor?: string; note?: string };
}

/** Each screen's own stamp, by id, made from its files. Reading writes nothing. */
export function screenStampsOf(bp: BoardPaths, sketch: string): Record<string, string | null> {
  const s = readSketch(bp, sketch);
  return Object.fromEntries((s?.screens ?? []).map((x) => [x.id, stampOfFolder(screenDir(bp, sketch, x.id))]));
}

/**
 * The screens of `drawn` changed since `seen` was read, by name: a screen drawn on whose files changed (a new drawing, a
 * rename, an approval), gone, or a new screen whose name another new screen took meanwhile. A renamed sketch, an empty
 * screen added, or a change to another screen is no change to these. Null when the sketch itself is gone.
 */
export function changedScreens(bp: BoardPaths, sketch: string, seen: Record<string, string | null>, drawn: { id?: string; name: string }[]): string[] | null {
  const now = readSketch(bp, sketch);
  if (!now) return null;
  const out: string[] = [];
  for (const d of drawn) {
    if (d.id) {
      if (!(d.id in seen)) continue;
      const s = now.screens.find((x) => x.id === d.id);
      if (!s || stampOfFolder(screenDir(bp, sketch, d.id)) !== seen[d.id]) out.push(s?.name ?? d.name);
    } else if (now.screens.some((x) => !(x.id in seen) && screenNameKey(x.name) === screenNameKey(d.name))) out.push(d.name);
  }
  return out;
}

const newUnsavedId = () => `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Keeps drawings that could not be saved, with the chat on this computer. */
export function keepUnsaved(bp: BoardPaths, owner: ChatOwner, work: Omit<UnsavedWork, 'id' | 'at'>, changed: string[]): UnsavedMark {
  const id = newUnsavedId();
  const kept: UnsavedWork = { ...work, id, at: new Date().toISOString() };
  writeShared(ownerChatUnsavedFile(bp, owner, id), `${JSON.stringify(kept)}\n`);
  return { id, screens: changed };
}

/** Kept drawings, or null when they are not here (saved already, or never kept). */
export function readUnsaved(bp: BoardPaths, owner: ChatOwner, id: string): UnsavedWork | null {
  let file: string;
  try {
    file = ownerChatUnsavedFile(bp, owner, checkedStudioId(id));
  } catch {
    return null;
  }
  if (!fs.existsSync(file)) return null;
  try {
    const w = JSON.parse(fs.readFileSync(file, 'utf8')) as UnsavedWork;
    return isPlain(w) && w.id === id && Array.isArray(w.screens) && (w.kind === 'variants' || w.kind === 'screens') ? w : null;
  } catch {
    return null;
  }
}

/** Lets go of kept drawings once they are saved. */
export function dropUnsaved(bp: BoardPaths, owner: ChatOwner, id: string): void {
  fs.rmSync(ownerChatUnsavedFile(bp, owner, id), { force: true });
}

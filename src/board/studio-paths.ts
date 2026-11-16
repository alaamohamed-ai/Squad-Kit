import path from 'node:path';
import type { BoardPaths } from './store.js';

/**
 * Where the Studio lives (AB-128.1): the project's part in `.squad/studio/`, shared through git, and this computer's
 * part (thumbnails and AI Designer chats) in `~/.squad-kit/projects/<id>/studio/`. Every location comes from
 * BoardPaths; nothing else in squad-kit builds a Studio path by hand.
 *
 *   .squad/studio/design-systems/<system>/system.yaml
 *   .squad/studio/design-systems/<system>/v1/tokens.json
 *   .squad/studio/design-systems/<system>/v1/components/<component>.html
 *   .squad/studio/sketches/<sketch>/sketch.yaml
 *   .squad/studio/sketches/<sketch>/screens/<screen>/screen.yaml
 *   .squad/studio/sketches/<sketch>/screens/<screen>/v1/<frame>.html
 *   .squad/studio/sketches/<sketch>/screens/<screen>/v1/meta.yaml
 *   ~/.squad-kit/projects/<id>/studio/thumbnails/<sketch>/<screen>/v1.png
 *   ~/.squad-kit/projects/<id>/studio/chats/<sketch>/<chat>.json
 *   ~/.squad-kit/projects/<id>/studio/chats/<sketch>/pictures/<picture>.png
 */

/** A Studio id as it is written in a folder name: lowercase letters, digits and dashes ("brand", "payment"). */
export const STUDIO_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Only a checked short id ever names a folder or a file, never anything a file or a request said. */
export function checkedStudioId(id: string): string {
  if (typeof id !== 'string' || !STUDIO_ID.test(id)) {
    throw new Error(`"${String(id).slice(0, 40)}" is not a Studio id (lowercase letters, digits and dashes, like "brand").`);
  }
  return id;
}

/** A version number: 1, 2 … */
function checkedVersion(version: number): string {
  if (!Number.isInteger(version) || version < 1 || version > 1_000_000) throw new Error(`"${version}" is not a Studio version (1, 2 …).`);
  return `v${version}`;
}

/** The folder name of a version: v1, v2 … */
export const VERSION_DIR = /^v([1-9]\d{0,6})$/;

/* ── Design systems ─────────────────────────────────────── */

export function designSystemsDir(bp: BoardPaths): string {
  return path.join(bp.studioDir, 'design-systems');
}

export function designSystemDir(bp: BoardPaths, system: string): string {
  return path.join(designSystemsDir(bp), checkedStudioId(system));
}

/** system.yaml: the name, whether it is the default and the current version. */
export function designSystemFile(bp: BoardPaths, system: string): string {
  return path.join(designSystemDir(bp, system), 'system.yaml');
}

export function designSystemVersionDir(bp: BoardPaths, system: string, version: number): string {
  return path.join(designSystemDir(bp, system), checkedVersion(version));
}

export function tokensFile(bp: BoardPaths, system: string, version: number): string {
  return path.join(designSystemVersionDir(bp, system, version), 'tokens.json');
}

export function componentsDir(bp: BoardPaths, system: string, version: number): string {
  return path.join(designSystemVersionDir(bp, system, version), 'components');
}

export function componentFile(bp: BoardPaths, system: string, version: number, component: string): string {
  return path.join(componentsDir(bp, system, version), `${checkedStudioId(component)}.html`);
}

/* ── Sketches ───────────────────────────────────────────── */

export function sketchesDir(bp: BoardPaths): string {
  return path.join(bp.studioDir, 'sketches');
}

export function sketchDir(bp: BoardPaths, sketch: string): string {
  return path.join(sketchesDir(bp), checkedStudioId(sketch));
}

/** sketch.yaml: the name, the design system and its version, and the frames. */
export function sketchFile(bp: BoardPaths, sketch: string): string {
  return path.join(sketchDir(bp, sketch), 'sketch.yaml');
}

export function screensDir(bp: BoardPaths, sketch: string): string {
  return path.join(sketchDir(bp, sketch), 'screens');
}

export function screenDir(bp: BoardPaths, sketch: string, screen: string): string {
  return path.join(screensDir(bp, sketch), checkedStudioId(screen));
}

/** screen.yaml: the name, the order, the status and the chosen version. */
export function screenFile(bp: BoardPaths, sketch: string, screen: string): string {
  return path.join(screenDir(bp, sketch, screen), 'screen.yaml');
}

/** One variant of a screen, kept as its own version folder. */
export function variantDir(bp: BoardPaths, sketch: string, screen: string, version: number): string {
  return path.join(screenDir(bp, sketch, screen), checkedVersion(version));
}

export function frameFile(bp: BoardPaths, sketch: string, screen: string, version: number, frame: string): string {
  return path.join(variantDir(bp, sketch, screen, version), `${checkedStudioId(frame)}.html`);
}

export function variantMetaFile(bp: BoardPaths, sketch: string, screen: string, version: number): string {
  return path.join(variantDir(bp, sketch, screen, version), 'meta.yaml');
}

/* ── This computer's part ───────────────────────────────── */

/** Held while one Studio change checks its stamp and writes, so two changes to the project never cross. */
export function studioLockFile(bp: BoardPaths): string {
  return path.join(bp.localDir, 'studio.lock');
}

export function thumbnailsDir(bp: BoardPaths): string {
  return path.join(bp.studioLocalDir, 'thumbnails');
}

/** One sketch's thumbnails on this computer, one folder per screen. */
export function sketchThumbnailsDir(bp: BoardPaths, sketch: string): string {
  return path.join(thumbnailsDir(bp), checkedStudioId(sketch));
}

export function screenThumbnailsDir(bp: BoardPaths, sketch: string, screen: string): string {
  return path.join(sketchThumbnailsDir(bp, sketch), checkedStudioId(screen));
}

export function thumbnailFile(bp: BoardPaths, sketch: string, screen: string, version: number): string {
  return path.join(screenThumbnailsDir(bp, sketch, screen), `${checkedVersion(version)}.png`);
}

export function chatsDir(bp: BoardPaths): string {
  return path.join(bp.studioLocalDir, 'chats');
}

/** One sketch's AI Designer chats on this computer. */
export function sketchChatsDir(bp: BoardPaths, sketch: string): string {
  return path.join(chatsDir(bp), checkedStudioId(sketch));
}

export function chatFile(bp: BoardPaths, sketch: string, chat: string): string {
  return path.join(sketchChatsDir(bp, sketch), `${checkedStudioId(chat)}.json`);
}

/** A picture file's name in a chat: a short id and its kind, like "m1-1.png". */
export const CHAT_PICTURE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.(?:png|jpg|webp)$/;

/** The pictures added to a sketch's messages, kept with its chats on this computer (AB-130.1). */
export function chatPicturesDir(bp: BoardPaths, sketch: string): string {
  return path.join(sketchChatsDir(bp, sketch), 'pictures');
}

export function chatPictureFile(bp: BoardPaths, sketch: string, file: string): string {
  if (typeof file !== 'string' || !CHAT_PICTURE.test(file)) throw new Error(`"${String(file).slice(0, 40)}" is not a picture of this sketch's messages.`);
  return path.join(chatPicturesDir(bp, sketch), file);
}

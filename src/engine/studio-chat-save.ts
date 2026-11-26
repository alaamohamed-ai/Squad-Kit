import type { BoardPaths } from '../board/store.js';
import { StudioChangedElsewhere, newAskId, saveAskVariants, saveDrawnScreens, studioStamp, type AskScreen, type ChatOwner, type DrawnScreen, type StudioChatMessage, type UnsavedMark } from '../board/studio.js';
import { StudioNotFound } from '../board/studio-actions.js';
import { updateChat } from '../board/studio-chats.js';
import { holdStudio } from '../board/studio-lock.js';
import { changedScreens, dropUnsaved, keepUnsaved, readUnsaved, type UnsavedWork } from '../board/studio-unsaved.js';
import { draftKey, type ChatDraft } from './studio-chat-progress.js';

/**
 * The one save at the end of a chat message (US-57, AB-182.1). It goes with the stamp read when the message was sent
 * (AB-129.1). When that stamp is old, only the screens just drawn are compared with how they were when the message was
 * sent: unchanged (the sketch was renamed, an empty screen added, another screen changed), the drawings are saved again
 * under the new stamp, with no button and no message. Changed, they are kept with the chat on this computer and the
 * reply says "Not saved"; "Save them anyway" then saves them as a new version on top, so the other version stays in the
 * history (AB-128.2), adds its line to the chat after the save (AB-143.1), and lets go of the kept drawings.
 */

export type SaveOutcome<T> = { saved: T } | { kept: UnsavedMark; changed: string[] };

/** The turn as the save needs it: whose chat, the stamp read, and each screen's own stamp when it was sent. */
export interface SavingTurn {
  owner: ChatOwner;
  chat: string;
  stamp: string | null;
  seen?: Record<string, string | null>;
}

export function saveOrKeep<T>(bp: BoardPaths, turn: SavingTurn, work: Omit<UnsavedWork, 'id' | 'at' | 'chat'>, save: (stamp: string) => T): SaveOutcome<T> {
  try {
    return { saved: save(turn.stamp ?? '') };
  } catch (err) {
    if (!(err instanceof StudioChangedElsewhere) || !turn.seen) throw err;
  }
  // Under the Studio lock, so nothing changes between the check and the second save.
  return holdStudio(bp, () => {
    const changed = changedScreens(bp, work.sketch, turn.seen!, work.screens);
    if (!changed) throw new StudioChangedElsewhere();
    if (!changed.length) return { saved: save(studioStamp(bp, { kind: 'sketch', id: work.sketch }) ?? '') };
    return { kept: keepUnsaved(bp, turn.owner, { ...work, chat: turn.chat }, changed), changed };
  });
}

/** The kept drawings as the page shows them: one done frame per variant or screen, marked "Not saved" there. */
export function unsavedDrafts(w: UnsavedWork): ChatDraft[] {
  if (w.kind === 'variants')
    return (w.screens as AskScreen[]).flatMap((s) =>
      s.variants.map((v) => ({ key: draftKey({ ...(s.id ? { screen: s.id } : {}), name: s.name }, v.letter), ...(s.id ? { screen: s.id } : {}), name: s.name, letter: v.letter, variantName: v.name, state: 'done' as const, pages: v.frames })),
    );
  return (w.screens as DrawnScreen[]).map((s) => ({ key: draftKey({ ...(s.id ? { screen: s.id } : {}), name: s.name }), ...(s.id ? { screen: s.id, redraw: true } : {}), name: s.name, state: 'done' as const, pages: s.frames }));
}

/** The words of the line "Save them anyway" adds: "You saved them anyway: Form A v4 · Form B v5". */
export function savedAnywayWords(rows: { name?: string; screen: string; version: number; letter?: string }[]): string {
  return `You saved them anyway: ${rows.map((r) => `${r.name ?? r.screen}${r.letter ? ` ${r.letter}` : ''} v${r.version}`).join(' · ')}`;
}

/**
 * "Save them anyway": the kept drawings saved as a new version on top, with the stamp the page read, marked as the AI
 * Designer's work for the person who asked (AB-131.1). After the save, the reply says what was saved, the line goes at
 * the end of the chat, and the kept drawings go. A stale stamp or an approved screen is refused, and nothing changes.
 */
export function saveUnsaved(bp: BoardPaths, owner: ChatOwner, chat: string, id: string, stamp?: string): StudioChatMessage {
  const w = readUnsaved(bp, owner, id);
  if (!w || w.chat !== chat || owner.kind !== 'sketch' || w.sketch !== owner.id) throw new StudioNotFound('These drawings are not kept here any more: they may be saved already.');
  const use = stamp || (studioStamp(bp, { kind: 'sketch', id: w.sketch }) ?? '');
  const result = w.kind === 'variants' ? saveAskVariants(bp, w.sketch, w.ask ?? { id: newAskId() }, w.screens as AskScreen[], use, w.by) : saveDrawnScreens(bp, w.sketch, w.screens as DrawnScreen[], use, w.by);
  const nameOf = (screen: string) => result.sketch.screens.find((x) => x.id === screen)?.name ?? screen;
  const rows = result.saved.map((s) => ({ screen: s.screen, name: nameOf(s.screen), version: s.version, ...('letter' in s && typeof s.letter === 'string' ? { letter: s.letter } : {}) }));
  const at = new Date().toISOString();
  const line: StudioChatMessage = { role: 'action', text: savedAnywayWords(rows), at, savedAnyway: { saved: rows.map(({ screen, name, version }) => ({ screen, name, version })), at } };
  updateChat(bp, owner, chat, (c) => {
    for (const m of c.messages) {
      if (m.unsaved?.id !== id) continue;
      delete m.unsaved;
      m.kind = 'changed';
      m.saved = rows.map(({ screen, name, version }) => ({ screen, name, version }));
    }
    c.messages.push(line);
  });
  dropUnsaved(bp, owner, id);
  return line;
}

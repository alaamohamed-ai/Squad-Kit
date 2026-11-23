import type { ApprovalView, ScreenView } from './studio';

/*
 * The screen tabs of a sketch and the list of all its screens (US-11, US-15, US-53): Add screen's stamp, the words a
 * tab, its Delete and the status chip use, and the approved mark both the tabs and the list show. Part of lib/studio,
 * which gives these out again; this file reads only its types, so the two never load each other in a loop.
 */

/**
 * The stamp Add screen sends (AB-129.1): the one the last add answered with, while the page still shows the sketch it
 * read before that add; else the one the page read. A second click before the sketch is read again then adds "New
 * screen 2" instead of being refused with "Changed elsewhere, reload".
 */
export function addScreenStamp(read: string, answered: { read: string; now: string } | null): string {
  return answered && answered.read === read ? answered.now : read;
}

/** A frame's name as a tab shows it: "desktop" → "Desktop". */
export const frameName = (frame: string) => (frame ? frame[0]!.toUpperCase() + frame.slice(1) : frame);

/** What an empty screen shows in a frame: "New screen has no Desktop page yet. Ask the AI Designer in the chat to draw it." */
export function emptyScreenText(screen: string, frame: string | undefined): string {
  return `${screen} has no ${frame ? `${frameName(frame)} ` : ''}page yet. Ask the AI Designer in the chat to draw it.`;
}

/** Delete's question on a screen's tab, naming it. */
export function deleteScreenQuestion(screen: string): { title: string; holds: string } {
  return { title: `Delete "${screen}" and its drawings?`, holds: 'This cannot be undone. The other screens stay as they are.' };
}

/** The tab selected once a screen is deleted: the one after it, or else the one before it, or none. */
export function tabAfterDelete(screens: { id: string }[], gone: string): string | undefined {
  const at = screens.findIndex((s) => s.id === gone);
  const rest = screens.filter((s) => s.id !== gone);
  if (!rest.length) return undefined;
  return (rest[at] ?? rest[rest.length - 1])!.id;
}

/** A message's time, like 16:02. */
export function timeOf(at?: string | null): string {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A screen is approved: locked, so "Use this one", Delete and changes are off until Reopen. */
export const isApproved = (screen: Pick<ScreenView, 'status'> | undefined) => screen?.status === 'approved';

/** When it was approved, like "23 Nov, 14:05"; empty when the time cannot be read. */
export function approvalTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${timeOf(at)}`;
}

/** "Approved by Alaa · 23 Nov, 14:05"; "Approved" alone for a screen approved before who and when were kept. */
export function approvedByText(approved: ApprovalView | undefined): string {
  if (!approved) return 'Approved';
  const when = approvalTime(approved.at);
  return `Approved${approved.by ? ` by ${approved.by}` : ''}${when ? ` · ${when}` : ''}`;
}

/** A screen's status as its chip says it: Draft, Ready or Approved. */
export const statusLabel = (status: string) => (status ? status[0]!.toUpperCase() + status.slice(1) : 'Draft');

/** Reopen's "Are you sure?" question, naming the screen and the version that stays. */
export function reopenQuestion(screen: string, version: number | null): { title: string; holds: string } {
  return {
    title: `Reopen "${screen}"?`,
    holds: `Are you sure? ${screen} goes back to Draft and its lock goes away. The next change makes a new version${version ? `; v${version} stays` : ''}.`,
  };
}

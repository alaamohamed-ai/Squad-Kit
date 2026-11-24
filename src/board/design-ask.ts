import { addActivity, readMeta, updateTicket, type BoardPaths } from './store.js';
import { scheduleSquad } from './schedule.js';
import { BoardActionError } from './actions/errors.js';
import { addTicketDesigns, approvedScreens, type DesignPick } from './ticket-designs.js';
import type { Ticket } from './types.js';

/**
 * The design step of a ticket (US-55): right after the questions and before the spec, a ticket of a project with
 * approved Studio screens waits with one card, "Does this ticket follow a design from the Studio?". The person ticks
 * the approved screens and presses "Use these designs", or presses "No design"; the Analyst then writes the spec, with
 * the picked screens. This is the only place screens are picked; the Story tab shows them as cards, with Remove until
 * the build starts. The step is skipped by itself when the project has no approved screen, when it was answered before
 * (or the ticket came with screens picked already), and on a story that builds by itself or goes Express. The answer is
 * kept on the ticket (designAsked), with the project, so it is asked once.
 */

export const DESIGN_QUESTION = 'Does this ticket follow a design from the Studio?';

/** The ticket asks for a design now: full track, before its spec, nothing picked or answered, and approved screens exist. */
export function designAskDue(bp: BoardPaths, t: Ticket): boolean {
  if (t.track === 'express' || t.track === 'auto' || t.specApproved || t.story !== undefined) return false;
  if (t.designs?.length || t.designAsked) return false;
  try {
    return approvedScreens(bp).length > 0;
  } catch {
    // A Studio that cannot be read asks nothing: the ticket goes on as before.
    return false;
  }
}

/**
 * Before the spec: when the design step is due, the ticket stops and waits for the person's answer, and this says true.
 * Otherwise it changes nothing and says false, and the spec is written as before. Changes `t` in place, in the
 * caller's own save, so the live squad and the sample board's squad share it.
 */
export function waitForDesign(bp: BoardPaths, t: Ticket): boolean {
  if (t.waiting?.kind === 'design') return true;
  if (!designAskDue(bp, t)) return false;
  t.live = false;
  t.squad = null;
  delete t.clock;
  t.status = 'Waiting for you: a design from the Studio?';
  t.waiting = { kind: 'design', summary: DESIGN_QUESTION };
  addActivity(t, 'squad', 'Asked whether it follows a design from the Studio, before the spec');
  return true;
}

/**
 * The person's answer: the approved screens ticked ("Use these designs"), at least one, or none ("No design"). Ticked
 * screens are copied at their approved version into the ticket's folder. Then the Analyst writes the spec. Refused
 * when the ticket does not wait for this answer any more.
 */
export function answerDesign(bp: BoardPaths, id: string, answer: { picks?: DesignPick[]; none?: boolean }, who: { by?: string } = {}): Ticket {
  updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'design') throw new BoardActionError('This ticket does not wait for a design any more. Reload to see where it is.');
  });
  const picks = answer.none ? [] : (answer.picks ?? []);
  if (!answer.none && !picks.length) throw new BoardActionError('Tick at least one approved screen, or press No design.');
  if (picks.length) addTicketDesigns(bp, id, picks, who);
  const speed = readMeta(bp).speed;
  return updateTicket(bp, id, (t) => {
    t.designAsked = { at: new Date().toISOString(), ...(who.by ? { by: who.by } : {}), answer: answer.none ? 'none' : 'designs' };
    if (answer.none) addActivity(t, 'you', 'Said this ticket follows no design from the Studio');
    else addActivity(t, 'you', `Chose the design${t.designs!.length === 1 ? '' : 's'} to follow: ${t.designs!.map((d) => d.name).join(', ')}`);
    t.waiting = null;
    t.live = true;
    t.status = 'Analyst is writing the spec';
    scheduleSquad(t, 'plan-write', 0.5, speed);
  });
}

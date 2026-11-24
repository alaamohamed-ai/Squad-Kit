import { addActivity, readMeta, updateTicket, type BoardPaths } from './store.js';
import { scheduleSquad } from './schedule.js';
import { BoardActionError } from './actions/errors.js';
import { addTicketDesigns, approvedScreens, type DesignPick } from './ticket-designs.js';
import type { Ticket, Waiting } from './types.js';

/**
 * The design step of a ticket (US-55, US-56): before the Analyst reads the ticket and asks its questions, a ticket of a
 * project with approved Studio screens waits with one card, "Does this ticket follow a design from the Studio?". The
 * person ticks the approved screens and presses "Use these designs", or presses "No design"; the Analyst then reads the
 * ticket with the picked screens and asks only what they do not show, and the spec and the plan use the same screens.
 * A ticket made before this, already past its questions, gets the same card once before the spec instead (AB-181.1).
 * This is the only place screens are picked; the Story tab shows them as cards, with Remove until the build starts.
 * The step is skipped by itself when the project has no approved screen, when it was answered before (or the ticket
 * came with screens picked already), and on a story that builds by itself or goes Express. The answer is kept on the
 * ticket (designAsked), with the project, so it is asked once.
 */

export const DESIGN_QUESTION = 'Does this ticket follow a design from the Studio?';

/**
 * Where the card shows (AB-181.1): before the Analyst's first read ('read'), so it reads the ticket with the screens,
 * or before the spec ('spec'), for a ticket made before US-56 that is past its questions and was never asked.
 */
export type DesignPoint = 'read' | 'spec';

/**
 * The card's waiting mark, with the point it stopped before when that is the first read, so the answer goes back
 * there. A mark with none (and every card from before US-56) stopped before the spec.
 */
type DesignWaiting = Waiting & { before?: 'read' };

/** The card stopped before the Analyst's first read: the answer goes on to that read, not to the spec. */
export const designBeforeRead = (t: Pick<Ticket, 'waiting'>) => t.waiting?.kind === 'design' && (t.waiting as DesignWaiting).before === 'read';

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
 * Before the Analyst's first read, or before the spec: when the design step is due there, the ticket stops and waits
 * for the person's answer, and this says true. Otherwise it changes nothing and says false, and the step runs as
 * before. Changes `t` in place, in the caller's own save, so the live squad and the sample board's squad share it.
 */
export function waitForDesign(bp: BoardPaths, t: Ticket, at: DesignPoint = 'spec'): boolean {
  if (t.waiting?.kind === 'design') return true;
  if (!designAskDue(bp, t)) return false;
  t.live = false;
  t.squad = null;
  delete t.clock;
  t.status = 'Waiting for you: a design from the Studio?';
  const waiting: DesignWaiting = { kind: 'design', summary: DESIGN_QUESTION, ...(at === 'read' ? { before: 'read' as const } : {}) };
  t.waiting = waiting;
  addActivity(t, 'squad', `Asked whether it follows a design from the Studio, before the ${at === 'read' ? 'questions' : 'spec'}`);
  return true;
}

/**
 * The person's answer: the approved screens ticked ("Use these designs"), at least one, or none ("No design"). Ticked
 * screens are copied at their approved version into the ticket's folder. Then the Analyst reads the ticket and asks
 * its questions, or, on a ticket already past them, writes the spec. Refused when the ticket does not wait any more.
 */
export function answerDesign(bp: BoardPaths, id: string, answer: { picks?: DesignPick[]; none?: boolean }, who: { by?: string } = {}): Ticket {
  const first = designBeforeRead(updateTicket(bp, id, (t) => {
    if (t.waiting?.kind !== 'design') throw new BoardActionError('This ticket does not wait for a design any more. Reload to see where it is.');
  }));
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
    if (first) {
      t.status = 'Analyst is reading the ticket';
      scheduleSquad(t, 'analyst-read', 0.5, speed, 0);
    } else {
      t.status = 'Analyst is writing the spec';
      scheduleSquad(t, 'plan-write', 0.5, speed);
    }
  });
}

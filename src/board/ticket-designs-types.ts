import path from 'node:path';

/**
 * The shape of a ticket's designs from the Studio (US-55, AB-180.1), as ticket.md keeps them, and how the list is
 * written and read there: each copy's folder is kept inside the ticket's own folder on disk and read back as a full
 * path. Apart from board/ticket-designs.ts, so the ticket store reads it with nothing else.
 */

/** One frame's pictures on the proof: the design drawn from the frozen copy, and the Tester's after picture of the page it built. */
export interface DesignProof {
  frame: string;
  /** The design picture, a file in the proof folder. */
  design?: string;
  /** The Tester's after picture, a file in the proof folder. */
  after?: string;
  /** Where the after picture was taken, as a path in the app. */
  page?: string;
}

/** One approved Studio screen on a ticket, frozen at its approved version. */
export interface TicketDesign {
  sketch: string;
  screen: string;
  /** "Sketch / Screen" as it was named when picked (AB-136.1). */
  name: string;
  /** The version the screen was approved at (AB-140.1): the one copied. */
  version: number;
  /** Its frames, in the sketch's order: desktop, mobile … */
  frames: string[];
  /** The frozen copy's folder: the full path on this computer, kept inside the ticket's folder on disk. */
  dir: string;
  addedAt: string;
  addedBy?: string;
  /** The design next to the build, per frame, once the proof ran. */
  proof?: DesignProof[];
}

/** The design step's answer (US-55): asked once, between the questions and the spec, and never again on the ticket. */
export interface DesignAsked {
  at: string;
  by?: string;
  /** The person picked screens ("Use these designs"), or said "No design". */
  answer: 'designs' | 'none';
}

/** A ticket's part of the Studio's designs: the screens it builds, and the design step's answer. */
export interface TicketDesigns {
  /** Approved Studio screens the squad builds, each a frozen copy in the ticket's folder (board/ticket-designs.ts). */
  designs?: TicketDesign[];
  designAsked?: DesignAsked;
}

/** Where they live: with the project, so a teammate's squad builds the same screens and does not ask again. */
export const DESIGNS_HOME = { designs: 'project', designAsked: 'project' } as const satisfies Record<keyof TicketDesigns, 'project' | 'local'>;

/** The list as ticket.md keeps it: each folder inside the ticket's folder. */
export function designsOnDisk(folder: string, designs: TicketDesign[]): TicketDesign[] {
  return designs.map((d) => ({ ...d, dir: path.isAbsolute(d.dir) ? path.relative(folder, d.dir).split(path.sep).join('/') : d.dir }));
}

/** The list as read: each folder as a full path. A hand-written entry that cannot be read is left out. */
export function designsRead(folder: string, designs: unknown): TicketDesign[] | undefined {
  if (!Array.isArray(designs)) return undefined;
  const out = designs.flatMap((d): TicketDesign[] => {
    if (!d || typeof d !== 'object') return [];
    const x = d as Record<string, unknown>;
    if (typeof x.sketch !== 'string' || typeof x.screen !== 'string' || typeof x.name !== 'string' || typeof x.dir !== 'string' || !Number.isInteger(x.version)) return [];
    const frames = Array.isArray(x.frames) ? x.frames.filter((f): f is string => typeof f === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(f)) : [];
    const rel = x.dir.replace(/\\/g, '/');
    // A folder outside the ticket's own is not a copy of this ticket.
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) return [];
    const proof = Array.isArray(x.proof) ? (x.proof as DesignProof[]).filter((p) => p && typeof p.frame === 'string') : undefined;
    return [{ sketch: x.sketch, screen: x.screen, name: x.name, version: x.version as number, frames, dir: path.join(folder, rel), addedAt: typeof x.addedAt === 'string' ? x.addedAt : '', ...(typeof x.addedBy === 'string' ? { addedBy: x.addedBy } : {}), ...(proof?.length ? { proof } : {}) }];
  });
  return out.length ? out : undefined;
}


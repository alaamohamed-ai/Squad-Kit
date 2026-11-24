import { api, assetUrl, send } from './client';

/**
 * A ticket's designs from the Studio (US-55): the approved screens the squad builds, each a frozen copy at its approved
 * version, saved with the ticket. The server's routes are in src/console/api/ticket-designs.ts.
 */

/** One frame's pictures on the proof: the design drawn from the frozen copy and the Tester's after picture. */
export interface DesignProof {
  frame: string;
  design?: string;
  after?: string;
  page?: string;
}

/** A screen picked for the ticket, with its frames' HTML from the frozen copy. */
export interface TicketDesign {
  sketch: string;
  screen: string;
  /** "Sketch / Screen". */
  name: string;
  version: number;
  frames: string[];
  html: Record<string, string>;
  proof?: DesignProof[];
}

export interface TicketDesigns {
  /** The build has started: nothing is picked or removed. */
  locked: boolean;
  designs: TicketDesign[];
}

/** An approved screen of the Studio the person may tick. */
export interface ApprovedScreen {
  sketch: string;
  screen: string;
  name: string;
  version: number;
  frames: string[];
  html: Record<string, string>;
  picked: boolean;
}

const base = (id: string) => `/api/v1/tickets/${encodeURIComponent(id)}/designs`;

export const ticketDesignsKey = (project: string | null, id: string) => ['ticket-designs', project ?? '', id];

export const getTicketDesigns = (id: string) => api<TicketDesigns>(base(id));

export const getApprovedScreens = (id: string) => api<{ locked: boolean; screens: ApprovedScreen[] }>(`${base(id)}/approved`);

/** The answer to the design step: the screens ticked ("Use these designs"), or none ("No design"). */
export const answerDesign = (id: string, answer: { picks: { sketch: string; screen: string }[] } | { none: true }) => send<TicketDesigns>(`${base(id)}/answer`, 'POST', answer);

export const removeTicketDesign = (id: string, d: { sketch: string; screen: string }) =>
  send<TicketDesigns>(`${base(id)}/${encodeURIComponent(d.sketch)}/${encodeURIComponent(d.screen)}`, 'DELETE');

/** A proof picture, served from the proof folder. */
export const proofPictureUrl = (file: string) => assetUrl(`/api/v1/proof/${encodeURIComponent(file)}`);

/** "desktop" → "Desktop". */
export const frameLabel = (frame: string) => (frame ? frame[0]!.toUpperCase() + frame.slice(1) : frame);

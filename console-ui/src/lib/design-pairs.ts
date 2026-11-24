/** A ticket's design next to the build (US-55), for the proof card: kept apart from the page, so it reads without a browser. */

/** One frame's pictures on the proof, as the server keeps them. */
export interface DesignProofRow {
  frame: string;
  design?: string;
  after?: string;
  page?: string;
}

/** One pair on the card: a screen's frame, its design picture and the Tester's after picture of the page it built. */
export interface DesignPair extends Partial<DesignProofRow> {
  name: string;
  frame: string;
}

/** The pairs to show, per screen and frame, in the order the ticket keeps them. None when no screen was picked or the proof has not run. */
export function designPairs(designs: { name: string; frames: string[]; proof?: DesignProofRow[] }[]): DesignPair[] {
  return designs.flatMap((d) => (d.proof?.length ? d.frames.map((f) => ({ ...d.proof!.find((p) => p.frame === f), name: d.name, frame: f })) : []));
}

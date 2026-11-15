/**
 * The Studio's runs in the app's one limit of runs at once (AB-141, done when 4). A Designer run takes a place like a
 * ticket's step, in every project together. One that waits goes before every ticket that waits: while it waits, no
 * ticket takes a free place (live/squad.ts asks studioWaiting), so the next free place is its. It never stops a run
 * that is going, and Designer runs among themselves start in the order they asked.
 */

/** Gives the place back. Calling it again does nothing. */
export type StudioPlace = () => void;

interface Run {
  root: string;
  key: string;
}

const going = new Map<symbol, Run>();
const line: symbol[] = [];

/** Studio runs going now, in every project. */
export function studioRunsGoing(): number {
  return going.size;
}

/** True while a Studio run waits for a place: tickets that wait let it go first. */
export function studioWaiting(): boolean {
  return line.length > 0;
}

/** The Studio runs going now, by project folder, for the update that waits for a safe moment. */
export function studioRuns(): Run[] {
  return [...going.values()];
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Waits for a place, first in line among the Studio runs. `wait` says why it cannot start now (every place busy, the
 * usage limit, an update waiting), or null once it can; each new reason goes to `onWait`. Stopped while it waits, it
 * leaves the line and throws.
 */
export async function takeStudioPlace(o: { root: string; key: string; wait: () => string | null; signal?: AbortSignal; onWait?: (words: string) => void; everyMs?: number }): Promise<StudioPlace> {
  const me = Symbol(o.key);
  line.push(me);
  let said = '';
  try {
    for (;;) {
      if (o.signal?.aborted) throw new Error('You stopped the Designer.');
      const why = line[0] === me ? o.wait() : 'Next in line: another Designer run starts first.';
      if (why === null) break;
      if (why !== said) o.onWait?.((said = why));
      await sleep(o.everyMs ?? 250, o.signal);
    }
  } finally {
    line.splice(line.indexOf(me), 1);
  }
  going.set(me, { root: o.root, key: o.key });
  return () => {
    going.delete(me);
  };
}

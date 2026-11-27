import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Sparkles } from 'lucide-react';
import { api, send } from '../../api/client';
import { Modal } from '../../components/ui';
import { frameName, sketchKey, sketchesKey } from '../../lib/studio';
import { GENERATE, NO_SCREENS, REPLACE_TEXT, REPLACE_TITLE, countLine, prototypeKey, prototypePath, tabOf, targetOfPick, type PrototypeData } from '../../lib/studio-prototype';
import { PrototypeMap, PrototypeTabs, type Picked } from './PrototypeMap';
import { PrototypePlay } from './PrototypePlay';
import { PrototypeSkeleton } from './Skeletons';

/* ── A sketch's Prototype view (US-54, US-58, AB-179.1, AB-183.1) ──
   Every screen with a drawing, approved or not, as a card in the screen order, with the links between them as arrows
   above the cards (PrototypeMap.tsx). One rule for every screen: its options, or its one drawing; a screen with no
   drawing is left out. The top is one row, like the Screens view: on the left the count ("3 screens") and the tabs
   for the whole flow ("In use", "Option A" …); on the right "Generate the prototype" (the main button, which asks first
   when there are links already), Play, and the Desktop | Mobile switch at the far right. The tab picked stays in this
   page only: it is never saved, and Play opens on "In use".
   Every change sends the sketch's stamp the page read (AB-129.1) and is saved in the sketch's prototype file, so it is
   there after a reload and a teammate gets it through git. Opening the view writes nothing (AB-127.1). */

const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function PrototypeView({
  project,
  sketch,
  frame,
  frames,
  onFrame,
  onChanged,
}: {
  project: string;
  sketch: string;
  frame: string | undefined;
  /** The sketch's frames, for the Desktop | Mobile switch at the far right of the top row. */
  frames: string[];
  onFrame(frame: string): void;
  onChanged(): void;
}) {
  const key = prototypeKey(project, sketch);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<PrototypeData>(prototypePath(sketch)),
    // While the AI Designer links, the view is read again until it is done.
    refetchInterval: (query) => ((query.state.data as PrototypeData | undefined)?.working ? 1500 : false),
  });
  const data = q.data;
  const [picked, setPicked] = useState<Picked | null>(null);
  // The tab shown on the map: in this page only, never saved (AB-127.1).
  const [tabId, setTabId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [playing, setPlaying] = useState(false);
  const working = data?.working ?? null;

  // Generate saved new links: the sketch's stamp moved, so the rest of the workspace reads it again.
  const wasWorking = useRef(false);
  useEffect(() => {
    if (wasWorking.current && !working) {
      void qc.invalidateQueries({
        queryKey: sketchKey(project, sketch),
        exact: true,
      });
      void qc.invalidateQueries({ queryKey: sketchesKey(project) });
    }
    wasWorking.current = Boolean(working);
  }, [working, qc, project, sketch]);

  const saved = (next: PrototypeData) => {
    qc.setQueryData(key, next);
    onChanged();
  };
  const change = async (path: string, body: Record<string, unknown>) => {
    if (!data) return;
    setBusy(true);
    setProblem(null);
    try {
      saved(
        await send<PrototypeData>(`${prototypePath(sketch)}/${path}`, 'PUT', {
          stamp: data.sketch.stamp,
          ...body,
        }),
      );
    } catch (err) {
      setProblem(said(err));
      // A change elsewhere: read again, so the next try brings the new stamp.
      void q.refetch();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const link = (screen: string, button: string, value: string) => {
    const to = targetOfPick(value);
    return change('link', {
      screen,
      button,
      ...(to ? ('back' in to ? { back: true } : { to: to.screen }) : {}),
    });
  };
  const generate = async () => {
    if (!data) return;
    setConfirming(false);
    setBusy(true);
    setProblem(null);
    try {
      const r = await send<{ working: PrototypeData['working'] }>(`${prototypePath(sketch)}/generate`, 'POST', { stamp: data.sketch.stamp });
      qc.setQueryData(key, { ...data, working: r.working, problem: null });
    } catch (err) {
      setProblem(said(err));
    } finally {
      setBusy(false);
      void q.refetch();
    }
  };

  if (q.isError) return <p className="note bad pt-note">{q.error.message}</p>;
  if (!data) return <PrototypeSkeleton />;
  const none = data.screens.length === 0;
  const shown = frame && data.sketch.frames.includes(frame) ? frame : data.sketch.frames[0];
  const tab = tabOf(data, tabId);

  return (
    <div className="pt">
      <div className="pt-row">
        <p className="pt-line" dir="auto">
          {countLine(data.screens)}
        </p>
        <PrototypeTabs tabs={data.tabs} picked={tab.id} onPick={setTabId} />
        <span className="grow" />
        <button type="button" className="btn pri" disabled={none || busy || working !== null} onClick={() => (data.links.length ? setConfirming(true) : void generate())}>
          <Sparkles size={14} /> {working ? 'Generating…' : GENERATE}
        </button>
        <button type="button" className="btn" disabled={none || !data.start} onClick={() => setPlaying(true)}>
          <Play size={14} /> Play
        </button>
        {frames.length > 0 && (
          <div className="seg ws-frames" role="tablist" aria-label="Frames">
            {frames.map((f) => (
              <button key={f} role="tab" aria-selected={f === frame} className={f === frame ? 'on' : ''} onClick={() => onFrame(f)}>
                {frameName(f)}
              </button>
            ))}
          </div>
        )}
      </div>
      {working && (
        <p className="pt-working" role="status">
          <span className="dc-dot" /> The AI Designer is linking the screens. {working.doing}…
        </p>
      )}
      {!working && data.problem && (
        <p className="note bad pt-problem" role="alert">
          Generating did not work: {data.problem} The links stay as they were.
        </p>
      )}
      {problem && (
        <p className="note bad pt-problem" role="alert">
          {problem}
        </p>
      )}
      {none ? (
        <p className="ws-empty pt-none">{NO_SCREENS}. Draw screens on the Screens view, then link them here.</p>
      ) : (
        <PrototypeMap
          data={data}
          tab={tab}
          frame={shown}
          picked={picked}
          busy={busy || working !== null}
          onPick={setPicked}
          onLink={(s, b, v) => void link(s, b, v)}
          onStart={(s) => void change('start', { screen: s })}
          onTab={setTabId}
        />
      )}
      {confirming && (
        <Modal
          title={REPLACE_TITLE}
          onClose={() => setConfirming(false)}
          icon={<Sparkles size={18} />}
          footer={
            <>
              <span className="grow" />
              <button className="btn" autoFocus onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void generate()}>
                Replace the links
              </button>
            </>
          }
        >
          <p>{REPLACE_TEXT}</p>
        </Modal>
      )}
      {playing && data.start && <PrototypePlay data={data} frame={shown} onClose={() => setPlaying(false)} />}
    </div>
  );
}

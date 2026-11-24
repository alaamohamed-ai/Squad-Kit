import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CornerUpLeft, Flag, Link2, Play, Sparkles } from 'lucide-react';
import { api, send } from '../../api/client';
import { Modal } from '../../components/ui';
import { VIEW_SIZES, frameName, sketchKey, sketchesKey } from '../../lib/studio';
import {
  CARD_GAP,
  CARD_W,
  GENERATE,
  NO_APPROVED,
  REPLACE_TEXT,
  REPLACE_TITLE,
  approvedLine,
  linkOf,
  mapArrows,
  mapIsRtl,
  pickValue,
  prototypeKey,
  prototypePath,
  targetOfPick,
  type PrototypeData,
  type ProtoLink,
  type ProtoScreen,
} from '../../lib/studio-prototype';
import { PrototypeFrame } from './PrototypeFrame';
import { PrototypePlay } from './PrototypePlay';

/* ── A sketch's Prototype view (US-54, AB-179.1) ──
   Every approved screen, at the version it was approved at, as a card in the screen order, with the links between them
   as arrows above the cards. A screen that is not approved is not in it. The start screen is marked; "Make start" moves
   the mark. Each card lists the buttons squad-kit found on its drawing: select one (in the list or in the drawing) and
   pick where it leads, a screen, Back or no link. A broken link says why in a short warning. One row above the map holds
   the approved screens, "Generate the prototype" (which asks first when there are links already) and Play.
   Every change sends the sketch's stamp the page read (AB-129.1) and is saved in the sketch's prototype file, so it is
   there after a reload and a teammate gets it through git. Opening the view writes nothing (AB-127.1). */

const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The preview box on a card. */
const PREVIEW = { width: CARD_W - 24, height: 180 };

export function PrototypeView({ project, sketch, frame, onChanged }: { project: string; sketch: string; frame: string | undefined; onChanged(): void }) {
  const key = prototypeKey(project, sketch);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<PrototypeData>(prototypePath(sketch)),
    // While the AI Designer links, the view is read again until it is done.
    refetchInterval: (query) => ((query.state.data as PrototypeData | undefined)?.working ? 1500 : false),
  });
  const data = q.data;
  const [picked, setPicked] = useState<{
    screen: string;
    button: string;
  } | null>(null);
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
  if (!data) return <p className="note pt-note">Reading the prototype…</p>;
  const none = data.screens.length === 0;
  const shown = frame && data.sketch.frames.includes(frame) ? frame : data.sketch.frames[0];

  return (
    <div className="pt">
      <div className="pt-row">
        <p className="pt-line" dir="auto">
          {approvedLine(data)}
        </p>
        <button type="button" className="btn" disabled={none || busy || working !== null} onClick={() => (data.links.length ? setConfirming(true) : void generate())}>
          <Sparkles size={14} /> {working ? 'Generating…' : GENERATE}
        </button>
        <button type="button" className="btn primary" disabled={none || !data.start} onClick={() => setPlaying(true)}>
          <Play size={14} /> Play
        </button>
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
        <p className="ws-empty pt-none">{NO_APPROVED}. Approve screens on the Screens view, then link them here.</p>
      ) : (
        <PrototypeMap data={data} frame={shown} picked={picked} busy={busy || working !== null} onPick={setPicked} onLink={(s, b, v) => void link(s, b, v)} onStart={(s) => void change('start', { screen: s })} />
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

function PrototypeMap({
  data,
  frame,
  picked,
  busy,
  onPick,
  onLink,
  onStart,
}: {
  data: PrototypeData;
  frame: string | undefined;
  picked: { screen: string; button: string } | null;
  busy: boolean;
  onPick(p: { screen: string; button: string } | null): void;
  onLink(screen: string, button: string, value: string): void;
  onStart(screen: string): void;
}) {
  const rtl = mapIsRtl(data.screens);
  const map = mapArrows(data.screens, data.links, rtl);
  return (
    <div className="pt-map" dir={rtl ? 'rtl' : 'ltr'}>
      <div className="pt-canvas" style={{ width: map.width }}>
        {map.height > 0 && (
          <svg className="pt-arrows" width={map.width} height={map.height} aria-hidden="true">
            <defs>
              <marker id="pt-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {map.arrows.map((a) => (
              <g key={`${a.screen}\n${a.button}`} className={picked && picked.screen === a.screen && picked.button === a.button ? 'on' : ''}>
                <path d={a.d} markerEnd="url(#pt-head)" />
                <text x={a.labelX} y={a.labelY} textAnchor="middle" direction={rtl ? 'rtl' : 'ltr'}>
                  {a.button}
                </text>
              </g>
            ))}
          </svg>
        )}
        <ol className="pt-cards" aria-label="Approved screens" style={{ gap: CARD_GAP }}>
          {data.screens.map((s) => (
            <ScreenCard
              key={s.id}
              data={data}
              screen={s}
              frame={frame}
              picked={picked?.screen === s.id ? picked.button : null}
              busy={busy}
              onPick={(b) => onPick(b ? { screen: s.id, button: b } : null)}
              onLink={(b, v) => onLink(s.id, b, v)}
              onStart={() => onStart(s.id)}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

/** The id of a button's picker, so a click on the button in the drawing can move to it. */
const pickerId = (screen: string, i: number) => `pt-pick-${screen}-${i}`;

function ScreenCard({
  data,
  screen: s,
  frame,
  picked,
  busy,
  onPick,
  onLink,
  onStart,
}: {
  data: PrototypeData;
  screen: ProtoScreen;
  frame: string | undefined;
  picked: string | null;
  busy: boolean;
  onPick(button: string | null): void;
  onLink(button: string, value: string): void;
  onStart(): void;
}) {
  const isStart = data.start === s.id;
  const page = frame && s.frames[frame] !== undefined ? frame : Object.keys(s.frames)[0];
  const size = VIEW_SIZES[page ?? 'desktop'] ?? VIEW_SIZES.desktop!;
  const k = Math.min(PREVIEW.width / size.width, PREVIEW.height / size.height);
  const links = data.links.filter((l) => l.screen === s.id);
  const gone = links.filter((l) => l.broken === 'button-gone');
  const others = data.screens.filter((x) => x.id !== s.id);
  const pick = (button: string) => {
    onPick(button);
    const i = s.buttons.findIndex((b) => b.name === button);
    if (i >= 0) document.getElementById(pickerId(s.id, i))?.focus();
  };
  return (
    <li className={`pt-card${isStart ? ' start' : ''}`} style={{ width: CARD_W }} aria-label={s.name} data-screen={s.id}>
      <div className="pt-card-head">
        <strong dir="auto">{s.name}</strong>
        <span className="ws-version locked">v{s.version}</span>
        <span className="grow" />
        {isStart ? (
          <span className="pt-start" title="Play starts here">
            <Flag size={11} /> Start
          </span>
        ) : (
          <button type="button" className="pt-make-start" disabled={busy} onClick={onStart} aria-label={`Make ${s.name} the start screen`}>
            Make start
          </button>
        )}
      </div>
      {/* Always laid out left to right around the frame: the drawing keeps its own direction inside it. */}
      <div className="pt-preview" dir="ltr" style={{ height: PREVIEW.height }}>
        {page ? (
          <div
            style={{
              width: size.width * k,
              height: size.height * k,
              overflow: 'hidden',
            }}
          >
            <PrototypeFrame
              html={s.frames[page]!}
              title={`${s.name}, ${page}`}
              className="pt-frame"
              on={links.filter((l) => !l.broken).map((l) => l.button)}
              broken={links.filter((l) => l.broken).map((l) => l.button)}
              picked={picked}
              onButton={pick}
              frameProps={{
                style: {
                  width: size.width,
                  height: size.height,
                  transform: `scale(${k})`,
                  transformOrigin: '0 0',
                },
                tabIndex: -1,
              }}
            />
          </div>
        ) : (
          <p className="note">No drawing</p>
        )}
      </div>
      {page && frame && page !== frame && (
        <p className="pt-only">
          No {frameName(frame)} page: showing {frameName(page)}.
        </p>
      )}
      {s.buttons.length === 0 && !gone.length ? (
        <p className="pt-only">No buttons or links on this screen.</p>
      ) : (
        <ul className="pt-buttons" aria-label={`Buttons on ${s.name}`}>
          {s.buttons.map((b, i) => {
            const l = linkOf(data.links, s.id, b.name);
            return (
              <ButtonRow
                key={b.name}
                id={pickerId(s.id, i)}
                screen={s}
                name={b.name}
                note={frame && !b.frames.includes(frame) ? `${b.frames.map(frameName).join(', ')} only` : null}
                link={l}
                others={others}
                left={data.left}
                picked={picked === b.name}
                busy={busy}
                onPick={() => onPick(picked === b.name ? null : b.name)}
                onLink={(v) => onLink(b.name, v)}
              />
            );
          })}
          {gone.map((l) => (
            <li key={`gone:${l.button}`} className="pt-btn broken">
              <span className="pt-btn-name gone" dir="auto">
                {l.button}
              </span>
              <button type="button" className="pt-unlink" disabled={busy} onClick={() => onLink(l.button, '')}>
                Take the link away
              </button>
              <span className="pt-warn" role="note">
                <AlertTriangle size={12} /> {l.warning}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ButtonRow({
  id,
  screen,
  name,
  note,
  link,
  others,
  left,
  picked,
  busy,
  onPick,
  onLink,
}: {
  id: string;
  screen: ProtoScreen;
  name: string;
  note: string | null;
  link: ProtoLink | undefined;
  others: ProtoScreen[];
  left: { id: string; name: string }[];
  picked: boolean;
  busy: boolean;
  onPick(): void;
  onLink(value: string): void;
}) {
  const value = pickValue(link);
  const offTarget = link?.broken === 'screen-off' && 'screen' in link.to ? link.to.screen : null;
  return (
    <li className={`pt-btn${picked ? ' on' : ''}${link?.broken ? ' broken' : ''}`}>
      <button type="button" className="pt-btn-name" aria-pressed={picked} onClick={onPick} dir="auto" title={`Select ${name}`}>
        {link && !link.broken ? 'back' in link.to ? <CornerUpLeft size={12} aria-hidden /> : <Link2 size={12} aria-hidden /> : null}
        <span dir="auto">{name}</span>
        {note && <span className="pt-btn-note">{note}</span>}
      </button>
      <select id={id} aria-label={`${name} on ${screen.name} leads to`} value={value} disabled={busy} onChange={(e) => onLink(e.target.value)} onFocus={() => !picked && onPick()}>
        <option value="">No link</option>
        <option value="back">Back</option>
        {others.map((x) => (
          <option key={x.id} value={`screen:${x.id}`}>
            {x.name}
          </option>
        ))}
        {offTarget && (
          <option value={value} disabled>
            {left.find((x) => x.id === offTarget)?.name ?? offTarget} (not approved)
          </option>
        )}
      </select>
      {link?.warning && (
        <span className="pt-warn" role="note">
          <AlertTriangle size={12} /> {link.warning}
        </span>
      )}
    </li>
  );
}

import { useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { send } from '../../api/client';
import { VIEW_SIZES, chatsPath, frameLabel, type ConversationData } from '../../lib/studio';
import { useRevealed } from '../../lib/studio-reveal';
import { saveAnywayPath, type ChatDraftView, type DraftsView } from '../../lib/studio-work';
import { FittedFrame } from './VariantCards';

/* ── The AI Designer's frames on the page (US-57, AB-182.1) ──
   When an ask draws several variants or screens, each one gets an empty frame at once (A, B, C), marked "Waiting" or
   "Drawing"; as each one finishes, its drawing shows in its frame, before the one save at the end. While an existing
   screen is changed, its current drawing is dimmed and marked "Redrawing" with the step it is on, until the new one is
   ready. Drawings that could not save stay here marked "Not saved", with "Save them anyway". The marks stay in English
   like the rest of the board. */

const MARKS: Record<ChatDraftView['state'], string> = { waiting: 'Waiting', drawing: 'Drawing', done: 'Drawn', stopped: 'Stopped' };

export interface DraftFramesProps {
  view: DraftsView;
  drafts: ChatDraftView[];
  frame: string;
  /** The sketch, the conversation and the stamp the page read: "Save them anyway" saves with them. */
  sketch: string;
  chat: string | null;
  stamp: string;
  /** What the page shows now: dimmed under "Redrawing" while the screen is changed. */
  children?: ReactNode;
  onSaved: (c: ConversationData) => void;
}

/** A page at its full size in the workspace, sealed (no scripts): it reveals the first time a watched drawing shows. */
export function PageFrame({ html, frame, title }: { html: string; frame: string; title: string }) {
  const shown = useRevealed(html);
  return <iframe className={`ws-frame ${frame}`} title={title} sandbox="" srcDoc={shown} />;
}

function SaveAnyway({ sketch, chat, stamp, unsaved, onSaved }: { sketch: string; chat: string | null; stamp: string; unsaved: string; onSaved: (c: ConversationData) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    if (!chat) return;
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await send<ConversationData>(saveAnywayPath(chatsPath('sketch', sketch), chat, unsaved), 'POST', { stamp }));
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="df-bar" role="status">
      <span className="df-mark not-saved">Not saved</span>
      <span className="df-why">Changed elsewhere while the AI Designer drew. The other version stays in the history.</span>
      <button type="button" className="primary" disabled={busy || !chat} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save them anyway'}
      </button>
      {problem && (
        <span className="note bad" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

/** An empty frame at the frame's own shape, while its drawing waits or is drawn. */
function BlankFrame({ frame, drawing }: { frame: string; drawing: boolean }) {
  const size = VIEW_SIZES[frame] ?? VIEW_SIZES.desktop!;
  return (
    <div className={`df-blank ${frame}${drawing ? ' drawing' : ''}`} style={{ aspectRatio: `${size.width} / ${size.height}` }} aria-hidden>
      <i />
      <i />
      <i />
    </div>
  );
}

export function DraftFrames({ view, drafts, frame, sketch, chat, stamp, children, onSaved }: DraftFramesProps) {
  const notSaved = view.state === 'not-saved';
  const bar = notSaved && view.unsaved ? <SaveAnyway sketch={sketch} chat={chat} stamp={stamp} unsaved={view.unsaved} onSaved={onSaved} /> : null;

  // An existing screen changed: its current drawing, dimmed and marked, until the new one is ready.
  if (drafts.length === 1 && drafts[0]!.redraw) {
    const d = drafts[0]!;
    const html = d.state === 'done' ? d.pages?.[frame] : undefined;
    if (html !== undefined)
      return (
        <div className="dfs">
          {bar}
          <PageFrame key={d.key} html={html} frame={frame} title={`${d.name}, ${frame}`} />
        </div>
      );
    return (
      <div className="df-redraw" aria-busy={!notSaved}>
        <p className="df-redraw-mark" role="status">
          <RefreshCw size={13} aria-hidden /> <strong>Redrawing</strong>
          {view.step && (
            <span className="df-step" dir="auto">
              {d.state === 'waiting' ? 'Waiting' : view.step}
            </span>
          )}
        </p>
        <div className="df-dim">{children}</div>
      </div>
    );
  }

  return (
    <div className="vc dfs">
      {bar}
      <ul className="vc-cards" aria-label={drafts[0]?.letter ? `Variants of ${drafts[0].name} being drawn` : 'Screens being drawn'} style={{ gridTemplateColumns: `repeat(${drafts.length}, minmax(150px, 1fr))` }}>
        {drafts.map((d) => {
          const html = d.state === 'done' ? d.pages?.[frame] : undefined;
          const title = d.letter ? `Variant ${d.letter}${d.variantName ? ` · ${d.variantName}` : ''}` : d.name;
          const mark = notSaved ? 'Not saved' : MARKS[d.state];
          return (
            <li key={d.key} className={`vc-card df-card ${d.state}`} aria-label={title}>
              <header className="vc-head">
                <strong dir="auto">{title}</strong>
                {(notSaved || d.state !== 'done') && <span className={`df-mark ${notSaved ? 'not-saved' : d.state}`}>{mark}</span>}
              </header>
              {d.state === 'done' ? (
                <FittedFrame key={`${d.key}:${frame}`} html={html} frame={frame} title={`${title}, ${frame}`} empty={`No ${frameLabel(frame)} page in this drawing.`} />
              ) : (
                <BlankFrame frame={frame} drawing={d.state === 'drawing'} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

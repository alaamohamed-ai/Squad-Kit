import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { send } from '../../api/client';
import { VIEW_SIZES, frameLabel, isColorValue, pickPath, sealedHtml, warningText, type PickAnswer, type VariantCard } from '../../lib/studio';

/* ── Variants side by side (US-17, US-18) ──
   When the screen's chosen variant came from an ask, that ask's variants show as cards side by side: A, B, C, each with
   its short name, its idea, its drawing in the picked frame, and "Using this one", or "Not chosen" with "Use this one".
   A card whose pages use what the design system lacks says so, naming each value; one drawn with no design system says
   "No design system". "Use this one" saves the pick with the sketch's stamp the page read (AB-129.1), and its line goes
   to the conversation open beside it (AB-143.1); a stale stamp is refused with "Changed elsewhere, reload" and the pick
   in use stays. The buttons wait while the AI Designer works, and are off while the screen is approved (US-15). What the cards show is what was saved: nothing is
   checked again on the page. */

export interface VariantCardsProps {
  sketch: string;
  screen: { id: string; name: string };
  frame: string;
  cards: VariantCard[];
  /** The sketch's stamp, as the page read it. */
  stamp: string;
  /** The conversation open in the chat beside the cards: the pick line goes there. */
  chat?: string | null;
  /** The AI Designer is working: the buttons wait. */
  working?: boolean;
  /** The screen is approved (US-15): "Use this one" is off until it is reopened. */
  locked?: boolean;
  /** A pick was saved: the page reads the sketch again, and the chat shows the conversation it answered with. */
  onPicked: (answer: PickAnswer) => void;
}

export function VariantCards({ sketch, screen, frame, cards, stamp, chat, working = false, locked = false, onPicked }: VariantCardsProps) {
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const use = async (version: number) => {
    setBusy(version);
    setProblem(null);
    try {
      const answer = await send<PickAnswer>(pickPath(sketch, screen.id), 'POST', { version, stamp, ...(chat ? { chat } : {}) });
      onPicked(answer);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="vc">
      {problem && (
        <p className="note bad vc-problem" role="alert">
          {problem}
        </p>
      )}
      <ul className="vc-cards" aria-label={`Variants of ${screen.name}`} style={{ gridTemplateColumns: `repeat(${cards.length}, minmax(150px, 1fr))` }}>
        {cards.map((c) => (
          <li key={c.letter} className={`vc-card${c.using ? ' using' : ''}`} aria-label={`Variant ${c.letter} · ${c.name}`}>
            <header className="vc-head">
              <span className={`vc-dot${c.using ? ' on' : ''}`} aria-hidden />
              <strong dir="auto">
                Variant {c.letter} · {c.name}
              </strong>
              {c.using ? (
                <span className="vc-using">
                  <Check size={14} aria-hidden /> Using this one
                </span>
              ) : (
                <>
                  <span className="vc-not">Not chosen</span>
                  <button
                    type="button"
                    className="vc-use"
                    disabled={busy !== null || working || locked}
                    title={locked ? `${screen.name} is approved. Reopen it first.` : working ? 'Wait for the AI Designer to finish, then pick' : undefined}
                    aria-label={`Use this one: Variant ${c.letter} · ${c.name}`}
                    onClick={() => void use(c.version)}
                  >
                    {busy === c.version ? 'Saving…' : 'Use this one'}
                  </button>
                </>
              )}
            </header>
            {c.idea && (
              <p className="vc-idea" dir="auto">
                {c.idea}
              </p>
            )}
            {c.noDesignSystem && <span className="vc-plain">No design system</span>}
            {c.warnings.length > 0 && (
              <p className="vc-warn" role="note">
                <AlertTriangle size={14} aria-hidden />
                <span>
                  {c.warnings.some((w) => w.kind === 'color') && (
                    <span className="vc-swatches" aria-hidden>
                      {c.warnings
                        .filter((w) => w.kind === 'color' && (isColorValue(w.value) || /^[a-z]{3,20}$/i.test(w.value)))
                        .map((w) => (
                          <i key={w.value} style={{ background: w.value }} />
                        ))}
                    </span>
                  )}
                  {warningText(c.warnings, c.checkedWith?.name ?? 'the design system')}
                </span>
              </p>
            )}
            <FittedFrame html={c.html[frame]} frame={frame} title={`Variant ${c.letter}, ${c.name}, ${frame}`} empty={`No ${frameLabel(frame)} page in this variant.`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A page drawn at its frame's real width, made small to fit its card, in a sealed frame: no scripts and no network. */
function FittedFrame({ html, frame, title, empty }: { html: string | undefined; frame: string; title: string; empty: string }) {
  const size = VIEW_SIZES[frame] ?? VIEW_SIZES.desktop!;
  const watch = useRef<ResizeObserver | null>(null);
  const fit = useCallback(
    (el: HTMLElement | null) => {
      watch.current?.disconnect();
      watch.current = null;
      if (!el) return;
      const set = () => el.style.setProperty('--s', String(Math.max(0.1, Math.min(1, el.clientWidth / size.width))));
      set();
      if (typeof ResizeObserver === 'undefined') return;
      watch.current = new ResizeObserver(set);
      watch.current.observe(el);
    },
    [size.width],
  );
  if (html === undefined) return <p className="vc-empty">{empty}</p>;
  return (
    <div className={`vc-view ${frame}`} ref={fit} style={{ ['--w' as string]: `${size.width}px`, ['--h' as string]: `${size.height}px` }}>
      <iframe title={title} sandbox="" srcDoc={sealedHtml(html)} referrerPolicy="no-referrer" />
    </div>
  );
}

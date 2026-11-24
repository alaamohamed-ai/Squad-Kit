import { useEffect, useRef } from 'react';
import { sealedHtml } from '../../lib/studio';
import { BUTTON_MARK } from '../../lib/studio-prototype';

/* ── One drawing of the prototype, with its buttons clickable (US-54) ──
   The drawing is written into a frame that runs no scripts and, through the sealed page's policy, reaches no network
   (as the cards are drawn). The frame shares this page's origin only so the board can hear a click on a marked button
   (data-sq-button="<name>") and mark the buttons: the drawing itself still runs nothing. Every click in it is stopped,
   so no link in a drawing ever opens a page. `on` buttons show they can be clicked; the `picked` one is outlined. */

/** In Play only the linked buttons show they can be clicked, with the hand: the drawing looks as a user would see it. */
const PLAY_STYLE = '<style>[data-sq-on]{cursor:pointer}</style>';
const MARKS_STYLE = `<style>[${BUTTON_MARK}]{cursor:pointer}[data-sq-on]{outline:2px solid rgba(37,99,235,.55);outline-offset:2px;border-radius:6px}[data-sq-broken]{outline:2px dashed rgba(220,38,38,.7);outline-offset:2px}[data-sq-picked]{outline:3px solid #2563eb!important;outline-offset:3px;border-radius:6px}</style>`;

interface Element0 {
  getAttribute(name: string): string | null;
  toggleAttribute(name: string, on: boolean): void;
  closest?(selector: string): Element0 | null;
}

/** The marked button a click landed in, or null. The frame's elements come from another window, so no instanceof. */
function markedButton(target: unknown): Element0 | null {
  return (target as Element0 | null)?.closest?.(`[${BUTTON_MARK}]`) ?? null;
}

export function PrototypeFrame({
  html,
  title,
  className,
  on = [],
  broken = [],
  picked,
  play = false,
  onButton,
  onEscape,
  frameProps,
}: {
  html: string;
  title: string;
  className?: string;
  /** The buttons that show they can be clicked. */
  on?: string[];
  /** The buttons whose link is broken. */
  broken?: string[];
  picked?: string | null;
  /** Play: no outlines, only the hand on the linked buttons. */
  play?: boolean;
  /** A click on a marked button, by its name. */
  onButton?(name: string): void;
  /** Esc pressed while the drawing has the focus. */
  onEscape?(): void;
  frameProps?: Record<string, unknown>;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const clicked = useRef(onButton);
  clicked.current = onButton;
  const escaped = useRef(onEscape);
  escaped.current = onEscape;

  useEffect(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    doc.open();
    const style = play ? PLAY_STYLE : MARKS_STYLE;
    doc.write(sealedHtml(html).replace(/<\/head>/i, `${style}</head>`) + (/<\/head>/i.test(html) ? '' : style));
    doc.close();
    const click = (e: Event) => {
      e.preventDefault();
      const el = markedButton(e.target);
      const name = el?.getAttribute(BUTTON_MARK);
      if (name) clicked.current?.(name);
    };
    const submit = (e: Event) => e.preventDefault();
    const key = (e: Event) => (e as KeyboardEvent).key === 'Escape' && escaped.current?.();
    doc.addEventListener('click', click, true);
    doc.addEventListener('submit', submit, true);
    doc.addEventListener('keydown', key, true);
    return () => {
      doc.removeEventListener('click', click, true);
      doc.removeEventListener('submit', submit, true);
      doc.removeEventListener('keydown', key, true);
    };
  }, [html, play]);

  const onKey = on.join('\n');
  const brokenKey = broken.join('\n');
  useEffect(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    for (const el of Array.from(doc.querySelectorAll(`[${BUTTON_MARK}]`)) as unknown as Element0[]) {
      const name = el.getAttribute(BUTTON_MARK) ?? '';
      el.toggleAttribute('data-sq-on', on.includes(name));
      el.toggleAttribute('data-sq-broken', broken.includes(name));
      el.toggleAttribute('data-sq-picked', name === picked);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, onKey, brokenKey, picked]);

  return <iframe ref={ref} className={className} title={title} sandbox="allow-same-origin" {...frameProps} />;
}

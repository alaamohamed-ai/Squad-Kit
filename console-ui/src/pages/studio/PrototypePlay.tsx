import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { frameName } from '../../lib/studio';
import { linkOf, playStep, workingButtons, type PrototypeData } from '../../lib/studio-prototype';
import { PrototypeFrame } from './PrototypeFrame';

/* ── Play (US-54) ──
   The start screen opens full size, as a user would see it. A click on a button with a working link goes to its screen;
   a Back link goes to the screen before. A broken link, or a button with no link, does nothing. Desktop and Mobile
   switch while playing, on the same screen. Esc or Close leaves Play, back to the Prototype view. A right-to-left
   screen plays right to left, as it was drawn. Play only reads: it saves nothing. */

export function PrototypePlay({ data, frame: first, onClose }: { data: PrototypeData; frame: string | undefined; onClose(): void }) {
  const [history, setHistory] = useState<string[]>(() => [data.start ?? data.screens[0]!.id]);
  const [frame, setFrame] = useState(first ?? data.sketch.frames[0]);
  const current = data.screens.find((s) => s.id === history[history.length - 1]) ?? data.screens[0]!;
  const page = frame && current.frames[frame] !== undefined ? frame : Object.keys(current.frames)[0]!;
  const close = useRef<HTMLButtonElement>(null);
  const leave = useRef(onClose);
  leave.current = onClose;

  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && leave.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const click = (button: string) => {
    const next = playStep(history, linkOf(data.links, current.id, button));
    if (next) setHistory(next);
  };

  return createPortal(
    <div className="pp" role="dialog" aria-modal="true" aria-label={`Play ${data.sketch.name}`}>
      <div className="pp-bar">
        <strong dir="auto">{data.sketch.name}</strong>
        <span className="pp-screen" dir="auto" aria-live="polite">
          {current.name}
        </span>
        <span className="grow" />
        {data.sketch.frames.length > 1 && (
          <div className="seg" role="tablist" aria-label="Frames">
            {data.sketch.frames.map((f) => (
              <button key={f} role="tab" aria-selected={f === frame} className={f === frame ? 'on' : ''} onClick={() => setFrame(f)}>
                {frameName(f)}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="btn pp-close" ref={close} onClick={onClose}>
          <X size={14} /> Close
        </button>
      </div>
      <div className={`pp-stage ${page}`} dir={current.rtl ? 'rtl' : 'ltr'}>
        <PrototypeFrame
          key={`${current.id}:${page}`}
          html={current.frames[page]!}
          title={`${current.name}, ${frameName(page)}`}
          className={`pp-frame ${page}`}
          on={workingButtons(data.links, current.id)}
          play
          onButton={click}
          onEscape={() => leave.current()}
        />
      </div>
    </div>,
    document.body,
  );
}

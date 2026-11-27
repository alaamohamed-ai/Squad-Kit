import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { frameName } from '../../lib/studio';
import { linkOf, playStep, switchTab, tabOf, tabScreens, workingButtons, type PrototypeData } from '../../lib/studio-prototype';
import { PrototypeFrame } from './PrototypeFrame';
import { PrototypeTabs } from './PrototypeMap';

/* ── Play (US-54, US-58) ──
   It opens on "In use", at the tab's start screen, full size, as a user would see it. The tabs for the whole flow sit at
   the top ("In use", "Option A" …) on every screen, as the person asked: there is no per-screen switch. The tab picked
   stays for the whole flow, so coming back to a screen shows the same option. Switching tab keeps the same screen when
   it is in the new tab, else goes to that tab's start screen. A click on a button with
   a link working on this tab goes to its screen; a Back link goes to the screen before that is in the tab. A broken link, or a button with no link, does nothing. Desktop and Mobile switch
   while playing, on the same screen. Esc or Close leaves Play, back to the Prototype view. A right-to-left screen plays
   right to left, as it was drawn. Play shows no approval mark, and only reads: the tab picked is never saved, so
   the variant in use in the sketch stays as it was. */

export function PrototypePlay({ data, frame: first, onClose }: { data: PrototypeData; frame: string | undefined; onClose(): void }) {
  const [tabId, setTabId] = useState(data.tabs[0]!.id);
  const tab = tabOf(data, tabId);
  const shown = tabScreens(data, tab);
  const [history, setHistory] = useState<string[]>(() => [tab.start ?? shown[0]!.screen.id]);
  const [frame, setFrame] = useState(first ?? data.sketch.frames[0]);
  const current = shown.find((x) => x.screen.id === history[history.length - 1]) ?? shown[0]!;
  const { screen, drawing } = current;
  const page = frame && drawing.frames[frame] !== undefined ? frame : Object.keys(drawing.frames)[0]!;
  const close = useRef<HTMLButtonElement>(null);
  const leave = useRef(onClose);
  leave.current = onClose;

  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && leave.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const inTab = (id: string) => tab.screens.some((s) => s.id === id);
  const click = (button: string) => {
    const next = playStep(history, linkOf(tab.links, screen.id, button), inTab);
    if (next) setHistory(next);
  };
  const pickTab = (id: string) => {
    setTabId(id);
    setHistory((h) => switchTab(h, tabOf(data, id)));
  };

  return createPortal(
    <div className="pp" role="dialog" aria-modal="true" aria-label={`Play ${data.sketch.name}`}>
      <div className="pp-bar">
        <strong dir="auto">{data.sketch.name}</strong>
        <span className="pp-screen" dir="auto" aria-live="polite">
          {screen.name}
        </span>
        <PrototypeTabs tabs={data.tabs} picked={tab.id} onPick={pickTab} />
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
      <div className={`pp-stage ${page}`} dir={drawing.rtl ? 'rtl' : 'ltr'}>
        <PrototypeFrame
          key={`${screen.id}:${drawing.version}:${page}`}
          html={drawing.frames[page]!}
          title={`${screen.name}, ${frameName(page)}`}
          className={`pp-frame ${page}`}
          on={workingButtons(tab.links, screen.id)}
          play
          onButton={click}
          onEscape={() => leave.current()}
        />
      </div>
    </div>,
    document.body,
  );
}

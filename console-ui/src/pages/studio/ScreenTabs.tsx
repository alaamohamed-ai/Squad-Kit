import { useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { send } from '../../api/client';
import { Modal } from '../../components/ui';
import { addScreenStamp, deleteScreenQuestion, screenApiPath, screensPath, tabAfterDelete, type ScreenView, type SketchFull } from '../../lib/studio';

/* ── The screen tabs of a sketch (US-11, AB-136) ──
   One tab per screen, then "+ Add screen". Add screen makes "New screen" (then "New screen 2" …) at once, with no form,
   and selects it: the AI Designer's first drawing of it, from the chat, gives it a name (AB-136.1). Each tab has a
   Delete that asks first, naming the screen. Both send the sketch's stamp the page read (AB-129.1), so a change made
   elsewhere since is refused with "Changed elsewhere, reload". The selected tab stays in this browser tab (AB-127.1).
   `squad studio sketch screen add|delete` do the same from the terminal. */

const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ScreenTabs({
  sketch,
  screens,
  selected,
  onSelect,
  onChanged,
}: {
  sketch: Pick<SketchFull, 'id' | 'stamp'>;
  screens: ScreenView[];
  selected: string | undefined;
  onSelect(screen: string | undefined): void;
  /** Reads the sketch again after a change, or a refusal. */
  onChanged(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ScreenView | null>(null);
  // The stamp an add answered with, until the sketch is read again: a second click before then brings it, so it adds
  // "New screen 2" instead of being refused with "Changed elsewhere, reload".
  const answered = useRef<{ read: string; now: string } | null>(null);

  const add = async () => {
    setBusy(true);
    setProblem(null);
    const read = sketch.stamp;
    const stamp = addScreenStamp(read, answered.current);
    try {
      const r = await send<{ added: string; stamp: string }>(screensPath(sketch.id), 'POST', { stamp });
      answered.current = { read, now: r.stamp };
      onSelect(r.added);
    } catch (err) {
      setProblem(said(err));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <>
      <div className="ws-tabs" role="tablist" aria-label="Screens">
        {screens.map((x) => (
          <span key={x.id} className="ws-tab" role="presentation">
            <button role="tab" aria-selected={x.id === selected} dir="auto" onClick={() => onSelect(x.id)}>
              {x.name}
            </button>
            <button
              type="button"
              className="ws-tab-del"
              aria-label={`Delete ${x.name}`}
              title={`Delete ${x.name}`}
              onClick={() => {
                setProblem(null);
                setDeleting(x);
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <button type="button" className="ws-add" disabled={busy} onClick={() => void add()}>
        <Plus size={14} /> Add screen
      </button>
      {problem && (
        <span className="note bad ws-problem" role="alert">
          {problem}
        </span>
      )}
      {deleting && (
        <DeleteScreenDialog
          sketch={sketch}
          screen={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            if (deleting.id === selected) onSelect(tabAfterDelete(screens, deleting.id));
            onChanged();
          }}
          onRefused={onChanged}
        />
      )}
    </>
  );
}

/** Delete's confirmation on a screen's tab: names the screen. Cancel changes nothing. */
function DeleteScreenDialog({
  sketch,
  screen,
  onClose,
  onDone,
  onRefused,
}: {
  sketch: Pick<SketchFull, 'id' | 'stamp'>;
  screen: ScreenView;
  onClose(): void;
  onDone(): void;
  onRefused(): void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = deleteScreenQuestion(screen.name);
  const remove = async () => {
    setBusy(true);
    try {
      await send(screenApiPath(sketch.id, screen.id), 'DELETE', { stamp: sketch.stamp });
      onDone();
      onClose();
    } catch (err) {
      setProblem(said(err));
      // A change elsewhere: read again, so the next try brings the new stamp.
      onRefused();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={ask.title}
      onClose={onClose}
      icon={<Trash2 size={18} className="sk-del-icon" />}
      footer={
        <>
          <span className="grow" />
          <button className="btn" autoFocus onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
        </>
      }
    >
      <p>{ask.holds}</p>
      {problem && (
        <p className="note bad" role="alert">
          {problem}
        </p>
      )}
    </Modal>
  );
}

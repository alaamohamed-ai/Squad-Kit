import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Lock, Plus, Trash2, X } from 'lucide-react';
import { send } from '../../api/client';
import { Modal } from '../../components/ui';
import { addScreenStamp, approvedByText, deleteScreenQuestion, screenApiPath, screensPath, tabAfterDelete, type ScreenView, type SketchFull } from '../../lib/studio';

/* ── The screen tabs of a sketch (US-11, AB-136) ──
   One tab per screen, then "+ Add screen". Add screen makes "New screen" (then "New screen 2" …) at once, with no form,
   and selects it: the AI Designer's first drawing of it, from the chat, gives it a name (AB-136.1). Each tab has a
   Delete that asks first, naming the screen. Both send the sketch's stamp the page read (AB-129.1), so a change made
   elsewhere since is refused with "Changed elsewhere, reload". The selected tab stays in this browser tab (AB-127.1).
   An approved screen's tab shows a lock, and its Delete is off until it is reopened (US-15).
   The tabs stay on one row (US-53): each is one pill with its name, cut with … and shown in full on hover, and its ×.
   The row scrolls sideways; "All screens" and Add screen stay visible at its end.
   `squad studio sketch screen add|delete` do the same from the terminal. */

const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Scrolls only the row of tabs, never the page around it, until the tab is fully in view, with a little room. A tab
 * already in view stays where it is.
 */
function revealTab(row: HTMLElement, tab: HTMLElement): void {
  const r = row.getBoundingClientRect();
  const t = tab.getBoundingClientRect();
  const left = t.left < r.left ? t.left - r.left - 8 : t.right > r.right ? t.right - r.right + 8 : 0;
  if (left) row.scrollBy?.({ left });
}

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

  // The selected tab, and a screen just added, scroll into view in the row (US-53). Read again when the tabs change, so a
  // new screen's tab is found once the sketch is read with it.
  const row = useRef<HTMLDivElement>(null);
  const ids = screens.map((x) => x.id).join('\n');
  // A pick from "All screens" scrolls its tab into view even when it was already the selected one.
  const [reveal, setReveal] = useState(0);
  useEffect(() => {
    if (!selected || !row.current) return;
    const tab = [...row.current.querySelectorAll<HTMLElement>('.ws-tab')].find((t) => t.dataset.screen === selected);
    if (tab) revealTab(row.current, tab);
  }, [selected, ids, reveal]);

  return (
    <>
      {/* One row that never wraps: the tabs scroll sideways; the list of all screens and Add screen stay at its end. */}
      <div className="ws-tabrow">
        <div className="ws-tabs" role="tablist" aria-label="Screens" ref={row}>
          {screens.map((x) => (
            <span key={x.id} className="ws-tab" role="presentation" data-screen={x.id}>
              <button role="tab" aria-selected={x.id === selected} title={x.status === 'approved' ? `${x.name} · ${approvedByText(x.approved)}` : x.name} onClick={() => onSelect(x.id)}>
                {x.status === 'approved' && <Lock size={11} className="ws-tab-lock" aria-label="Approved" />}
                <span className="ws-tab-name" dir="auto">
                  {x.name}
                </span>
              </button>
              <button
                type="button"
                className="ws-tab-del"
                aria-label={`Delete ${x.name}`}
                // An approved screen is not deleted until it is reopened (US-15).
                disabled={x.status === 'approved'}
                title={x.status === 'approved' ? `${x.name} is approved. Reopen it first.` : `Delete ${x.name}`}
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
        <span className="ws-tabs-div" aria-hidden="true" />
        <AllScreens
          screens={screens}
          selected={selected}
          onSelect={(x) => {
            onSelect(x);
            setReveal((n) => n + 1);
          }}
        />
        <button type="button" className="ws-add" disabled={busy} onClick={() => void add()}>
          <Plus size={14} /> Add screen
        </button>
      </div>
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

/**
 * "All screens" at the end of the row: every screen in tab order, with the lock an approved one has on its tab. Only for
 * picking: no Delete here. Picking one selects it, and its tab scrolls into view.
 */
function AllScreens({ screens, selected, onSelect }: { screens: ScreenView[]; selected: string | undefined; onSelect(screen: string): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <span className="more ws-all" ref={ref}>
      <button type="button" className="ws-all-btn" aria-label="All screens" aria-haspopup="menu" aria-expanded={open} title="All screens" disabled={!screens.length} onClick={() => setOpen(!open)}>
        <ChevronDown size={15} aria-hidden />
      </button>
      {open && (
        <div className="more-menu ws-all-menu" role="menu" aria-label="All screens">
          {screens.map((x) => (
            <button
              key={x.id}
              type="button"
              role="menuitem"
              aria-current={x.id === selected ? 'true' : undefined}
              title={x.status === 'approved' ? `${x.name} · ${approvedByText(x.approved)}` : x.name}
              onClick={() => {
                setOpen(false);
                onSelect(x.id);
              }}
            >
              {x.status === 'approved' && <Lock size={11} className="ws-tab-lock" aria-label="Approved" />}
              <span className="ws-tab-name" dir="auto">
                {x.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
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

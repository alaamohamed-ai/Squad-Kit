import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Ellipsis, PenLine, Trash2 } from 'lucide-react';
import { send } from '../../api/client';
import { Modal } from '../../components/ui';
import { deleteQuestion, designSystemsKey, duplicatePath, sketchApiPath, sketchKey, sketchesKey, type DeletedSketch } from '../../lib/studio';

/* ── Rename, Duplicate and Delete a sketch (US-13, AB-138) ──
   The card's ⋯ menu and the name in the sketch's header. Each sends the stamp it read (AB-129.1), so a change made
   elsewhere since is refused with "Changed elsewhere, reload"; a name another sketch uses is refused in the server's
   own words (AB-138.1). The lists are read again after each, so the cards and the header show what is saved. The
   `squad studio sketch` commands do the same. */

/** What the card and the header know about a sketch. */
export interface SketchAbout {
  id: string;
  name: string;
  stamp: string;
  screens: number;
}

/** Reads the sketch lists again after a change, and the sketch itself when it is still there. */
function useRefresh(project: string) {
  const qc = useQueryClient();
  return (id: string, gone = false) => {
    void qc.invalidateQueries({ queryKey: sketchesKey(project) });
    void qc.invalidateQueries({ queryKey: designSystemsKey(project) });
    if (gone) qc.removeQueries({ queryKey: sketchKey(project, id) });
    else void qc.invalidateQueries({ queryKey: sketchKey(project, id) });
  };
}

const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Saves a new name with the stamp it read. Throws the server's words when it is refused. */
export function renameSketch(id: string, name: string, stamp: string) {
  return send(sketchApiPath(id), 'PATCH', { name, stamp });
}

/**
 * The ⋯ menu on a sketch's card: Rename (a small box with the name), Duplicate, and Delete (a confirmation naming the
 * sketch and its screens). A refusal shows through `onProblem`, in the server's words.
 */
export function SketchCardMenu({ project, sketch, onProblem }: { project: string; sketch: SketchAbout; onProblem(text: string | null): void }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useRefresh(project);
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
  const pick = (then: () => void) => () => {
    setOpen(false);
    onProblem(null);
    then();
  };
  const duplicate = async () => {
    setBusy(true);
    try {
      await send(duplicatePath(sketch.id), 'POST', { stamp: sketch.stamp });
    } catch (err) {
      onProblem(said(err));
    } finally {
      setBusy(false);
      refresh(sketch.id);
    }
  };
  return (
    <span className="more sk-card-more" ref={ref}>
      <button
        className="iconbtn"
        aria-label={`More actions for ${sketch.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis size={16} />
      </button>
      {open && (
        <div className="more-menu" role="menu" aria-label={`${sketch.name} actions`}>
          <button role="menuitem" onClick={pick(() => setDialog('rename'))}>
            <PenLine size={15} /> Rename…
          </button>
          <button role="menuitem" onClick={pick(() => void duplicate())}>
            <Copy size={15} /> Duplicate
          </button>
          <button role="menuitem" className="danger" onClick={pick(() => setDialog('delete'))}>
            <Trash2 size={15} /> Delete…
          </button>
        </div>
      )}
      {dialog === 'rename' && <RenameDialog sketch={sketch} onClose={() => setDialog(null)} onDone={() => refresh(sketch.id)} />}
      {dialog === 'delete' && <DeleteDialog sketch={sketch} onClose={() => setDialog(null)} onDone={(gone) => refresh(sketch.id, gone)} />}
    </span>
  );
}

/** Rename from the card: a small box with the name. A refused name keeps the box open with the reason. */
function RenameDialog({ sketch, onClose, onDone }: { sketch: SketchAbout; onClose(): void; onDone(): void }) {
  const [name, setName] = useState(sketch.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return setProblem('Give the sketch a name.');
    if (name.trim() === sketch.name) return onClose();
    setBusy(true);
    try {
      await renameSketch(sketch.id, name.trim(), sketch.stamp);
      onDone();
      onClose();
    } catch (err) {
      setProblem(said(err));
      // A change elsewhere: read again, so the next try brings the new stamp.
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Rename "${sketch.name}"`}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy} onClick={() => void save()}>
            Rename
          </button>
        </>
      }
    >
      <form onSubmit={(e) => void save(e)}>
        <label className="sk-rename">
          <span>Name</span>
          <input
            className="input"
            autoFocus
            dir="auto"
            maxLength={120}
            value={name}
            aria-invalid={problem !== null}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
            onFocus={(e) => e.target.select()}
          />
        </label>
        {problem && (
          <p className="note bad" role="alert">
            {problem}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** Delete's confirmation: names the sketch and how many screens go with it. Cancel keeps it. */
function DeleteDialog({ sketch, onClose, onDone }: { sketch: SketchAbout; onClose(): void; onDone(gone: boolean): void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = deleteQuestion(sketch.name, sketch.screens);
  const remove = async () => {
    setBusy(true);
    try {
      await send<DeletedSketch>(sketchApiPath(sketch.id), 'DELETE', { stamp: sketch.stamp });
      onDone(true);
      onClose();
    } catch (err) {
      setProblem(said(err));
      onDone(false);
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

/**
 * The sketch's name in its workspace header. A click makes it editable: Enter saves, Escape puts the name back, and
 * leaving the box saves a changed name. A refused name keeps the box open with the reason.
 */
export function SketchNameHeader({ project, sketch }: { project: string; sketch: SketchAbout }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sketch.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useRefresh(project);
  // Set once the box is done with (Enter, Escape), so the blur as it closes saves nothing more.
  const done = useRef(false);
  const start = () => {
    done.current = false;
    setName(sketch.name);
    setProblem(null);
    setEditing(true);
  };
  const cancel = () => {
    done.current = true;
    setEditing(false);
    setProblem(null);
  };
  const save = async () => {
    if (busy || done.current) return;
    const next = name.trim();
    if (!next) return setProblem('Give the sketch a name.');
    if (next === sketch.name) return cancel();
    setBusy(true);
    try {
      await renameSketch(sketch.id, next, sketch.stamp);
      done.current = true;
      setEditing(false);
      setProblem(null);
    } catch (err) {
      setProblem(said(err));
    } finally {
      setBusy(false);
      refresh(sketch.id);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
  if (!editing) {
    return (
      <h1 dir="auto">
        <button type="button" className="sk-name-btn" title="Rename" aria-label={`${sketch.name}, click to rename`} onClick={start}>
          {sketch.name}
        </button>
      </h1>
    );
  }
  return (
    <span className="sk-name-edit">
      <input
        className="input sk-name-input"
        aria-label="Sketch name"
        autoFocus
        dir="auto"
        maxLength={120}
        value={name}
        disabled={busy}
        aria-invalid={problem !== null}
        onChange={(e) => {
          setName(e.target.value);
          setProblem(null);
        }}
        onFocus={(e) => e.target.select()}
        onKeyDown={onKey}
        onBlur={() => {
          if (!problem) void save();
        }}
      />
      {problem && (
        <span className="note bad" role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}

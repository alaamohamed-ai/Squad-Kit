import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Code, Copy, Ellipsis, FileImage, FileText, Image, PenLine, Shapes, Trash2, type LucideIcon } from 'lucide-react';
import { send } from '../../api/client';
import { designSystemsKey, duplicatePath, sketchKey, sketchesKey } from '../../lib/studio';
import { EXPORT_PDF, FUTURE_EXPORTS, MAKING_PDF, exportSketchPdf, type ExportRequest } from '../../lib/studio-export';
import { ExportDialog } from './ExportDialog';
import { DeleteDialog, RenameDialog, type SketchAbout } from './SketchActions';

/* ── A sketch's ⋯ menu (US-13, US-46) ──
   On the sketch's card and in its workspace header. Rename (a small box with the name), Duplicate, and Delete (a
   confirmation naming the sketch and its screens), each with the stamp it read (AB-129.1). Then the Export group:
   "Export sketch to PDF" opens the export window, and PNG, JPG, SVG and HTML are listed off, each with a small "Future"
   label, so clicking them does nothing (US-44, US-45 and US-47 bring them). While the PDF is made, the item says
   "Making the PDF…" and cannot be clicked, on the card and in the header alike; then the file downloads. Exporting
   writes nothing in the project and adds nothing to the chat. */

const FUTURE_ICONS: Record<(typeof FUTURE_EXPORTS)[number], LucideIcon> = { PNG: FileImage, JPG: Image, SVG: Shapes, HTML: Code };

/* The sketches a PDF is being made for, in this tab: the card's menu and the header's menu show the same state. */
const making = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
function setMaking(key: string, on: boolean) {
  if (on) making.add(key);
  else making.delete(key);
  for (const fn of listeners) fn();
}
const useMaking = (key: string) => useSyncExternalStore(subscribe, () => making.has(key));

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

export function SketchMenu({
  project,
  sketch,
  onProblem,
  onDeleted,
  place = 'card',
}: {
  project: string;
  sketch: SketchAbout;
  /** Where a refusal shows, in the server's words. Left out, the menu shows it beside itself. */
  onProblem?(text: string | null): void;
  /** After a delete, for the header: back to the Sketches home. */
  onDeleted?(): void;
  /** On a sketch's card, or in its workspace header, where "Making the PDF…" also shows beside the ⋯ while it lasts. */
  place?: 'card' | 'header';
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'export' | null>(null);
  const [busy, setBusy] = useState(false);
  const [ownProblem, setOwnProblem] = useState<string | null>(null);
  const exporting = useMaking(`${project}\u0000${sketch.id}`);
  const refresh = useRefresh(project);
  const ref = useRef<HTMLSpanElement>(null);
  const problem = (text: string | null) => (onProblem ? onProblem(text) : setOwnProblem(text));
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
    problem(null);
    then();
  };
  const duplicate = async () => {
    setBusy(true);
    try {
      await send(duplicatePath(sketch.id), 'POST', { stamp: sketch.stamp });
    } catch (err) {
      problem(said(err));
    } finally {
      setBusy(false);
      refresh(sketch.id);
    }
  };
  const exportPdf = async (body: ExportRequest) => {
    const key = `${project}\u0000${sketch.id}`;
    if (making.has(key)) return;
    setDialog(null);
    problem(null);
    setMaking(key, true);
    try {
      await exportSketchPdf(sketch, body);
    } catch (err) {
      problem(said(err));
    } finally {
      setMaking(key, false);
    }
  };
  return (
    <span className={`more ${place === 'card' ? 'sk-card-more' : 'sk-head-more'}`} ref={ref}>
      <button className="iconbtn" aria-label={`More actions for ${sketch.name}`} aria-haspopup="menu" aria-expanded={open} title="More actions" disabled={busy} onClick={() => setOpen(!open)}>
        <Ellipsis size={16} />
      </button>
      {open && (
        <div className="more-menu sk-menu" role="menu" aria-label={`${sketch.name} actions`}>
          <button role="menuitem" onClick={pick(() => setDialog('rename'))}>
            <PenLine size={15} /> Rename…
          </button>
          <button role="menuitem" onClick={pick(() => void duplicate())}>
            <Copy size={15} /> Duplicate
          </button>
          <div className="sk-menu-sep" role="separator" />
          <div className="sk-menu-group" role="group" aria-label="Export">
            <span className="sk-menu-label" aria-hidden="true">
              Export
            </span>
            <button role="menuitem" disabled={exporting} aria-disabled={exporting || undefined} onClick={exporting ? undefined : pick(() => setDialog('export'))}>
              <FileText size={15} /> {exporting ? MAKING_PDF : EXPORT_PDF}
            </button>
            {FUTURE_EXPORTS.map((kind) => {
              const Icon = FUTURE_ICONS[kind];
              return (
                <button key={kind} role="menuitem" className="sk-menu-future" disabled aria-disabled="true" title="Coming in a later version">
                  <Icon size={15} /> {kind}
                  <span className="sk-future">Future</span>
                </button>
              );
            })}
          </div>
          <div className="sk-menu-sep" role="separator" />
          <button role="menuitem" className="danger" onClick={pick(() => setDialog('delete'))}>
            <Trash2 size={15} /> Delete…
          </button>
        </div>
      )}
      {exporting && !open && place === 'header' && (
        <span className="sk-making" role="status">
          {MAKING_PDF}
        </span>
      )}
      {!onProblem && ownProblem && (
        <span className="note bad sk-menu-problem" role="alert">
          {ownProblem}
        </span>
      )}
      {dialog === 'rename' && <RenameDialog sketch={sketch} onClose={() => setDialog(null)} onDone={() => refresh(sketch.id)} />}
      {dialog === 'delete' && (
        <DeleteDialog
          sketch={sketch}
          onClose={() => setDialog(null)}
          onDone={(gone) => {
            refresh(sketch.id, gone);
            if (gone) onDeleted?.();
          }}
        />
      )}
      {dialog === 'export' && <ExportDialog project={project} sketch={sketch} onClose={() => setDialog(null)} onExport={(body) => void exportPdf(body)} />}
    </span>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { api } from '../../api/client';
import { Modal } from '../../components/ui';
import { frameName, sketchApiPath, sketchKey, type SketchFull } from '../../lib/studio';
import {
  EXPORT_PDF,
  NO_APPROVED,
  NOT_DRAWN,
  canExport,
  exportBody,
  hasApprovedScreens,
  isApprovedScreen,
  isDrawn,
  selectAllState,
  ticksFor,
  toggleAll,
  toggleFrame,
  toggleScreen,
  type ExportRequest,
  type ExportScope,
} from '../../lib/studio-export';

/* ── The export window (US-46, AB-171.1) ──
   "All screens" or "Approved screens only" (off with "No approved screens yet" when no screen is approved), then the
   frames, all ticked and at least one kept ticked, then the screens with Select all, a small Draft mark next to the
   screens not approved yet, and the screens with no drawing off with "Not drawn yet". Last, "Include all variants of
   draft screens", not ticked at first. Export is off with no screen ticked. Nothing else goes in the window: Export
   hands the three choices to the menu, which makes the PDF and downloads it. */

export function ExportDialog({ project, sketch, onClose, onExport }: { project: string; sketch: { id: string; name: string }; onClose(): void; onExport(body: ExportRequest): void }) {
  // The sketch with its screens and drawings: already read when the workspace is open, read now from a card.
  const read = useQuery({ queryKey: sketchKey(project, sketch.id), queryFn: () => api<SketchFull>(sketchApiPath(sketch.id)) });
  const full = read.data;
  return (
    <Modal title={EXPORT_PDF} icon={<FileText size={18} />} onClose={onClose}>
      {full ? (
        <ExportChoices sketch={full} onClose={onClose} onExport={onExport} />
      ) : read.isError ? (
        <p className="note bad" role="alert">
          {read.error.message}
        </p>
      ) : (
        <p className="note">Reading the sketch…</p>
      )}
    </Modal>
  );
}

function ExportChoices({ sketch, onClose, onExport }: { sketch: SketchFull; onClose(): void; onExport(body: ExportRequest): void }) {
  const screens = [...sketch.screens].sort((a, b) => a.order - b.order);
  const approvedOnly = hasApprovedScreens(screens);
  const [scope, setScope] = useState<ExportScope>('all');
  const [ticked, setTicked] = useState<string[]>(() => ticksFor('all', screens));
  const [frames, setFrames] = useState<string[]>(sketch.frames);
  const [allVariants, setAllVariants] = useState(false);
  const all = selectAllState(screens, ticked);
  const allBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = all === 'some';
  }, [all]);
  const pickScope = (next: ExportScope) => {
    setScope(next);
    setTicked(ticksFor(next, screens));
  };
  const ok = canExport(ticked, frames);
  return (
    <div className="xp">
      <fieldset className="xp-group" aria-label="Which screens">
        <label className="xp-row">
          <input type="radio" name="xp-scope" checked={scope === 'all'} onChange={() => pickScope('all')} />
          <span>All screens</span>
        </label>
        <label className={`xp-row ${approvedOnly ? '' : 'off'}`}>
          <input type="radio" name="xp-scope" checked={scope === 'approved'} disabled={!approvedOnly} onChange={() => pickScope('approved')} />
          <span>Approved screens only</span>
          {!approvedOnly && <span className="xp-note">{NO_APPROVED}</span>}
        </label>
      </fieldset>

      <fieldset className="xp-group" aria-label="Frames">
        <legend>Frames</legend>
        {sketch.frames.map((f) => {
          const on = frames.includes(f);
          const last = on && frames.length === 1;
          return (
            <label key={f} className="xp-row" title={last ? 'Keep at least one frame' : undefined}>
              <input type="checkbox" checked={on} aria-disabled={last || undefined} onChange={() => setFrames(toggleFrame(sketch.frames, frames, f))} />
              <span>{frameName(f)}</span>
            </label>
          );
        })}
      </fieldset>

      <fieldset className="xp-group" aria-label="Screens">
        <legend>Screens</legend>
        <label className="xp-row xp-all">
          <input ref={allBox} type="checkbox" checked={all === 'all'} aria-checked={all === 'some' ? 'mixed' : all === 'all'} onChange={() => setTicked(toggleAll(screens, ticked))} />
          <span>Select all</span>
        </label>
        <div className="xp-screens">
          {screens.map((s) => {
            const drawn = isDrawn(s);
            return (
              <label key={s.id} className={`xp-row ${drawn ? '' : 'off'}`}>
                <input type="checkbox" checked={drawn && ticked.includes(s.id)} disabled={!drawn} onChange={() => setTicked(toggleScreen(screens, ticked, s.id))} />
                <span className="xp-name" dir="auto">
                  {s.name}
                </span>
                {!drawn ? <span className="xp-note">{NOT_DRAWN}</span> : !isApprovedScreen(s) && <span className="xp-draft">Draft</span>}
              </label>
            );
          })}
        </div>
      </fieldset>

      <label className="xp-row xp-variants">
        <input type="checkbox" checked={allVariants} onChange={(e) => setAllVariants(e.target.checked)} />
        <span>Include all variants of draft screens</span>
      </label>

      <div className="xp-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn pri" disabled={!ok} onClick={() => onExport(exportBody(screens, ticked, frames, allVariants))}>
          Export
        </button>
      </div>
    </div>
  );
}

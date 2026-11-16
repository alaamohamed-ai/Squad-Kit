import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PROJECT, api } from '../api/client';
import {
  DESIGN_SYSTEMS_PATH,
  SKETCHES_PATH,
  STUDIO_TABS,
  designSystemsKey,
  isColorValue,
  readStudioTab,
  saveStudioTab,
  sketchesKey,
  usedByText,
  type DesignSystemCard,
  type DesignSystemList,
  type SketchRow,
  type StudioTab,
} from '../lib/studio';
import { StartSketch } from './studio/StartSketch';

/* ── Studio: the project's sketches and design systems ──
   The tab the person last used stays in this browser tab, one per project (lib/studio). Both tabs read from the board
   server; opening the page or switching tabs saves nothing, so it creates nothing on disk. With no sketch yet, the
   Sketches tab is the start page (US-05): its Send is the one thing here that makes something, the first sketch. */

export function StudioPage({ project = PROJECT ?? '' }: { project?: string }) {
  const [tab, setTab] = useState<StudioTab>(() => readStudioTab(project));
  const pick = (t: StudioTab) => {
    setTab(t);
    saveStudioTab(project, t);
  };

  return (
    <>
      <div className="top">
        <h1>Studio</h1>
        <span className="note">Your sketches and design systems for this project.</span>
      </div>
      <div className="ptabs" role="tablist">
        {STUDIO_TABS.map((t) => (
          <button key={t.id} id={`studio-tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls="studio-panel" className={tab === t.id ? 'on' : ''} onClick={() => pick(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="scroll">
        <div className="page" id="studio-panel" role="tabpanel" aria-labelledby={`studio-tab-${tab}`}>
          {tab === 'systems' ? <DesignSystems project={project} /> : <Sketches project={project} onSetUpDesignSystem={() => pick('systems')} />}
        </div>
      </div>
    </>
  );
}

function useDesignSystems(project: string) {
  return useQuery({ queryKey: designSystemsKey(project), queryFn: () => api<DesignSystemList>(DESIGN_SYSTEMS_PATH) });
}

/** The Sketches tab: the start page while the project has no sketch, then the list of sketches. */
function Sketches({ project, onSetUpDesignSystem }: { project: string; onSetUpDesignSystem: () => void }) {
  const list = useQuery({ queryKey: sketchesKey(project), queryFn: () => api<{ sketches: SketchRow[] }>(SKETCHES_PATH) });
  const systems = useDesignSystems(project);
  if (list.isPending) return <p className="note">Reading the sketches…</p>;
  if (list.isError) return <p className="note bad">{list.error.message}</p>;
  const sketches = list.data.sketches;
  if (!sketches.length) {
    // The line about design systems shows only once the list says there are none: never while it is read.
    const noDesignSystem = systems.isSuccess && systems.data.designSystems.length === 0;
    return <StartSketch project={project} noDesignSystem={noDesignSystem} onSetUpDesignSystem={onSetUpDesignSystem} />;
  }
  return (
    <ul className="sk-list" aria-label="Sketches">
      {sketches.map((s) => (
        <li key={s.id}>
          <Link to="/studio/sketches/$id" params={{ id: s.id }} dir="auto">
            {s.name}
          </Link>
          <span className="sk-meta">{s.designSystem ? `Follows ${s.designSystem.name ?? s.designSystem.id}` : 'No design system'}</span>
        </li>
      ))}
    </ul>
  );
}

/** The Design systems tab (US-33): one card per design system, the Default first, then the others as they were made. */
function DesignSystems({ project }: { project: string }) {
  const list = useDesignSystems(project);
  if (list.isPending) return <p className="note">Reading the design systems…</p>;
  if (list.isError) return <p className="note bad">{list.error.message}</p>;
  const systems = list.data.designSystems;
  if (!systems.length) return <p className="note">No design systems yet.</p>;
  return (
    <>
      <p className="note ds-lead">Each sketch follows one design system. New sketches start with the default.</p>
      <ul className="ds-cards" aria-label="Design systems">
        {systems.map((ds) => (
          <DesignSystemCardView key={ds.id} ds={ds} />
        ))}
      </ul>
    </>
  );
}

function DesignSystemCardView({ ds }: { ds: DesignSystemCard }) {
  const colors = (Array.isArray(ds.colors) ? ds.colors : []).filter(isColorValue);
  return (
    <li className="ds-card" aria-label={ds.name}>
      <div className="ds-head">
        <h4 dir="auto">{ds.name}</h4>
        {ds.isDefault && <span className="pill ok sm">Default</span>}
        <span className="ds-v">v{ds.version}</span>
      </div>
      {colors.length > 0 && (
        <div className="ds-colors" aria-label="Colours">
          {colors.map((c) => (
            <span key={c} className="ds-color" title={c} style={{ background: c }} />
          ))}
        </div>
      )}
      <span className="ds-used">{usedByText(ds.sketches)}</span>
    </li>
  );
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PROJECT, api } from '../api/client';
import { DESIGN_SYSTEMS_PATH, STUDIO_TABS, isColorValue, readStudioTab, saveStudioTab, usedByText, type DesignSystemCard, type DesignSystemList, type StudioTab } from '../lib/studio';

/* ── Studio: the project's sketches and design systems ──
   The tab the person last used stays in this browser tab, one per project (lib/studio). The Design systems tab reads
   its cards from the board server; nothing on this page saves anything, so opening it or switching tabs creates
   nothing on disk: files appear only when something is made. */

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
          {tab === 'systems' ? <DesignSystems project={project} /> : <p className="note">Nothing here yet.</p>}
        </div>
      </div>
    </>
  );
}

/** The Design systems tab (US-33): one card per design system, the Default first, then the others as they were made. */
function DesignSystems({ project }: { project: string }) {
  const list = useQuery({ queryKey: ['studio', project, 'design-systems'], queryFn: () => api<DesignSystemList>(DESIGN_SYSTEMS_PATH) });
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

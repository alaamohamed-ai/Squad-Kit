import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PROJECT, api } from '../api/client';
import {
  DESIGN_SYSTEMS_PATH,
  SKETCHES_PATH,
  STUDIO_TABS,
  VIEW_SIZES,
  approvedText,
  coverPath,
  designSystemsKey,
  editedText,
  isColorValue,
  readStudioTab,
  saveStudioTab,
  screensText,
  sealedHtml,
  sketchesKey,
  usedByText,
  type DesignSystemCard,
  type DesignSystemList,
  type SketchCover,
  type SketchRow,
  type StudioTab,
} from '../lib/studio';
import { SketchMenu } from './studio/SketchMenu';
import { NewSketchButton, StartSketch } from './studio/StartSketch';
import { DesignSystemsSkeleton, SketchesSkeleton } from './studio/Skeletons';
import { useMarkStudioSeen } from '../lib/studio-seen';

/* ── Studio: the project's sketches and design systems ──
   The tab the person last used stays in this browser tab, one per project (lib/studio). Both tabs read from the board
   server; opening the page or switching tabs saves nothing, so it creates nothing on disk. With no sketch yet, the
   Sketches tab is the start page (US-05): its Send is the one thing here that makes something, the first sketch. */

export function StudioPage({ project = PROJECT ?? '' }: { project?: string }) {
  // Opening any Studio page, a sketch from a link too, takes the sidebar's New away (AB-178.1).
  useMarkStudioSeen(project);
  const [tab, setTab] = useState<StudioTab>(() => readStudioTab(project));
  const pick = (t: StudioTab) => {
    setTab(t);
    saveStudioTab(project, t);
  };

  return (
    <>
      {/* The title, then the two tabs as one segmented control, the selected one raised (US-53). */}
      <div className="top studio-top">
        <h1>Studio</h1>
        <div className="seg studio-seg" role="tablist" aria-label="Studio">
          {STUDIO_TABS.map((t) => (
            <button key={t.id} id={`studio-tab-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} aria-controls="studio-panel" className={tab === t.id ? 'on' : ''} onClick={() => pick(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
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

/**
 * The Sketches tab: the start page while the project has no sketch, then a card per sketch, newest edit first (US-06).
 * New sketch (US-08) opens the same start page over the cards; it is this page's own choice and saves nothing.
 */
function Sketches({ project, onSetUpDesignSystem }: { project: string; onSetUpDesignSystem: () => void }) {
  const list = useQuery({ queryKey: sketchesKey(project), queryFn: () => api<{ sketches: SketchRow[] }>(SKETCHES_PATH) });
  const systems = useDesignSystems(project);
  // A refused Duplicate, in the server's words, until the next action.
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  if (list.isPending) return <SketchesSkeleton />;
  if (list.isError) return <p className="note bad">{list.error.message}</p>;
  const sketches = list.data.sketches;
  if (!sketches.length || starting) {
    // The line about design systems shows only once the list says there are none: never while it is read.
    const noDesignSystem = systems.isSuccess && systems.data.designSystems.length === 0;
    // The design systems give the start page's chips (US-08): the default one and its frames.
    // Until they are read (or when they cannot be), Send leaves them to the server: the default and its frames.
    const listed = systems.isSuccess ? systems.data.designSystems : undefined;
    return <StartSketch project={project} noDesignSystem={noDesignSystem} onSetUpDesignSystem={onSetUpDesignSystem} systems={listed} onBack={sketches.length ? () => setStarting(false) : undefined} />;
  }
  return (
    <>
      <div className="sk-toolbar">
        <NewSketchButton onClick={() => setStarting(true)} />
      </div>
      {problem && (
        <p className="note bad sk-problem" role="alert">
          {problem}
        </p>
      )}
      <ul className="sk-cards" aria-label="Sketches">
        {sketches.map((s) => (
          <SketchCardView key={s.id} project={project} sketch={s} onProblem={setProblem} />
        ))}
      </ul>
    </>
  );
}

/**
 * One sketch's card: its first screen small (desktop and mobile, as it has them), its name, screens, approved count,
 * design system and last edit. The whole card is one link to the sketch; its ⋯ menu (US-13) sits on top of it, with
 * Rename, Duplicate and Delete.
 */
function SketchCardView({ project, sketch, onProblem }: { project: string; sketch: SketchRow; onProblem(text: string | null): void }) {
  const card = sketch.card;
  const screens = card?.screens ?? sketch.screens.length;
  const approved = approvedText(card?.approved ?? 0, screens);
  const designSystem = card ? card.designSystem : sketch.designSystem ? (sketch.designSystem.name ?? sketch.designSystem.id) : null;
  const edited = editedText(card?.edited);
  return (
    <li className="sk-card">
      <Link to="/studio/sketches/$id" params={{ id: sketch.id }} className="sk-card-link">
        <Thumbnails project={project} sketch={sketch} />
        <span className="sk-card-body">
          <span className="sk-card-name" dir="auto">
            {sketch.name}
          </span>
          <span className="sk-card-facts">
            <span className="sk-card-screens">{screensText(screens)}</span>
            {approved && <span className="sk-card-approved">{approved}</span>}
          </span>
          <span className="sk-card-ds" dir="auto">
            {designSystem ?? 'No design system'}
          </span>
          {edited && (
            <span className="sk-card-edited" dir="auto">
              {edited}
            </span>
          )}
        </span>
      </Link>
      <SketchMenu project={project} sketch={{ id: sketch.id, name: sketch.name, stamp: sketch.stamp, screens }} onProblem={onProblem} />
    </li>
  );
}

/** The first screen small, one picture per view it has. With no drawing yet, one plain placeholder. */
function Thumbnails({ project, sketch }: { project: string; sketch: SketchRow }) {
  const cover = sketch.card?.cover ?? null;
  const html = useQuery({
    queryKey: ['studio', project, 'cover', sketch.id, sketch.stamp],
    queryFn: () => api<SketchCover>(coverPath(sketch.id)),
    enabled: cover !== null,
    staleTime: Infinity,
  });
  if (!cover || !cover.views.length) {
    return (
      <span className="sk-thumbs">
        <span className="sk-thumb desktop">
          <span className="sk-thumb-wait" aria-label="No picture yet" role="img" />
        </span>
      </span>
    );
  }
  return (
    <span className="sk-thumbs">
      {cover.views.map((v) => (
        <Thumb key={`${v}:${cover.version}`} view={v} html={html.data?.frames?.[v]} />
      ))}
    </span>
  );
}

/**
 * One view drawn small in a sealed frame: no scripts (an empty sandbox) and no network (sealedHtml's policy). The plain
 * placeholder stays until the frame has loaded, so a thumbnail that is not ready never shows broken.
 */
function Thumb({ view, html }: { view: string; html: string | undefined }) {
  const [loaded, setLoaded] = useState(false);
  const size = VIEW_SIZES[view] ?? VIEW_SIZES.desktop!;
  const kind = view === 'mobile' ? 'mobile' : 'desktop';
  const scale = THUMB_H / size.height;
  return (
    <span className={`sk-thumb ${kind}`} data-view={view} style={{ width: Math.round(size.width * scale) }}>
      {typeof html === 'string' && (
        <iframe
          className="sk-thumb-frame"
          title={`${view} picture`}
          sandbox=""
          srcDoc={sealedHtml(html)}
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden="true"
          style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
          onLoad={() => setLoaded(true)}
        />
      )}
      {!loaded && <span className="sk-thumb-wait" aria-label="Picture not ready yet" role="img" />}
    </span>
  );
}

/** The height every thumbnail is drawn at, in the board's pixels. */
const THUMB_H = 150;

/** The Design systems tab (US-33): one card per design system, the Default first, then the others as they were made. */
function DesignSystems({ project }: { project: string }) {
  const list = useDesignSystems(project);
  if (list.isPending) return <DesignSystemsSkeleton />;
  if (list.isError) return <p className="note bad">{list.error.message}</p>;
  const systems = list.data.designSystems;
  // Centred the same way as the Sketches start page: only the short message, no chat box, nothing "coming soon" (US-53).
  if (!systems.length)
    return (
      <div className="studio-empty">
        <p className="note">No design systems yet.</p>
      </div>
    );
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
        <h4 dir="auto">
          <Link to="/studio/design-systems/$id" params={{ id: ds.id }} className="ds-card-link">
            {ds.name}
          </Link>
        </h4>
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

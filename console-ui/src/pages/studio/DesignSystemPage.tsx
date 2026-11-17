import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { PROJECT, api } from '../../api/client';
import { designSystemsKey, isColorValue, lookingAtText, saveStudioTab, type DesignSystemFull } from '../../lib/studio';
import { ChatPanel } from './ChatPanel';

/* ── A design system's page (US-52) ──
   Opened from its card on the Design systems tab. The chat with the AI Designer is on the left, as in a sketch's
   workspace; on the right, its current version: the colour tokens and each component as its own page. */

export function DesignSystemPageRoute() {
  const { id } = useParams({ from: '/studio/design-systems/$id' });
  return <DesignSystemPage project={PROJECT ?? ''} id={id} />;
}

/** The colour tokens of a version, however deep they sit: name and value. */
function colorTokens(tokens: unknown, prefix = '', out: [string, string][] = [], depth = 0): [string, string][] {
  if (depth > 6 || out.length >= 24 || !tokens || typeof tokens !== 'object') return out;
  for (const [k, v] of Object.entries(tokens as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (isColorValue(v)) out.push([name, v.trim()]);
    else if (v && typeof v === 'object') colorTokens(v, name, out, depth + 1);
  }
  return out;
}

export function DesignSystemPage({ project, id }: { project: string; id: string }) {
  const key = ['studio', project, 'design-system', id];
  const qc = useQueryClient();
  const ds = useQuery({ queryKey: key, queryFn: () => api<DesignSystemFull>(`/api/v1/studio/design-systems/${encodeURIComponent(id)}`) });
  const answered = useCallback(() => {
    void qc.invalidateQueries({ queryKey: key, exact: true });
    void qc.invalidateQueries({ queryKey: designSystemsKey(project) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, project, id]);
  const d = ds.data;
  const current = d?.versions.find((v) => v.version === d.version);
  const colors = colorTokens(current?.tokens);

  return (
    <>
      <div className="top">
        <Link to="/studio" className="sk-back" onClick={() => saveStudioTab(project, 'systems')}>
          <ChevronLeft size={15} /> Design systems
        </Link>
        <h1 dir="auto">{d?.name ?? (ds.isError ? 'Design system' : '…')}</h1>
        {d && <span className="note">{`Version ${d.version}${d.isDefault ? ' · Default' : ''}`}</span>}
      </div>
      {ds.isError ? (
        <div className="page">
          <p className="note bad">{ds.error.message}</p>
        </div>
      ) : (
        <div className="ws">
          {d ? <ChatPanel project={project} kind="design-system" id={id} lookingAt={lookingAtText(d.name, `version ${d.version}`)} stamp={d.stamp} onAnswered={answered} /> : <aside className="dc" aria-label="Chat with the AI Designer" />}
          <section className="ws-main" aria-label="Design system">
            {colors.length > 0 && (
              <div className="ds-tokens" aria-label="Colour tokens">
                {colors.map(([name, value]) => (
                  <span key={name} className="ds-token">
                    <span className="ds-color" style={{ background: value, width: 18, height: 18 }} /> {name}
                  </span>
                ))}
              </div>
            )}
            {!d ? (
              <p className="note ws-empty">Reading the design system…</p>
            ) : current && current.components.length ? (
              <ul className="ds-comps" aria-label="Components">
                {current.components.map((c) => (
                  <li key={c}>
                    {c}
                    <iframe title={c} sandbox="" srcDoc={current.html[c] ?? ''} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ws-empty">No components yet. Ask the AI Designer in the chat to make them, or ask it a question first.</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}

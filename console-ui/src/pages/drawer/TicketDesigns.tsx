import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PROJECT, worthRetrying } from '../../api/client';
import type { Ticket } from '../../api/types';
import { frameLabel, getTicketDesigns, removeTicketDesign, ticketDesignsKey, type ApprovedScreen } from '../../api/ticket-designs';
import { usePrefs } from '../../lib/prefs';
import { VIEW_SIZES, sealedHtml } from '../../lib/studio';
import '../../styles/ticket-designs.css';

/**
 * "Designs from the Studio" on a ticket's Story tab (US-55): the approved screens the ticket follows, each a frozen copy
 * at its approved version, as cards with their picture, drawn from the ticket's own copy, their frames and Remove.
 * They are picked only in the design step before the questions (DesignAsk.tsx). Once the build has started, Remove is
 * gone. A ticket with no picked screen shows nothing here.
 */
export function TicketDesigns({ t }: { t: Ticket }) {
  const qc = useQueryClient();
  const { toast } = usePrefs();
  // The stage is in the key: the build starting locks the list, so it is read again then.
  const q = useQuery({ queryKey: [...ticketDesignsKey(PROJECT, t.id), t.stage, Boolean(t.live)], queryFn: () => getTicketDesigns(t.id) });
  const remove = useMutation({
    mutationFn: (d: { sketch: string; screen: string; name: string }) => removeTicketDesign(t.id, d),
    onSuccess: (_data, d) => {
      void qc.invalidateQueries();
      toast(`Removed ${d.name}`);
    },
    onError: (err, d) => toast(err instanceof Error ? err.message : String(err), 'err', worthRetrying(err) ? () => remove.mutate(d) : undefined),
  });
  const data = q.data;
  if (!data) return null;
  // An answer with no list reads as no design.
  const designs = Array.isArray(data.designs) ? data.designs : [];
  // A ticket with no design shows nothing: it works as it always did.
  if (!designs.length) return null;
  return (
    <section className="td" aria-label="Designs from the Studio">
      <div className="lbl">Designs from the Studio · {designs.length}</div>
      <ul className="td-list">
        {designs.map((d) => {
          const first = d.frames.find((f) => d.html[f] !== undefined);
          return (
            <li key={`${d.sketch}/${d.screen}`} className="td-card">
              {first ? <SmallScreen html={d.html[first]!} frame={first} title={`${d.name}, ${frameLabel(first)}`} /> : <p className="td-empty">No picture saved.</p>}
              <div className="td-info">
                <p className="td-name" dir="auto">{d.name}</p>
                <p className="td-meta">
                  <span>Version {d.version}</span>
                  {d.frames.map((f) => (
                    <span key={f} className="td-frame">{frameLabel(f)}</span>
                  ))}
                </p>
              </div>
              {!data.locked && (
                <button className="btn sm" disabled={remove.isPending} onClick={() => remove.mutate(d)} aria-label={`Remove ${d.name}`}>
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The approved screens to tick, each with its small picture, on the design step's card. */
export function ScreenTicks({ screens, ticked, onToggle }: { screens: ApprovedScreen[]; ticked: string[]; onToggle(s: ApprovedScreen): void }) {
  return (
    <ul className="td-pick">
      {screens.map((s) => {
        const first = s.frames[0];
        const on = s.picked || ticked.includes(screenKey(s));
        return (
          <li key={screenKey(s)} className={`td-option${on ? ' on' : ''}`}>
            <label>
              <input type="checkbox" checked={on} disabled={s.picked} onChange={() => onToggle(s)} />
              <span className="td-name" dir="auto">{s.name}</span>
              <span className="td-meta">
                {s.picked ? 'On this ticket' : `Version ${s.version}`} · {s.frames.map(frameLabel).join(', ')}
              </span>
            </label>
            {first && s.html[first] !== undefined && <SmallScreen html={s.html[first]!} frame={first} title={`${s.name}, ${frameLabel(first)}`} />}
          </li>
        );
      })}
    </ul>
  );
}

/** One approved screen's key in a tick list. */
export const screenKey = (s: { sketch: string; screen: string }) => `${s.sketch}/${s.screen}`;

/** A screen drawn at its frame's real width, made small to fit, in a sealed frame: no scripts and no network. */
export function SmallScreen({ html, frame, title }: { html: string; frame: string; title: string }) {
  const size = VIEW_SIZES[frame] ?? VIEW_SIZES.desktop!;
  const watch = useRef<ResizeObserver | null>(null);
  const fit = useCallback(
    (el: HTMLElement | null) => {
      watch.current?.disconnect();
      watch.current = null;
      if (!el) return;
      const set = () => el.style.setProperty('--s', String(Math.max(0.05, Math.min(1, el.clientWidth / size.width))));
      set();
      if (typeof ResizeObserver === 'undefined') return;
      watch.current = new ResizeObserver(set);
      watch.current.observe(el);
    },
    [size.width],
  );
  return (
    <div className={`td-view ${frame}`} ref={fit} style={{ ['--w' as string]: `${size.width}px`, ['--h' as string]: `${size.height}px` }}>
      <iframe title={title} sandbox="" srcDoc={sealedHtml(html)} referrerPolicy="no-referrer" tabIndex={-1} />
    </div>
  );
}

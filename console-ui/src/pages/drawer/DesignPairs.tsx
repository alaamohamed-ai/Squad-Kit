import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PROJECT } from '../../api/client';
import type { Ticket } from '../../api/types';
import { frameLabel, getTicketDesigns, proofPictureUrl, ticketDesignsKey } from '../../api/ticket-designs';
import { designPairs, type DesignPair } from '../../lib/design-pairs';
import { Lightbox, type Picture } from '../../components/Lightbox';
import '../../styles/ticket-designs.css';

/**
 * "Design next to the build" on the proof card (US-55): for each screen picked from the Studio and each of its frames,
 * the design picture beside the Tester's after picture of the page it built, at the same size. Both open full size.
 * Nothing shows on a ticket with no picked screen.
 */
export function DesignPairs({ t }: { t: Ticket }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const q = useQuery({ queryKey: [...ticketDesignsKey(PROJECT, t.id), t.stage, Boolean(t.live)], queryFn: () => getTicketDesigns(t.id) });
  const pairs = designPairs(Array.isArray(q.data?.designs) ? q.data.designs : []);
  if (!pairs.length) return null;
  // Every picture there is, in order, for the full-size viewer.
  const pictures: Picture[] = [];
  const at = new Map<string, number>();
  for (const p of pairs) {
    for (const [side, file] of [['design', p.design], ['after', p.after]] as const) {
      if (!file) continue;
      at.set(`${p.name}|${p.frame}|${side}`, pictures.length);
      pictures.push({ src: proofPictureUrl(file), caption: `${p.name}, ${frameLabel(p.frame)}: ${side === 'design' ? 'design' : 'built'}` });
    }
  }
  const names = [...new Set(pairs.map((p) => p.name))];
  const side = (p: DesignPair, which: 'design' | 'after') => {
    const file = which === 'design' ? p.design : p.after;
    const label = which === 'design' ? 'Design' : 'Built';
    const i = at.get(`${p.name}|${p.frame}|${which}`);
    return (
      <figure>
        <figcaption>
          {label}
          {which === 'after' && p.page ? (
            <>
              {' '}
              · <code>{p.page}</code>
            </>
          ) : null}
        </figcaption>
        {file && i !== undefined ? (
          <button className="zoom" onClick={() => setZoom(i)} aria-label={`Open the ${label.toLowerCase()} picture of ${p.name}, ${frameLabel(p.frame)}, full size`}>
            <img src={proofPictureUrl(file)} alt={`${p.name}, ${frameLabel(p.frame)}, ${label.toLowerCase()}`} loading="lazy" />
          </button>
        ) : (
          <div className="dp-missing">{which === 'design' ? 'squad-kit could not draw the design this time.' : 'The Tester took no picture of this page.'}</div>
        )}
      </figure>
    );
  };
  return (
    <section className="dp" aria-label="Design next to the build">
      <div className="lbl">Design next to the build</div>
      {names.map((name) => (
        <div className="dp-screen" key={name}>
          <h4 dir="auto">{name}</h4>
          {pairs
            .filter((p) => p.name === name)
            .map((p) => (
              <div key={p.frame}>
                <p className="dp-frame">{frameLabel(p.frame)}</p>
                <div className="dp-pair">
                  {side(p, 'design')}
                  {side(p, 'after')}
                </div>
              </div>
            ))}
        </div>
      ))}
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
    </section>
  );
}

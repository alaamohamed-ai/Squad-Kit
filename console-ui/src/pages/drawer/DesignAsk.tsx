import { useState } from 'react';
import { Palette } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PROJECT, worthRetrying } from '../../api/client';
import type { Ticket } from '../../api/types';
import { answerDesign, getApprovedScreens, ticketDesignsKey, type ApprovedScreen } from '../../api/ticket-designs';
import { usePrefs } from '../../lib/prefs';
import { RecentActivity } from './Working';
import { ScreenTicks, screenKey } from './TicketDesigns';
import '../../styles/ticket-designs.css';

/**
 * The design step's card on the Now tab (US-55): right after the questions and before the spec, "Does this ticket
 * follow a design from the Studio?". It lists the project's approved screens to tick, with "Use these designs" and
 * "No design". This is the only place screens are picked; the Story tab shows them after. The Analyst writes the spec
 * once it is answered, with the screens ticked.
 */
export function DesignAskCard({ t }: { t: Ticket }) {
  const qc = useQueryClient();
  const { toast } = usePrefs();
  const [ticked, setTicked] = useState<string[]>([]);
  const q = useQuery({ queryKey: [...ticketDesignsKey(PROJECT, t.id), 'approved'], queryFn: () => getApprovedScreens(t.id) });
  const answer = useMutation({
    mutationFn: (a: { picks: ApprovedScreen[] } | { none: true }) => answerDesign(t.id, 'none' in a ? { none: true } : { picks: a.picks.map((p) => ({ sketch: p.sketch, screen: p.screen })) }),
    onSuccess: (_data, a) => {
      void qc.invalidateQueries();
      toast('none' in a ? 'No design: the Analyst writes the spec now.' : 'The Analyst writes the spec now, with these designs.');
    },
    onError: (err, a) => toast(err instanceof Error ? err.message : String(err), 'err', worthRetrying(err) ? () => answer.mutate(a) : undefined),
  });
  const screens = Array.isArray(q.data?.screens) ? q.data.screens : [];
  const chosen = screens.filter((s) => ticked.includes(screenKey(s)));
  const toggle = (s: ApprovedScreen) => setTicked((x) => (x.includes(screenKey(s)) ? x.filter((k) => k !== screenKey(s)) : [...x, screenKey(s)]));
  const busy = answer.isPending;
  return (
    <div className="db">
      <section className="design-ask" aria-label="Does this ticket follow a design from the Studio?">
        <div className="youbox">
          <span className="ring">
            <Palette size={16} />
          </span>
          <div>
            <b>Does this ticket follow a design from the Studio?</b>
            <span>Tick the approved screens it builds. The Analyst writes the spec after you answer, with the screens you tick.</span>
          </div>
        </div>
        {q.isPending && <p className="note">Reading the Studio…</p>}
        {q.isError && <p className="note">The Studio could not be read. Try again in a moment.</p>}
        {screens.length > 0 && <ScreenTicks screens={screens} ticked={ticked} onToggle={toggle} />}
        <div className="df">
          <button className="btn pri" disabled={busy || !chosen.length} onClick={() => answer.mutate({ picks: chosen })}>
            Use these designs
          </button>
          <button className="btn" disabled={busy} onClick={() => answer.mutate({ none: true })}>
            No design
          </button>
        </div>
      </section>
      <RecentActivity t={t} />
    </div>
  );
}

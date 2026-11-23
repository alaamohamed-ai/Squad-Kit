import { useState } from 'react';
import { Check, Lock, LockOpen } from 'lucide-react';
import { send } from '../../api/client';
import { Modal } from '../../components/ui';
import { approvalPath, approvedByText, reopenQuestion, statusLabel, type ApprovalAnswer, type ScreenView, type SketchFull } from '../../lib/studio';

/* ── Approve and reopen a screen (US-15, AB-140) ──
   In the workspace's header, for the screen shown: its status, and "Approve screen". Approve freezes the screen at the
   version it shows, as Approved with a lock, "Approved by Alaa · time". An approved screen shows Reopen instead, which
   asks "Are you sure?" first: Cancel leaves it Approved. Both send the sketch's stamp the page read (AB-129.1), so a
   change made elsewhere since is refused with "Changed elsewhere, reload", and both add their line to the conversation
   open beside the screen, after the save (AB-143.1). They wait while the AI Designer works. `squad studio sketch screen
   approve|reopen` do the same from the terminal. */

const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ScreenApproval({
  sketch,
  screen,
  chat,
  working,
  onDone,
  onRefused,
}: {
  sketch: Pick<SketchFull, 'id' | 'stamp'>;
  screen: ScreenView;
  /** The conversation open in the chat: the line goes there. */
  chat: string | null;
  /** The AI Designer is working: the buttons wait. */
  working: boolean;
  onDone(answer: ApprovalAnswer): void;
  /** Read the sketch again after a refusal, so the next try brings the new stamp. */
  onRefused(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const approved = screen.status === 'approved';

  const act = async (what: 'approve' | 'reopen') => {
    setBusy(true);
    setProblem(null);
    try {
      onDone(await send<ApprovalAnswer>(approvalPath(sketch.id, screen.id, what), 'POST', { stamp: sketch.stamp, ...(chat ? { chat } : {}) }));
      setAsking(false);
    } catch (err) {
      setProblem(said(err));
      onRefused();
    } finally {
      setBusy(false);
    }
  };

  const wait = working ? 'Wait for the AI Designer to finish' : undefined;
  return (
    <div className="ws-approval">
      {problem && !asking && (
        <span className="note bad ws-problem" role="alert">
          {problem}
        </span>
      )}
      {approved ? (
        <>
          <span className="ws-status approved" role="status">
            <Lock size={13} aria-hidden /> Approved
          </span>
          <span className="ws-approved-by" dir="auto">
            {approvedByText(screen.approved)}
          </span>
          <button type="button" className="btn" disabled={busy || working} title={wait} onClick={() => (setProblem(null), setAsking(true))}>
            <LockOpen size={15} aria-hidden /> Reopen
          </button>
        </>
      ) : (
        <>
          <span className="ws-status">{statusLabel(screen.status)}</span>
          <button
            type="button"
            className="btn pri"
            disabled={busy || working || screen.chosen === null}
            title={screen.chosen === null ? `${screen.name} has no drawing yet` : wait}
            onClick={() => void act('approve')}
          >
            <Check size={15} aria-hidden /> {busy ? 'Approving…' : 'Approve screen'}
          </button>
        </>
      )}
      {asking && <ReopenDialog screen={screen} busy={busy} problem={problem} onCancel={() => setAsking(false)} onReopen={() => void act('reopen')} />}
    </div>
  );
}

/** Reopen's "Are you sure?": names the screen and the version that stays. Cancel leaves it Approved. */
function ReopenDialog({ screen, busy, problem, onCancel, onReopen }: { screen: ScreenView; busy: boolean; problem: string | null; onCancel(): void; onReopen(): void }) {
  const ask = reopenQuestion(screen.name, screen.approved?.version ?? screen.chosen);
  return (
    <Modal
      title={ask.title}
      onClose={onCancel}
      icon={<LockOpen size={18} />}
      footer={
        <>
          <span className="grow" />
          <button className="btn" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button className="btn pri" disabled={busy} onClick={onReopen}>
            {busy ? 'Reopening…' : 'Reopen'}
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

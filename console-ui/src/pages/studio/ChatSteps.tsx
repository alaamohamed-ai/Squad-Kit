import { useEffect, useState } from 'react';
import { Check, Square } from 'lucide-react';
import { send } from '../../api/client';
import type { ChatMessageView, ConversationData } from '../../lib/studio';
import { clockText, foldText, saveAnywayPath, type ChatStepView, type ChatWorkingView } from '../../lib/studio-work';

/* ── The AI Designer's steps in the chat (US-57, AB-182.1) ──
   While it works: what it does, the time so far, Stop, and its steps as a list: done steps with a check, the current
   one moving, the next ones waiting. A wait for a free place is a step of its own. The steps are in the language of the
   message, so an Arabic message's steps read right to left. When the reply comes, the list folds into one line under
   it ("6 steps, 2 min"); a click opens it again. A reply that could not save has "Save them anyway". */

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function StepList({ steps, rtl }: { steps: ChatStepView[]; rtl: boolean }) {
  return (
    <ol className="dc-steps" dir={rtl ? 'rtl' : 'ltr'} aria-label="Steps">
      {steps.map((s, i) => (
        <li key={`${s.id ?? i}`} className={`dc-step ${s.state}`} aria-current={s.state === 'now' ? 'step' : undefined}>
          <span className="dc-step-mark" aria-hidden>
            {s.state === 'done' ? <Check size={12} /> : s.state === 'now' ? <span className="dc-step-spin" /> : <span className="dc-step-ring" />}
          </span>
          <span className="dc-step-words">{s.words}</span>
          {s.detail && (
            <span className="dc-step-detail" dir="ltr">
              {s.detail}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The working line: what the Designer does, the time so far and Stop, with its steps under it. */
export function WorkingSteps({ working, onStop }: { working: ChatWorkingView; onStop: () => void }) {
  const since = Date.parse(working.since);
  const now = useNow(true);
  const steps = working.steps ?? [];
  const rtl = working.language === 'Arabic';
  // With a list of steps, the line says Working; the list says what.
  const head = steps.length && working.doing !== 'Stopping' ? 'Working' : working.doing;
  return (
    <li className="dc-working" role="status">
      <div className="dc-work-head">
        <span className="dc-dot" aria-hidden />
        <span className="dc-doing">{head}</span>
        {Number.isFinite(since) && (
          <time className="dc-clock" aria-label="Time so far">
            {clockText(now - since)}
          </time>
        )}
        <button type="button" className="dc-stop" onClick={onStop}>
          <Square size={11} aria-hidden /> Stop
        </button>
      </div>
      {steps.length > 0 && <StepList steps={steps} rtl={rtl} />}
    </li>
  );
}

/** Under a reply: its steps folded into one line, a click opens them; and "Save them anyway" for drawings not saved. */
export function ReplyWork({ m, rtl, base, chat, stamp, onSaved }: { m: ChatMessageView; rtl: boolean; base: string; chat: string | null; stamp?: string; onSaved: (c: ConversationData) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const steps = m.steps ?? [];
  const unsaved = m.unsaved && !m.unsaved.gone ? m.unsaved : null;

  const save = async () => {
    if (!chat || !unsaved) return;
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await send<ConversationData>(saveAnywayPath(base, chat, unsaved.id), 'POST', stamp ? { stamp } : {}));
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {steps.length > 0 && (
        <div className="dc-fold">
          <button type="button" className="dc-fold-line" dir={rtl ? 'rtl' : 'ltr'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {foldText(steps.length, m.took ?? 0, rtl)}
          </button>
          {open && <StepList steps={steps} rtl={rtl} />}
        </div>
      )}
      {unsaved && (
        <div className="dc-unsaved">
          <button type="button" className="primary" disabled={busy || !chat} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save them anyway'}
          </button>
          {problem && (
            <span className="note bad" role="alert">
              {problem}
            </span>
          )}
        </div>
      )}
    </>
  );
}

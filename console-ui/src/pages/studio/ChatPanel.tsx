import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ImagePlus, MessageSquarePlus, Sparkles, Square, X } from 'lucide-react';
import { api, assetUrl, send } from '../../api/client';
import {
  DESIGN_SYSTEMS_PATH,
  MAX_PICTURES,
  PICTURE_TYPES,
  chatsKey,
  chatsPath,
  conversationLabel,
  designSystemsKey,
  pictureProblem,
  readPickedChat,
  savePickedChat,
  sketchApiPath,
  textDir,
  timeOf,
  type ChatMessageView,
  type ChatOwnerKind,
  type ConversationData,
  type ConversationList,
  type DesignSystemList,
  type MessagePicture,
} from '../../lib/studio';
import { readPicture } from './StartSketch';

/* ── The chat with the AI Designer (US-52, AB-177) ──
   Always open on the left of a sketch's workspace and of a design system's page: the Designer's name, what it looks
   at and whose turn it is; the conversation, Arabic messages right to left; pictures on a message; while it works,
   what it is doing and a Stop button. Conversations stay on this computer; the one picked stays in this browser tab
   (AB-127.1). New conversation starts an empty chat and keeps the old ones, and every version. */

export interface ChatPanelProps {
  project: string;
  kind: ChatOwnerKind;
  id: string;
  /** "Booking / Form, desktop". */
  lookingAt: string;
  /** The screen and frame the person looks at, sent with each message. */
  look?: { screen?: string; frame?: string };
  /** The stamp the page read: a change is saved only on top of it. */
  stamp?: string;
  /** The Designer finished a message: the page reads the sketch or design system again. */
  onAnswered?: () => void;
  /** What the Designer is doing now, or null: called each time it changes, so the page can read its work so far. */
  onWorking?: (doing: string | null) => void;
  /** A sketch's design system, by name, or null when it follows none (US-17): the "no design system" alert reads it. */
  designSystem?: string | null;
}

const LABELS: Record<string, string> = { changed: 'New version', stopped: 'Stopped', unavailable: 'Not available yet', failed: 'Did not work', 'needs-design-system': 'No design system' };

export function ChatPanel({ project, kind, id, lookingAt, look, stamp, onAnswered, onWorking, designSystem }: ChatPanelProps) {
  const base = chatsPath(kind, id);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: chatsKey(project, kind, id), queryFn: () => api<ConversationList>(base) });
  const [picked, setPicked] = useState<string | null>(() => readPickedChat(project, kind, id));
  const chat = picked && (list.data?.conversations.some((c) => c.id === picked) ?? true) ? picked : (list.data?.current ?? null);
  const convo = useQuery({
    queryKey: [...chatsKey(project, kind, id), chat],
    queryFn: () => api<ConversationData>(`${base}/${encodeURIComponent(chat!)}`),
    enabled: Boolean(chat),
    refetchInterval: (q) => (q.state.data?.working ? 1000 : false),
  });
  const [message, setMessage] = useState('');
  const [pictures, setPictures] = useState<MessagePicture[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLLIElement>(null);
  const wasWorking = useRef(false);

  const working = convo.data?.working ?? null;
  const messages = convo.data?.messages ?? [];

  // The answer came: the list's counts and the page's versions are read again.
  useEffect(() => {
    if (wasWorking.current && !working) {
      void qc.invalidateQueries({ queryKey: chatsKey(project, kind, id), exact: true });
      onAnswered?.();
    }
    wasWorking.current = Boolean(working);
  }, [working, qc, project, kind, id, onAnswered]);

  // Each step of the work (a name given, a variant drawn) is told to the page, which reads the sketch again.
  const doing = working?.doing ?? null;
  useEffect(() => {
    onWorking?.(doing);
  }, [doing, onWorking]);

  // A block, not an arrow's value: newer browsers return a promise from scrollIntoView, and React takes any value
  // an effect returns for its cleanup.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, working?.doing]);

  const pick = (c: string) => {
    setPicked(c);
    savePickedChat(project, kind, id, c);
    setProblem(null);
  };

  const addFiles = async (files: File[]) => {
    let count = pictures.length;
    const added: MessagePicture[] = [];
    let why: string | null = null;
    for (const file of files) {
      const no = pictureProblem(file, count);
      if (no) {
        why = no;
        continue;
      }
      try {
        added.push(await readPicture(file));
        count++;
      } catch (err) {
        why = (err as Error).message;
      }
    }
    setPictures((p) => [...p, ...added].slice(0, MAX_PICTURES));
    setProblem(why);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    void addFiles(files);
  };

  // A screenshot pasted into the box is added to the message.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };

  const startNew = async () => {
    setProblem(null);
    try {
      const row = await send<{ id: string }>(base, 'POST');
      await qc.invalidateQueries({ queryKey: chatsKey(project, kind, id), exact: true });
      pick(row.id);
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  const post = async (text: string, withPictures: MessagePicture[], plainStyles = false) => {
    if (!chat) return;
    setBusy(true);
    setProblem(null);
    try {
      const data = await send<ConversationData>(`${base}/${encodeURIComponent(chat)}/messages`, 'POST', {
        text,
        pictures: withPictures,
        ...(look ? { lookingAt: look } : {}),
        ...(stamp ? { stamp } : {}),
        // "Skip" on the "no design system" alert (US-17): this one message draws in plain styles.
        ...(plainStyles ? { plainStyles: true } : {}),
      });
      qc.setQueryData([...chatsKey(project, kind, id), chat], data);
      setMessage('');
      setPictures([]);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ready = (message.trim().length > 0 || pictures.length > 0) && !busy && !working && Boolean(chat);
  const go = (e?: FormEvent) => {
    e?.preventDefault();
    if (ready) void post(message.trim(), pictures);
  };

  const stop = async () => {
    if (!chat) return;
    try {
      await send(`${base}/${encodeURIComponent(chat)}/stop`, 'POST');
      await convo.refetch();
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  const last = messages[messages.length - 1];
  const unanswered = !working && last?.role === 'person';
  const rows = list.data?.conversations ?? [];
  // Variants were asked for with no design system (US-17): the person's words, to ask again or to skip with.
  const needsSystem = kind === 'sketch' && !working && last?.role === 'designer' && last.kind === 'needs-design-system';
  const askedFor = needsSystem ? [...messages].reverse().find((m) => m.role === 'person')?.text : undefined;

  return (
    <aside className="dc" aria-label="Chat with the AI Designer">
      <header className="dc-head">
        <span className="dc-avatar" aria-hidden>
          <Sparkles size={16} />
        </span>
        <div className="dc-who">
          <strong>AI Designer</strong>
          <span className="dc-at" dir="auto" title="What the AI Designer is looking at">
            {lookingAt}
          </span>
        </div>
        <span className={`dc-turn ${working ? 'working' : ''}`} aria-live="polite">
          {working ? 'Working' : 'Your turn'}
        </span>
      </header>

      <div className="dc-convos">
        <select aria-label="Conversation" value={chat ?? ''} onChange={(e) => pick(e.target.value)} disabled={!rows.length}>
          {!rows.length && <option value={chat ?? ''}>Conversation 1 · new</option>}
          {rows.map((r, i) => (
            <option key={r.id} value={r.id}>
              {conversationLabel(r, rows.length - i)}
            </option>
          ))}
        </select>
        <button type="button" className="dc-new" onClick={() => void startNew()} disabled={Boolean(working) || busy}>
          <MessageSquarePlus size={14} aria-hidden /> New conversation
        </button>
      </div>

      <ol className="dc-msgs" aria-label="Conversation">
        {convo.isError && <li className="note bad">{convo.error.message}</li>}
        {convo.isSuccess && !messages.length && (
          <li className="dc-empty">Ask a question, ask for advice or say what to change. Questions change nothing; only a change makes a new version.</li>
        )}
        {messages.map((m, i) => (
          <Message key={i} m={m} />
        ))}
        {working && (
          <li className="dc-working" role="status">
            <span className="dc-dot" aria-hidden />
            <span className="dc-doing">{working.doing}</span>
            <button type="button" className="dc-stop" onClick={() => void stop()}>
              <Square size={11} aria-hidden /> Stop
            </button>
          </li>
        )}
        <li ref={end} aria-hidden className="dc-end" />
      </ol>

      {unanswered && (
        <p className="dc-unanswered">
          Your last message has no answer yet.{' '}
          <button type="button" onClick={() => void post('', [])} disabled={busy}>
            Answer it
          </button>
        </p>
      )}
      {needsSystem && askedFor && (
        <NoDesignSystemAlert
          project={project}
          sketch={id}
          stamp={stamp}
          designSystem={designSystem ?? null}
          busy={busy}
          onSelected={() => onAnswered?.()}
          onAskAgain={() => void post(askedFor, [])}
          onSkip={() => void post(askedFor, [], true)}
        />
      )}
      {problem && (
        <p className="note bad dc-problem" role="alert">
          {problem}
        </p>
      )}

      <form className="dc-box" onSubmit={go} aria-label="Write to the AI Designer">
        {pictures.length > 0 && (
          <ul className="sk-pics" aria-label="Pictures to send">
            {pictures.map((p, i) => (
              <li key={`${i}-${p.name}`}>
                <img src={p.data} alt={p.name} />
                <button type="button" className="sk-pic-x" aria-label={`Remove ${p.name}`} onClick={() => setPictures((all) => all.filter((_, j) => j !== i))}>
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          dir="auto"
          rows={2}
          value={message}
          placeholder="Ask, or ask for a change…"
          aria-label="Message to the AI Designer"
          onChange={(e) => setMessage(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              go();
            }
          }}
        />
        <div className="sk-bar">
          <button type="button" className="iconbtn" aria-label="Add a picture" title="Add a picture or a screenshot" disabled={pictures.length >= MAX_PICTURES || busy} onClick={() => picker.current?.click()}>
            <ImagePlus size={17} />
          </button>
          <input ref={picker} type="file" accept={PICTURE_TYPES.join(',')} multiple hidden onChange={onPick} aria-label="Pick pictures" />
          <button type="submit" className="sk-send" aria-label="Send" title="Send" disabled={!ready}>
            <ArrowUp size={17} />
          </button>
        </div>
      </form>
    </aside>
  );
}

/**
 * Variants were asked for on a sketch with no design system (US-17): nothing was drawn. "Select a design system" saves
 * the choice to the sketch, with the stamp the page read; then "Ask again" sends the same words. "Skip" sends them
 * once more in plain styles, this once: the next ask for variants shows this alert again.
 */
function NoDesignSystemAlert(p: {
  project: string;
  sketch: string;
  stamp?: string;
  designSystem: string | null;
  busy: boolean;
  onSelected: () => void;
  onAskAgain: () => void;
  onSkip: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const systems = useQuery({ queryKey: designSystemsKey(p.project), queryFn: () => api<DesignSystemList>(DESIGN_SYSTEMS_PATH), enabled: picking });
  const options = systems.data?.designSystems ?? [];
  const picked = choice || systems.data?.default?.id || options[0]?.id || '';

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    setProblem(null);
    try {
      await send(sketchApiPath(p.sketch), 'PATCH', { designSystem: { id: picked }, ...(p.stamp ? { stamp: p.stamp } : {}) });
      setPicking(false);
      p.onSelected();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (p.designSystem) {
    return (
      <div className="dc-alert" role="status">
        <span>
          This sketch now follows <strong>{p.designSystem}</strong>. Ask again to draw the variants in its colors, fonts and sizes.
        </span>
        <div className="dc-alert-row">
          <button type="button" className="primary" disabled={p.busy} onClick={p.onAskAgain}>
            Ask again
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="dc-alert" role="alert">
      <span>
        <strong>No design system is selected</strong> for this sketch, so nothing was drawn. Variants use the design system's colors, fonts and sizes.
      </span>
      {picking ? (
        <div className="dc-alert-row">
          {systems.isLoading ? (
            <span>…</span>
          ) : options.length ? (
            <>
              <select aria-label="Design system" value={picked} onChange={(e) => setChoice(e.target.value)}>
                {options.map((ds) => (
                  <option key={ds.id} value={ds.id}>
                    {ds.name}
                    {ds.isDefault ? ' · default' : ''}
                  </option>
                ))}
              </select>
              <button type="button" className="primary" disabled={saving || !picked} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Use it'}
              </button>
            </>
          ) : (
            <span>This project has no design system yet. Make one on the Design systems tab.</span>
          )}
          <button type="button" onClick={() => setPicking(false)} disabled={saving}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="dc-alert-row">
          <button type="button" className="primary" onClick={() => setPicking(true)} disabled={p.busy}>
            Select a design system
          </button>
          <button type="button" onClick={p.onSkip} disabled={p.busy} title="Draw the variants in plain styles, this once">
            Skip
          </button>
        </div>
      )}
      {problem && <span className="note bad">{problem}</span>}
    </div>
  );
}

function Message({ m }: { m: ChatMessageView }) {
  const dir = textDir(m.text);
  const label = m.kind ? LABELS[m.kind] : undefined;
  return (
    <li className={`dc-msg ${m.role}${m.kind ? ` dc-k-${m.kind}` : ''}`}>
      {m.role === 'designer' && (
        <span className="dc-from">
          <Sparkles size={12} aria-hidden /> AI Designer <time>{timeOf(m.at)}</time>
          {label && <span className="dc-kind">{label}</span>}
        </span>
      )}
      <div className="dc-text" dir={dir}>
        {m.text}
      </div>
      {m.pictures.length > 0 && (
        <ul className="sk-pics" aria-label="Pictures">
          {m.pictures.map((p, j) => (
            <li key={p}>
              <img src={assetUrl(p)} alt={`Picture ${j + 1}`} />
            </li>
          ))}
        </ul>
      )}
      {m.saved && m.saved.length > 0 && (
        <span className="dc-saved">
          {m.saved.map((s) => `${s.name ?? s.screen}${s.version ? ` v${s.version}` : ''}`).join(' · ')}
        </span>
      )}
      {m.role === 'person' && <time className="dc-you">You · {timeOf(m.at)}</time>}
    </li>
  );
}

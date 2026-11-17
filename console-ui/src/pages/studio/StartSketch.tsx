import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUp, ImagePlus, Monitor, Sparkles, X } from 'lucide-react';
import { api, send } from '../../api/client';
import {
  APP_PICTURE_PATH,
  EXAMPLE_PROMPTS,
  MAX_PICTURES,
  PICTURE_TYPES,
  START_SKETCH_PATH,
  pictureProblem,
  sketchesKey,
  type AppPictureOption,
  type MessagePicture,
  type StartedSketch,
} from '../../lib/studio';

/* ── The Sketches tab's start page (US-05, AB-130) ──
   The chat box with the AI Designer is the way in. Picking a prompt or a picture only changes this page: pictures stay
   in the browser as small previews until Send (AB-130.1). Send makes the sketch, keeps the first message and its
   pictures with the sketch's chat on this computer, and opens the sketch's workspace. */

/** One picked file, read into the browser as a data address. */
export function readPicture(file: File): Promise<MessagePicture> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result) });
    reader.onerror = () => reject(new Error(`"${file.name}" could not be read.`));
    reader.readAsDataURL(file);
  });
}

export function StartSketch({ project, noDesignSystem, onSetUpDesignSystem }: { project: string; noDesignSystem: boolean; onSetUpDesignSystem: () => void }) {
  const [message, setMessage] = useState('');
  const [pictures, setPictures] = useState<MessagePicture[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'send' | 'app' | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Only asks: nothing starts and nothing is written until the person clicks.
  const appOption = useQuery({ queryKey: ['studio', project, 'app-picture'], queryFn: () => api<AppPictureOption>(APP_PICTURE_PATH) });

  useEffect(() => box.current?.focus(), []);

  const fill = (text: string) => {
    setMessage(text);
    box.current?.focus();
  };

  const add = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
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
    box.current?.focus();
  };

  const takeAppPicture = async () => {
    if (pictures.length >= MAX_PICTURES) return setProblem(`Add at most ${MAX_PICTURES} pictures to one message.`);
    setBusy('app');
    setProblem(null);
    try {
      const r = await send<{ picture: MessagePicture }>(APP_PICTURE_PATH, 'POST');
      setPictures((p) => [...p, r.picture].slice(0, MAX_PICTURES));
      box.current?.focus();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const ready = message.trim().length > 0 && !busy;
  const go = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy('send');
    setProblem(null);
    try {
      const made = await send<StartedSketch>(START_SKETCH_PATH, 'POST', { message: message.trim(), pictures });
      await qc.invalidateQueries({ queryKey: sketchesKey(project) });
      await navigate({ to: '/studio/sketches/$id', params: { id: made.id } });
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(null);
    }
  };

  const app = appOption.data;
  const appWhy = appOption.isError ? 'squad-kit could not check your app just now.' : app && !app.ok ? (app.why ?? 'This project has no app to take a picture of yet.') : null;

  return (
    <div className="sk-start">
      <span className="sk-kicker">
        <Sparkles size={13} aria-hidden /> Start here
      </span>
      <h2>What do you want to design?</h2>
      <p className="sk-lead">Tell the AI Designer in your own words. You can also add a picture.</p>

      <form className="sk-box" onSubmit={go} aria-label="Chat with the AI Designer">
        <textarea
          ref={box}
          autoFocus
          dir="auto"
          rows={3}
          value={message}
          placeholder="Describe what you want to design"
          aria-label="Describe what you want to design"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void go();
            }
          }}
        />
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
        <div className="sk-bar">
          <button type="button" className="iconbtn" aria-label="Add a picture" title="Add a picture" disabled={pictures.length >= MAX_PICTURES || Boolean(busy)} onClick={() => picker.current?.click()}>
            <ImagePlus size={17} />
          </button>
          <input ref={picker} type="file" accept={PICTURE_TYPES.join(',')} multiple hidden onChange={add} aria-label="Pick pictures" />
          <button type="submit" className="sk-send" aria-label="Send" title="Send" disabled={!ready}>
            <ArrowUp size={17} />
          </button>
        </div>
      </form>
      {busy === 'send' && <p className="note sk-status">Making the sketch…</p>}
      {busy === 'app' && <p className="note sk-status">Taking a picture of your app. If it is not running, squad-kit starts it first…</p>}
      {problem && (
        <p className="note bad sk-status" role="alert">
          {problem}
        </p>
      )}

      <div className="sk-prompts" aria-label="Example prompts">
        {EXAMPLE_PROMPTS.map((p) => (
          <button key={p} type="button" className="sk-chip" onClick={() => fill(p)}>
            {p}
          </button>
        ))}
      </div>

      <div className="sk-from">
        <span>Or start from</span>
        <button type="button" className="sk-link" disabled={pictures.length >= MAX_PICTURES || Boolean(busy)} onClick={() => picker.current?.click()}>
          <ImagePlus size={14} aria-hidden /> Start from an image
        </button>
        <button type="button" className="sk-link" disabled={!app?.ok || Boolean(busy)} aria-describedby={appWhy ? 'sk-app-why' : undefined} title={appWhy ?? undefined} onClick={() => void takeAppPicture()}>
          <Monitor size={14} aria-hidden /> A screen from your app
        </button>
      </div>
      {appWhy && (
        <p className="sk-why" id="sk-app-why">
          {appWhy}
        </p>
      )}
      {/* A hint, never a gate: Send works the same with no design system. */}
      {noDesignSystem && (
        <p className="sk-ds">
          No design system yet.{' '}
          <button type="button" onClick={onSetUpDesignSystem}>
            Set up a design system
          </button>
        </p>
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUp, ChevronDown, ChevronLeft, ImagePlus, Minus, Monitor, Plus, Smartphone, Sparkles, Tablet, X } from 'lucide-react';
import { api, send } from '../../api/client';
import {
  APP_PICTURE_PATH,
  DEFAULT_VARIANTS,
  EXAMPLE_PROMPTS,
  MAX_PICTURES,
  MAX_VARIANTS,
  MIN_VARIANTS,
  PICTURE_TYPES,
  START_SKETCH_PATH,
  frameLabel,
  framesOf,
  pictureProblem,
  runLine,
  sketchesKey,
  type AppPictureOption,
  type DesignSystemCard,
  type MessagePicture,
  type StartedSketch,
} from '../../lib/studio';

/* ── The Sketches tab's start page (US-05, AB-130) ──
   The chat box with the AI Designer is the way in. Picking a prompt or a picture only changes this page: pictures stay
   in the browser as small previews until Send (AB-130.1). The chips under the box (US-08) show the design system, its
   frames and the variants the AI Designer will draw, and only change this page. Send makes the sketch with them, keeps
   the first message and its pictures with the sketch's chat on this computer, starts the AI Designer on it and opens
   the sketch's workspace, where it names the sketch and asks or draws. */

/** One picked file, read into the browser as a data address. */
export function readPicture(file: File): Promise<MessagePicture> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result) });
    reader.onerror = () => reject(new Error(`"${file.name}" could not be read.`));
    reader.readAsDataURL(file);
  });
}

export interface StartSketchProps {
  project: string;
  noDesignSystem: boolean;
  onSetUpDesignSystem: () => void;
  /** The project's design systems, the default first; undefined while they are read. */
  systems?: DesignSystemCard[];
  /** Opened with New sketch over the cards: back to them. */
  onBack?: () => void;
}

/** New sketch on the Sketches home (US-08): opens the start page, the chat box with the AI Designer, not a form. */
export function NewSketchButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn sk-new" onClick={onClick}>
      <Plus size={15} aria-hidden /> New sketch
    </button>
  );
}

export function StartSketch({ project, noDesignSystem, onSetUpDesignSystem, systems, onBack }: StartSketchProps) {
  const [message, setMessage] = useState('');
  // The chips (US-08): only this page changes until Send. Null means "as the design system has it".
  const [pickedSystem, setPickedSystem] = useState<string | null>(null);
  const [pickedFrames, setPickedFrames] = useState<string[] | null>(null);
  const [variants, setVariants] = useState(DEFAULT_VARIANTS);
  const system = systems?.find((d) => d.id === pickedSystem) ?? systems?.find((d) => d.isDefault) ?? systems?.[0] ?? null;
  const allFrames = framesOf(system);
  const frames = pickedFrames ? allFrames.filter((f) => pickedFrames.includes(f)) : allFrames;
  const onFrames = frames.length ? frames : allFrames;
  const pickSystem = (id: string) => {
    setPickedSystem(id);
    // Another design system brings its own frames, all on.
    setPickedFrames(null);
  };
  const toggleFrame = (f: string) => {
    if (onFrames.includes(f)) {
      // At least one frame always stays on.
      if (onFrames.length > 1) setPickedFrames(onFrames.filter((x) => x !== f));
    } else setPickedFrames(allFrames.filter((x) => x === f || onFrames.includes(x)));
  };
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
      // What the chips say goes with the message; until the design systems are read, the server's defaults hold.
      const chosen = systems ? { designSystem: system?.id ?? null, frames: onFrames } : {};
      const made = await send<StartedSketch>(START_SKETCH_PATH, 'POST', { message: message.trim(), pictures, ...chosen, variants });
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
      {onBack && (
        <button type="button" className="sk-back sk-start-back" onClick={onBack}>
          <ChevronLeft size={15} aria-hidden /> All sketches
        </button>
      )}
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
      <StartChips
        systems={systems}
        system={system}
        allFrames={allFrames}
        frames={onFrames}
        variants={variants}
        disabled={busy === 'send'}
        onSystem={pickSystem}
        onFrame={toggleFrame}
        onVariants={setVariants}
      />
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

const FRAME_ICONS: Record<string, typeof Monitor> = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };

interface StartChipsProps {
  systems?: DesignSystemCard[];
  system: DesignSystemCard | null;
  allFrames: string[];
  frames: string[];
  variants: number;
  disabled: boolean;
  onSystem(id: string): void;
  onFrame(frame: string): void;
  onVariants(n: number): void;
}

/**
 * The chips under the chat box (US-08): the design system the sketch follows (the default unless picked from a short
 * list), one on/off chip per frame of it, the variants from 1 to 3, and the line that says what the run will make. They
 * only change this page: nothing is sent or saved until Send.
 */
function StartChips({ systems, system, allFrames, frames, variants, disabled, onSystem, onFrame, onVariants }: StartChipsProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // The list closes on a click outside it and on Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const many = (systems?.length ?? 0) > 1;
  return (
    <div className="sk-follows" aria-label="What the AI Designer draws">
      <div className="sk-chips">
        <span className="sk-follows-word">Follows</span>
        <div className="sk-ds-pick" ref={wrap}>
          <button
            type="button"
            className="sk-opt"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Design system: ${system ? `${system.name}${system.isDefault ? ', default' : ''}` : 'none'}`}
            disabled={disabled || !systems?.length}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="sk-opt-dot" aria-hidden />
            {!systems ? '…' : system ? `${system.name}${system.isDefault ? ' · default' : ''}` : 'No design system'}
            {many && <ChevronDown size={13} aria-hidden />}
          </button>
          {open && systems && (
            <div className="sk-ds-menu" role="menu" aria-label="Design systems">
              {systems.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={d.id === system?.id}
                  onClick={() => {
                    onSystem(d.id);
                    setOpen(false);
                  }}
                >
                  <span className="sk-ds-name" dir="auto">
                    {d.name}
                  </span>
                  <span className="sk-ds-more">
                    {d.isDefault ? ' · default' : ''} · {framesOf(d).map(frameLabel).join(', ')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {allFrames.map((f) => {
          const on = frames.includes(f);
          const last = on && frames.length === 1;
          const Icon = FRAME_ICONS[f] ?? Monitor;
          return (
            <button
              key={f}
              type="button"
              className={`sk-opt sk-frame ${on ? 'on' : 'off'}`}
              aria-pressed={on}
              aria-disabled={last || undefined}
              title={last ? 'At least one frame stays on' : on ? `Turn ${frameLabel(f)} off` : `Turn ${frameLabel(f)} on`}
              disabled={disabled}
              onClick={() => onFrame(f)}
            >
              <Icon size={14} aria-hidden /> {frameLabel(f)}
            </button>
          );
        })}
        <span className="sk-opt sk-variants" role="group" aria-label="Variants">
          <button type="button" aria-label="Fewer variants" disabled={disabled || variants <= MIN_VARIANTS} onClick={() => onVariants(Math.max(MIN_VARIANTS, variants - 1))}>
            <Minus size={12} />
          </button>
          <span className="sk-variants-n">
            {variants} {variants === 1 ? 'variant' : 'variants'}
          </span>
          <button type="button" aria-label="More variants" disabled={disabled || variants >= MAX_VARIANTS} onClick={() => onVariants(Math.min(MAX_VARIANTS, variants + 1))}>
            <Plus size={12} />
          </button>
        </span>
      </div>
      <p className="sk-run" aria-live="polite">
        {runLine(frames.length, variants)}
      </p>
    </div>
  );
}

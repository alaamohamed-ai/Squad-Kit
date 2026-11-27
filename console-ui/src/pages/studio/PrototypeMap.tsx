import { AlertTriangle, CornerUpLeft, Flag, Link2 } from 'lucide-react';
import { VIEW_SIZES, frameName } from '../../lib/studio';
import {
  CARD_GAP,
  CARD_W,
  linkOf,
  mapArrows,
  mapIsRtl,
  pickValue,
  tabScreens,
  type PrototypeData,
  type ProtoDrawing,
  type ProtoLink,
  type ProtoScreen,
  type ProtoTab,
} from '../../lib/studio-prototype';
import { PrototypeFrame } from './PrototypeFrame';

/* ── The prototype's map (US-54, US-58) ──
   The picked tab's screens as cards in the screen order, each at the drawing that tab shows, with the tab's working
   links as arrows above the cards. Every screen follows one rule, approved or not, with no approval mark. A card lists
   its options; a click on one shows that option's tab. Each card lists the buttons on the drawing shown: select one (in the list or in
   the drawing) and pick where it leads, a screen, Back or no link. The link belongs to the screen and the button's name,
   so it is the same on every option. A link broken on this tab says why in a short warning. */

/** The preview box on a card. */
const PREVIEW = { width: CARD_W - 24, height: 180 };

export interface Picked {
  screen: string;
  button: string;
}

export function PrototypeMap({
  data,
  tab,
  frame,
  picked,
  busy,
  onPick,
  onLink,
  onStart,
  onTab,
}: {
  data: PrototypeData;
  tab: ProtoTab;
  frame: string | undefined;
  picked: Picked | null;
  busy: boolean;
  onPick(p: Picked | null): void;
  onLink(screen: string, button: string, value: string): void;
  onStart(screen: string): void;
  onTab(id: string): void;
}) {
  const shown = tabScreens(data, tab);
  const rtl = mapIsRtl(shown.map((x) => x.drawing));
  const map = mapArrows(
    shown.map((x) => x.screen),
    tab.links,
    rtl,
  );
  return (
    <div className="pt-map" dir={rtl ? 'rtl' : 'ltr'}>
      <div className="pt-canvas" style={{ width: map.width }}>
        {map.height > 0 && (
          <svg className="pt-arrows" width={map.width} height={map.height} aria-hidden="true">
            <defs>
              <marker id="pt-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {map.arrows.map((a) => (
              <g key={`${a.screen}\n${a.button}`} className={picked && picked.screen === a.screen && picked.button === a.button ? 'on' : ''}>
                <path d={a.d} markerEnd="url(#pt-head)" />
                <text x={a.labelX} y={a.labelY} textAnchor="middle" direction={rtl ? 'rtl' : 'ltr'}>
                  {a.button}
                </text>
              </g>
            ))}
          </svg>
        )}
        <ol className="pt-cards" aria-label={`Screens in ${tab.label}`} style={{ gap: CARD_GAP }}>
          {shown.map(({ screen: s, drawing }) => (
            <ScreenCard
              key={s.id}
              data={data}
              tab={tab}
              screen={s}
              drawing={drawing}
              frame={frame}
              picked={picked?.screen === s.id ? picked.button : null}
              busy={busy}
              onPick={(b) => onPick(b ? { screen: s.id, button: b } : null)}
              onLink={(b, v) => onLink(s.id, b, v)}
              onStart={() => onStart(s.id)}
              onTab={onTab}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

/** The id of a button's picker, so a click on the button in the drawing can move to it. */
const pickerId = (screen: string, i: number) => `pt-pick-${screen}-${i}`;

function ScreenCard({
  data,
  tab,
  screen: s,
  drawing: d,
  frame,
  picked,
  busy,
  onPick,
  onLink,
  onStart,
  onTab,
}: {
  data: PrototypeData;
  tab: ProtoTab;
  screen: ProtoScreen;
  drawing: ProtoDrawing;
  frame: string | undefined;
  picked: string | null;
  busy: boolean;
  onPick(button: string | null): void;
  onLink(button: string, value: string): void;
  onStart(): void;
  onTab(id: string): void;
}) {
  const isStart = tab.start === s.id;
  const page = frame && d.frames[frame] !== undefined ? frame : Object.keys(d.frames)[0];
  const size = VIEW_SIZES[page ?? 'desktop'] ?? VIEW_SIZES.desktop!;
  const k = Math.min(PREVIEW.width / size.width, PREVIEW.height / size.height);
  const links = tab.links.filter((l) => l.screen === s.id);
  // Links whose button is not on the drawing shown: gone from every drawing, or only from this option.
  const missing = links.filter((l) => l.broken === 'button-gone' && !d.buttons.some((b) => b.name.toLowerCase() === l.button.toLowerCase()));
  const others = data.screens.filter((x) => x.id !== s.id);
  const pick = (button: string) => {
    onPick(button);
    const i = d.buttons.findIndex((b) => b.name === button);
    if (i >= 0) document.getElementById(pickerId(s.id, i))?.focus();
  };
  return (
    <li className={`pt-card${isStart ? ' start' : ''}`} style={{ width: CARD_W }} aria-label={s.name} data-screen={s.id}>
      <div className="pt-card-head">
        <strong dir="auto">{s.name}</strong>
        <span className="ws-version">v{d.version}</span>
        <span className="grow" />
        {isStart ? (
          <span className="pt-start" title="Play starts here">
            <Flag size={11} /> Start
          </span>
        ) : (
          <button type="button" className="pt-make-start" disabled={busy} onClick={onStart} aria-label={`Make ${s.name} the start screen`}>
            Make start
          </button>
        )}
      </div>
      {s.drawings.length > 1 && (
        <ul className="pt-options" aria-label={`Options of ${s.name}`}>
          {s.drawings.map((o) => (
            <li key={o.version}>
              <button type="button" className={o.version === d.version ? 'on' : ''} aria-pressed={o.version === d.version} title={o.name ? `Option ${o.letter}: ${o.name}` : undefined} onClick={() => onTab(o.letter!)}>
                Option {o.letter}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Always laid out left to right around the frame: the drawing keeps its own direction inside it. */}
      <div className="pt-preview" dir="ltr" style={{ height: PREVIEW.height }}>
        {page ? (
          <div style={{ width: size.width * k, height: size.height * k, overflow: 'hidden' }}>
            <PrototypeFrame
              html={d.frames[page]!}
              title={`${s.name}, ${page}`}
              className="pt-frame"
              on={links.filter((l) => !l.broken).map((l) => l.button)}
              broken={links.filter((l) => l.broken).map((l) => l.button)}
              picked={picked}
              onButton={pick}
              frameProps={{
                style: { width: size.width, height: size.height, transform: `scale(${k})`, transformOrigin: '0 0' },
                tabIndex: -1,
              }}
            />
          </div>
        ) : (
          <p className="note">No drawing</p>
        )}
      </div>
      {page && frame && page !== frame && (
        <p className="pt-only">
          No {frameName(frame)} page: showing {frameName(page)}.
        </p>
      )}
      {d.buttons.length === 0 && !missing.length ? (
        <p className="pt-only">No buttons or links on this screen.</p>
      ) : (
        <ul className="pt-buttons" aria-label={`Buttons on ${s.name}`}>
          {d.buttons.map((b, i) => (
            <ButtonRow
              key={b.name}
              id={pickerId(s.id, i)}
              screen={s}
              name={b.name}
              note={frame && !b.frames.includes(frame) ? `${b.frames.map(frameName).join(', ')} only` : null}
              link={linkOf(links, s.id, b.name)}
              others={others}
              left={data.left}
              picked={picked === b.name}
              busy={busy}
              onPick={() => onPick(picked === b.name ? null : b.name)}
              onLink={(v) => onLink(b.name, v)}
            />
          ))}
          {missing.map((l) => (
            <MissingRow key={`gone:${l.button}`} link={l} gone={linkOf(data.links, s.id, l.button)?.broken === 'button-gone'} busy={busy} onUnlink={() => onLink(l.button, '')} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A link whose button is not on the drawing shown: it can be taken away only when no option has the button. */
function MissingRow({ link: l, gone, busy, onUnlink }: { link: ProtoLink; gone: boolean; busy: boolean; onUnlink(): void }) {
  return (
    <li className="pt-btn broken">
      <span className="pt-btn-name gone" dir="auto">
        {l.button}
      </span>
      {gone ? (
        <button type="button" className="pt-unlink" disabled={busy} onClick={onUnlink}>
          Take the link away
        </button>
      ) : (
        <span />
      )}
      <span className="pt-warn" role="note">
        <AlertTriangle size={12} /> {l.warning}
      </span>
    </li>
  );
}

function ButtonRow({
  id,
  screen,
  name,
  note,
  link,
  others,
  left,
  picked,
  busy,
  onPick,
  onLink,
}: {
  id: string;
  screen: ProtoScreen;
  name: string;
  note: string | null;
  link: ProtoLink | undefined;
  others: ProtoScreen[];
  left: { id: string; name: string }[];
  picked: boolean;
  busy: boolean;
  onPick(): void;
  onLink(value: string): void;
}) {
  const value = pickValue(link);
  const target = link && 'screen' in link.to ? link.to.screen : null;
  const outTarget = target && !others.some((x) => x.id === target) ? target : null;
  return (
    <li className={`pt-btn${picked ? ' on' : ''}${link?.broken ? ' broken' : ''}`}>
      <button type="button" className="pt-btn-name" aria-pressed={picked} onClick={onPick} dir="auto" title={`Select ${name}`}>
        {link && !link.broken ? 'back' in link.to ? <CornerUpLeft size={12} aria-hidden /> : <Link2 size={12} aria-hidden /> : null}
        <span dir="auto">{name}</span>
        {note && <span className="pt-btn-note">{note}</span>}
      </button>
      <select id={id} aria-label={`${name} on ${screen.name} leads to`} value={value} disabled={busy} onChange={(e) => onLink(e.target.value)} onFocus={() => !picked && onPick()}>
        <option value="">No link</option>
        <option value="back">Back</option>
        {others.map((x) => (
          <option key={x.id} value={`screen:${x.id}`}>
            {x.name}
          </option>
        ))}
        {outTarget && (
          <option value={value} disabled>
            {left.find((x) => x.id === outTarget)?.name ?? outTarget} (no drawing)
          </option>
        )}
      </select>
      {link?.warning && (
        <span className="pt-warn" role="note">
          <AlertTriangle size={12} /> {link.warning}
        </span>
      )}
    </li>
  );
}

/** The tabs for the whole flow, in the map and in Play: "In use", "Option A" …; none while there are no options. */
export function PrototypeTabs({ tabs, picked, onPick }: { tabs: ProtoTab[]; picked: string; onPick(id: string): void }) {
  if (tabs.length < 2) return null;
  return (
    <div className="seg pt-tabs" role="tablist" aria-label="Options">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === picked} className={t.id === picked ? 'on' : ''} onClick={() => onPick(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

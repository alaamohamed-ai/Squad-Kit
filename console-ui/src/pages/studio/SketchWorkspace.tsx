import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ChevronLeft, Lock } from 'lucide-react';
import { PROJECT, api } from '../../api/client';
import { askCards, chatsKey, emptyScreenText, frameName, isApproved, lookingAtText, readWorkspaceView, saveStudioTab, saveWorkspaceView, sketchKey, sketchesKey, type ConversationData, type SketchFull, type WorkspaceView } from '../../lib/studio';
import { ChatPanel } from './ChatPanel';
import { ScreenApproval } from './ScreenApproval';
import { ScreenTabs } from './ScreenTabs';
import { SketchNameHeader } from './SketchActions';
import { VariantCards } from './VariantCards';

/* ── A sketch's workspace (US-05, US-52) ──
   The chat with the AI Designer is always open on the left: it is how the screens are made and changed. On the right,
   the chosen variant of the picked screen in the picked frame; when it came from an ask for variants, that ask's
   variants side by side, each with "Use this one" (US-17); a pick adds its line to the open conversation (US-18).
   Which screen and frame are picked stays in this browser tab (AB-127.1); opening the workspace writes nothing. A click on the name in the header renames the sketch (US-13).
   The screen tabs always end with "+ Add screen" (US-11): a new tab, "New screen", selected at once, that the AI
   Designer draws and names from the chat; each tab has a Delete that asks first.
   The header's "Approve screen" (US-15) freezes the screen shown, with a lock, "Approved by Alaa · time" and Reopen;
   while it is approved, its "Use this one" and its tab's Delete are off, and the chat says the Designer leaves it. */

export function SketchWorkspacePage() {
  const { id } = useParams({ from: '/studio/sketches/$id' });
  return <SketchWorkspace project={PROJECT ?? ''} id={id} />;
}

export function SketchWorkspace({ project, id }: { project: string; id: string }) {
  const base = `/api/v1/studio/sketches/${encodeURIComponent(id)}`;
  const key = sketchKey(project, id);
  const qc = useQueryClient();
  const sketch = useQuery({ queryKey: key, queryFn: () => api<SketchFull>(base) });
  const [view, setView] = useState<WorkspaceView>(() => readWorkspaceView(project, id));
  const choose = (next: WorkspaceView) => {
    const v = { ...view, ...next };
    if ('screen' in next && next.screen === undefined) delete v.screen;
    setView(v);
    saveWorkspaceView(project, id, v);
  };
  const answered = useCallback(() => {
    void qc.invalidateQueries({ queryKey: key, exact: true });
    void qc.invalidateQueries({ queryKey: sketchesKey(project) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, project, id]);

  // While the AI Designer works (US-08), the sketch is read again at each step: its new name, its first screen.
  const [doing, setDoing] = useState<string | null>(null);
  const working = useCallback(
    (now: string | null) => {
      setDoing(now);
      if (now) void qc.invalidateQueries({ queryKey: key, exact: true });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, project, id],
  );

  // The conversation open in the chat: "Use this one", Approve and Reopen add their line there (US-18, US-15, AB-143.1).
  const [chat, setChat] = useState<string | null>(null);
  const picked = useCallback(
    (answer: { conversation: ConversationData | null }) => {
      const chats = chatsKey(project, 'sketch', id);
      if (answer.conversation) qc.setQueryData([...chats, answer.conversation.id], answer.conversation);
      void qc.invalidateQueries({ queryKey: chats, exact: true });
      answered();
    },
    [qc, project, id, answered],
  );

  const s = sketch.data;
  const screens = [...(s?.screens ?? [])].sort((a, b) => a.order - b.order);
  const screen = screens.find((x) => x.id === view.screen) ?? screens[0];
  const frames = s?.frames ?? [];
  const frame = view.frame && frames.includes(view.frame) ? view.frame : frames[0];
  const variant = screen?.variants.find((v) => v.version === screen.chosen);
  const html = variant && frame ? variant.html[frame] : undefined;
  // The chosen variant came from an ask (US-17): that ask's variants show side by side.
  const cards = screen ? askCards(screen) : null;
  // Approved (US-15): locked until Reopen.
  const locked = isApproved(screen);

  return (
    <>
      <div className="top">
        <Link to="/studio" className="sk-back" onClick={() => saveStudioTab(project, 'sketches')}>
          <ChevronLeft size={15} /> Sketches
        </Link>
        {s ? <SketchNameHeader key={`${s.id}:${s.name}`} project={project} sketch={{ id: s.id, name: s.name, stamp: s.stamp, screens: s.screens.length }} /> : <h1 dir="auto">{sketch.isError ? 'Sketch' : '…'}</h1>}
        {s && <span className="note">{s.designSystem ? `Follows ${s.designSystem.name ?? s.designSystem.id}` : 'Follows no design system'}</span>}
        <span className="grow" />
        {s && screen && <ScreenApproval key={screen.id} sketch={s} screen={screen} chat={chat} working={doing !== null} onDone={picked} onRefused={answered} />}
      </div>
      {sketch.isError ? (
        <div className="page">
          <p className="note bad">{sketch.error.message}</p>
        </div>
      ) : (
        <div className="ws">
          {s ? (
            <ChatPanel
              project={project}
              kind="sketch"
              id={id}
              lookingAt={lookingAtText(s.name, screen?.name, frame)}
              look={{ ...(screen ? { screen: screen.id } : {}), ...(frame ? { frame } : {}) }}
              stamp={s.stamp}
              onAnswered={answered}
              onWorking={working}
              designSystem={s.designSystem ? (s.designSystem.name ?? s.designSystem.id) : null}
              onConversation={setChat}
              locked={locked ? screen!.name : null}
            />
          ) : (
            <aside className="dc" aria-label="Chat with the AI Designer" />
          )}
          <section className="ws-main" aria-label="Screens">
            {s && (
              <div className="ws-bar">
                <ScreenTabs sketch={s} screens={screens} selected={screen?.id} onSelect={(x) => choose({ screen: x })} onChanged={answered} />
                {variant && (
                  <span className={`ws-version${locked ? ' locked' : ''}`} title={locked ? `${screen!.name} is approved at v${variant.version}` : undefined}>
                    {locked && <Lock size={11} aria-label="Approved" />}v{variant.version}
                  </span>
                )}
                {frames.length > 0 && (
                  <div className="seg ws-frames" role="tablist" aria-label="Frames">
                    {frames.map((f) => (
                      <button key={f} role="tab" aria-selected={f === frame} className={f === frame ? 'on' : ''} onClick={() => choose({ frame: f })}>
                        {frameName(f)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="ws-view">
              {!s ? (
                <p className="note">Reading the sketch…</p>
              ) : cards && screen && frame ? (
                <VariantCards
                  key={`${screen.id}:${s.stamp}`}
                  sketch={s.id}
                  screen={{ id: screen.id, name: screen.name }}
                  frame={frame}
                  cards={cards}
                  stamp={s.stamp}
                  chat={chat}
                  working={doing !== null}
                  locked={locked}
                  onPicked={picked}
                />
              ) : html !== undefined ? (
                <iframe className={`ws-frame ${frame}`} title={`${screen!.name}, ${frame}`} sandbox="" srcDoc={html} />
              ) : doing ? (
                <p className="ws-empty" role="status">
                  The AI Designer draws here. {doing}…
                </p>
              ) : (
                <p className="ws-empty">
                  {screens.length ? emptyScreenText(screen!.name, frame) : 'No screens yet. Tell the AI Designer in the chat what to draw, or ask it a question first.'}
                </p>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

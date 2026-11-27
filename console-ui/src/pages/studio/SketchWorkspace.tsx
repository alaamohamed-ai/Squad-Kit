import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { PROJECT, api } from '../../api/client';
import { askCards, chatsKey, emptyScreenText, frameName, isApproved, lookingAtText, readWorkspaceView, saveStudioTab, saveWorkspaceView, sketchKey, sketchesKey, type ConversationData, type SketchFull, type WorkspaceView } from '../../lib/studio';
import { draftsFor, type DraftsView } from '../../lib/studio-work';
import { ChatPanel } from './ChatPanel';
import { DraftFrames, PageFrame } from './DraftFrames';
import { PrototypeView } from './PrototypeView';
import { ScreenApproval } from './ScreenApproval';
import { ScreenTabs } from './ScreenTabs';
import { SketchNameHeader } from './SketchActions';
import { SketchMenu } from './SketchMenu';
import { SketchSkeleton } from './Skeletons';
import { VariantCards } from './VariantCards';
import { useMarkStudioSeen } from '../../lib/studio-seen';

/* ── A sketch's workspace (US-05, US-52) ──
   The chat with the AI Designer is always open on the left: it is how the screens are made and changed. On the right,
   the chosen variant of the picked screen in the picked frame; when it came from an ask for variants, that ask's
   variants side by side, each with "Use this one" (US-17); a pick adds its line to the open conversation (US-18).
   Which screen and frame are picked stays in this browser tab (AB-127.1); opening the workspace writes nothing. A click on the name in the header renames the sketch (US-13).
   The screen tabs always end with "+ Add screen" (US-11): a new tab, "New screen", selected at once, that the AI
   Designer draws and names from the chat; each tab has a Delete that asks first.
   The header's "Approve screen" (US-15) freezes the screen shown, with a lock, "Approved by Alaa · time" and Reopen;
   while it is approved, its "Use this one" and its tab's Delete are off, and the chat says the Designer leaves it.
   The header's ⋯ menu (SketchMenu.tsx) has Rename, Duplicate and Delete, and the Export group (US-46).
   "Screens | Prototype" in the header, right after the sketch's name (US-54): the sketch opens on Screens; on Prototype the chat is hidden
   (it stays as it was, for coming back) and the prototype's map takes the full width, with its own one top row (PrototypeView.tsx).
   While the AI Designer draws (US-57), the screen shows the work's frames, A, B, C, each drawing as soon as it is done,
   or its current drawing marked "Redrawing"; drawings that could not save stay "Not saved" (DraftFrames.tsx). */

/** What the workspace shows: the screens with the chat, or the prototype of the approved screens. */
type WorkspaceMode = 'screens' | 'prototype';

export function SketchWorkspacePage() {
  const { id } = useParams({ from: '/studio/sketches/$id' });
  return <SketchWorkspace project={PROJECT ?? ''} id={id} />;
}

export function SketchWorkspace({ project, id }: { project: string; id: string }) {
  // Opening any Studio page, a sketch from a link too, takes the sidebar's New away (AB-178.1).
  useMarkStudioSeen(project);
  const base = `/api/v1/studio/sketches/${encodeURIComponent(id)}`;
  const key = sketchKey(project, id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sketch = useQuery({ queryKey: key, queryFn: () => api<SketchFull>(base) });
  const [view, setView] = useState<WorkspaceView>(() => readWorkspaceView(project, id));
  const [mode, setMode] = useState<WorkspaceMode>('screens');
  const proto = mode === 'prototype';
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

  // The frames of the AI Designer's work going on, or its drawings kept "Not saved" (US-57).
  const [drafts, setDrafts] = useState<DraftsView | null>(null);

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
  const shown = draftsFor(drafts, screen?.id, screens.map((x) => x.id));
  const savedAnyway = (data: ConversationData) => {
    const chats = chatsKey(project, 'sketch', id);
    qc.setQueryData([...chats, data.id], data);
    void qc.invalidateQueries({ queryKey: chats, exact: true });
    answered();
  };

  const current =
    !s ? (
      <SketchSkeleton />
    ) : shown.length && frame && (!shown[0]!.redraw || shown.length > 1) ? (
      <DraftFrames view={drafts!} drafts={shown} frame={frame} sketch={s.id} chat={chat} stamp={s.stamp} onSaved={savedAnyway} />
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
      <PageFrame key={`${screen!.id}:${frame}`} html={html} frame={frame!} title={`${screen!.name}, ${frame}`} />
    ) : doing ? (
      <p className="ws-empty" role="status">
        The AI Designer draws here. {doing}…
      </p>
    ) : (
      <p className="ws-empty">
        {screens.length ? emptyScreenText(screen!.name, frame) : 'No screens yet. Tell the AI Designer in the chat what to draw, or ask it a question first.'}
      </p>
    );

  return (
    <>
      <div className="top">
        <Link to="/studio" className="sk-back" onClick={() => saveStudioTab(project, 'sketches')}>
          <ChevronLeft size={15} /> Sketches
        </Link>
        {s ? <SketchNameHeader key={`${s.id}:${s.name}`} project={project} sketch={{ id: s.id, name: s.name, stamp: s.stamp, screens: s.screens.length }} /> : <h1 dir="auto">{sketch.isError ? 'Sketch' : '…'}</h1>}
        {/* One fixed place for both views (US-54), right after the name: the screen tabs keep their whole row. */}
        {s && (
          <div className="seg ws-modes" role="tablist" aria-label="View">
            {(['screens', 'prototype'] as const).map((m) => (
              <button key={m} role="tab" aria-selected={m === mode} className={m === mode ? 'on' : ''} onClick={() => setMode(m)}>
                {m === 'screens' ? 'Screens' : 'Prototype'}
              </button>
            ))}
          </div>
        )}
        {s && <span className="note ws-follows">{s.designSystem ? `Follows ${s.designSystem.name ?? s.designSystem.id}` : 'Follows no design system'}</span>}
        <span className="grow" />
        {s && (
          <SketchMenu
            project={project}
            place="header"
            sketch={{ id: s.id, name: s.name, stamp: s.stamp, screens: s.screens.length }}
            onDeleted={() => {
              saveStudioTab(project, 'sketches');
              void navigate({ to: '/studio' });
            }}
          />
        )}
        {s && screen && !proto && <ScreenApproval key={screen.id} sketch={s} screen={screen} version={variant?.version ?? null} chat={chat} working={doing !== null} onDone={picked} onRefused={answered} />}
      </div>
      {sketch.isError ? (
        <div className="page">
          <p className="note bad">{sketch.error.message}</p>
        </div>
      ) : (
        <div className={`ws${proto ? ' proto' : ''}`}>
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
              onDrafts={setDrafts}
            />
          ) : (
            <aside className="dc" aria-label="Chat with the AI Designer" />
          )}
          <section className="ws-main" aria-label={proto ? 'Prototype' : 'Screens'}>
            {/* On Prototype, its own one row holds the frame switch (US-58): no second row. */}
            {s && !proto && (
              <div className="ws-bar">
                <ScreenTabs sketch={s} screens={screens} selected={screen?.id} onSelect={(x) => choose({ screen: x })} onChanged={answered} />
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
            {s && proto ? (
              <PrototypeView project={project} sketch={s.id} frame={frame} frames={frames} onFrame={(f) => choose({ frame: f })} onChanged={answered} />
            ) : (
              <div className="ws-view">
                {s && frame && shown.length === 1 && shown[0]!.redraw ? (
                  <DraftFrames view={drafts!} drafts={shown} frame={frame} sketch={s.id} chat={chat} stamp={s.stamp} onSaved={savedAnyway}>
                    {current}
                  </DraftFrames>
                ) : (
                  current
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { PROJECT, api, assetUrl } from '../../api/client';
import { saveStudioTab, type ChatMessageView, type SketchRow } from '../../lib/studio';

/* ── A sketch's workspace (US-05, AB-130) ──
   For now: the sketch's name, the way back to the Sketches tab, and its conversation as kept on this computer, with
   each message's pictures. The full conversation with the AI Designer comes in US-08. */

export function SketchWorkspacePage() {
  const { id } = useParams({ from: '/studio/sketches/$id' });
  return <SketchWorkspace project={PROJECT ?? ''} id={id} />;
}

export function SketchWorkspace({ project, id }: { project: string; id: string }) {
  const base = `/api/v1/studio/sketches/${encodeURIComponent(id)}`;
  const sketch = useQuery({ queryKey: ['studio', project, 'sketch', id], queryFn: () => api<SketchRow>(base) });
  const chat = useQuery({ queryKey: ['studio', project, 'sketch', id, 'chat'], queryFn: () => api<{ messages: ChatMessageView[] }>(`${base}/chat`) });

  return (
    <>
      <div className="top">
        <Link to="/studio" className="sk-back" onClick={() => saveStudioTab(project, 'sketches')}>
          <ChevronLeft size={15} /> Sketches
        </Link>
        <h1 dir="auto">{sketch.data?.name ?? (sketch.isError ? 'Sketch' : '…')}</h1>
        {sketch.data && <span className="note">{sketch.data.designSystem ? `Follows ${sketch.data.designSystem.name ?? sketch.data.designSystem.id}` : 'Follows no design system'}</span>}
      </div>
      <div className="scroll">
        <div className="page">
          {sketch.isError ? (
            <p className="note bad">{sketch.error.message}</p>
          ) : chat.isPending ? (
            <p className="note">Reading the conversation…</p>
          ) : chat.isError ? (
            <p className="note bad">{chat.error.message}</p>
          ) : !chat.data.messages.length ? (
            <p className="note">No messages yet.</p>
          ) : (
            <ol className="sk-chat" aria-label="Conversation">
              {chat.data.messages.map((m, i) => (
                <li key={i} className={`sk-msg ${m.role}`} dir="auto">
                  {m.text}
                  {m.pictures.length > 0 && (
                    <ul className="sk-pics" aria-label="Pictures">
                      {m.pictures.map((p, j) => (
                        <li key={p}>
                          <img src={assetUrl(p)} alt={`Picture ${j + 1}`} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </>
  );
}

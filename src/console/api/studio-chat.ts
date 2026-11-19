import type { Context, Hono } from 'hono';
import type { BoardPaths } from '../../board/store.js';
import type { ChatOwner } from '../../board/studio.js';
import { chatOwnerName, conversationPicture, currentConversation, listConversations, newConversation, readConversation } from '../../board/studio-chats.js';
import { chatWorking, startChatJob, stopChatJob } from '../../engine/studio-chat-runs.js';

/**
 * The chat with the AI Designer (US-52, AB-177), for a sketch and for a design system alike, under
 * /api/v1/studio/sketches/<id>/chats and /api/v1/studio/design-systems/<id>/chats. Conversations stay on this computer
 * (AB-128.2): list them, open one, start a new one, send a message with its pictures, follow what the Designer is
 * doing, and stop it. A message is answered in the background, one at a time per conversation; the board reads the
 * conversation again to follow it. `squad studio chat` calls these same routes while the board is open.
 */

type Run = (c: Context, fn: () => unknown) => Promise<Response>;
type Body = (c: Context) => Promise<Record<string, unknown>>;

const KINDS: [string, ChatOwner['kind']][] = [
  ['sketches', 'sketch'],
  ['design-systems', 'design-system'],
];

export function mountStudioChatApi(app: Hono, bp: BoardPaths, h: { run: Run; body: Body }): void {
  for (const [segment, kind] of KINDS) {
    const base = `/api/v1/studio/${segment}/:id/chats`;
    const owner = (c: Context): ChatOwner => ({ kind, id: c.req.param('id') ?? '' });
    const pictureUrl = (c: Context, chat: string, file: string) => `/api/v1/studio/${segment}/${encodeURIComponent(owner(c).id)}/chats/${encodeURIComponent(chat)}/pictures/${encodeURIComponent(file)}`;
    const view = (c: Context, chat: string) => {
      const o = owner(c);
      const v = readConversation(bp, o, chat);
      return {
        id: v.id,
        owner: { ...o, name: chatOwnerName(bp, o) },
        startedAt: v.startedAt,
        messages: v.messages.map((m) => ({ ...m, pictures: m.pictures.map((f) => pictureUrl(c, chat, f)) })),
        working: chatWorking(bp, o, chat),
      };
    };

    // Every conversation, newest first, and the one the chat opens on. Reading writes nothing.
    app.get(base, (c) => h.run(c, () => ({ conversations: listConversations(bp, owner(c)), current: currentConversation(bp, owner(c)) })));
    // New conversation: an empty one after the others, which all stay. No version is touched.
    app.post(base, (c) => h.run(c, () => newConversation(bp, owner(c))));
    app.get(`${base}/:chat`, (c) => h.run(c, () => view(c, c.req.param('chat'))));
    // A message, with its pictures and what the person looks at: kept at once, answered in the background.
    app.post(`${base}/:chat/messages`, async (c) => {
      const b = await h.body(c);
      // A conversation still answering refuses it with 409 (ChatBusy), before anything is written.
      return h.run(c, () => {
        const started = startChatJob(bp, {
          owner: owner(c),
          chat: c.req.param('chat'),
          ...(typeof b.text === 'string' ? { text: b.text } : {}),
          ...(Array.isArray(b.pictures) ? { pictures: b.pictures as never } : {}),
          ...(b.lookingAt && typeof b.lookingAt === 'object' ? { lookingAt: b.lookingAt as never } : {}),
          ...(typeof b.stamp === 'string' ? { stamp: b.stamp } : {}),
          // "Skip" on the "no design system" alert (US-17): this one message draws its variants in plain styles.
          ...(b.plainStyles === true ? { plainStyles: true } : {}),
        });
        return view(c, started.chat);
      });
    });
    // Stop: the finished screens are kept.
    app.post(`${base}/:chat/stop`, (c) => h.run(c, () => ({ stopped: stopChatJob(bp, owner(c), c.req.param('chat')) })));
    app.get(`${base}/:chat/pictures/:file`, (c) => {
      let picture: ReturnType<typeof conversationPicture> = null;
      try {
        picture = conversationPicture(bp, owner(c), c.req.param('file'));
      } catch {
        picture = null;
      }
      if (!picture) return c.json({ error: 'This picture is not here.' }, 404);
      return c.body(new Uint8Array(picture.bytes), 200, { 'content-type': picture.type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
    });
  }
}

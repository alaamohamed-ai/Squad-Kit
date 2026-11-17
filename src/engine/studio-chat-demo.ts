import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import type { Sketch } from '../board/studio.js';
import { readConversation } from '../board/studio-chats.js';
import type { ChatOptions, ChatTurn, ChatWorker } from './studio-chat.js';
import type { ChatLanguage, ChatSort } from './studio-chat-prompts.js';

/**
 * The sample board's AI Designer (US-52): no AI and no sign-in, only a few fixed replies, so the Studio's chat can be
 * shown. A question gets an answer and a "maybe" a question back, both changing nothing; export, frames and approving
 * are "not available yet"; anything else changes every screen, one at a time, slowly enough to press Stop. A sketch
 * with no screens gets a booking form and its confirmation.
 */

/** How long the sample Designer takes on one screen, so its progress and Stop can be seen. */
export const DEMO_SCREEN_MS = 6000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const T = (language: ChatLanguage, en: string, ar: string) => (language === 'Arabic' ? ar : en);

/** What the sample Designer makes of a message, by a few plain rules. */
export function demoSort(text: string, language: ChatLanguage, lastReply: string | undefined, screens: { id: string; name: string }[]): ChatSort {
  const t = text.trim().toLowerCase();
  const unavailable: [RegExp, string, string, string][] = [
    [/export|pdf|png|download|تصدير|تنزيل/, 'export', 'Exporting', 'التصدير'],
    [/\bframe\b|\bmobile frame|\btablet\b|إطار/, 'add-frame', 'Adding a frame', 'إضافة إطار'],
    [/approve|اعتمد|اعتماد/, 'approve-screen', 'Approving a screen', 'اعتماد الشاشة'],
  ];
  for (const [re, action, en, ar] of unavailable) {
    if (re.test(t)) return { kind: 'unavailable', action, reply: T(language, `${en} is not available yet. It comes in a later version of the Studio; nothing changed.`, `${ar} غير متاح بعد. سيأتي في نسخة قادمة من الاستوديو، ولم يتغير شيء.`) };
  }
  // `\b` knows only Latin letters, so an Arabic word ends at a space, a mark or the end instead.
  const yes = /^(yes|yeah|yep|sure|ok|okay|please do|do it|go ahead)\b|^(نعم|أجل|حسنا|حسنًا|موافق|تمام)(?=[\s.,!،]|$)/.test(t);
  if (/\b(maybe|perhaps|might|what about|how about)\b|ربما|يمكن|ماذا عن/.test(t) && !yes) {
    return { kind: 'ask', reply: T(language, 'Do you want me to change it?', 'هل تريد أن أغيّره؟') };
  }
  const question = /[?؟]/.test(t) || /^(why|which|what|how|who|when|where|is|are|does|do|can|should)\b|^(لماذا|أي|ما|ماذا|كيف|هل|متى|أين)(?=\s|$)/.test(t);
  if (question && !yes) {
    let reply = T(language, 'Good question. This is the sample board, so my answers are fixed, but nothing changed: this was just my view.', 'سؤال جيد. هذه لوحة تجريبية، فإجاباتي ثابتة، لكن لم يتغير شيء: هذا رأيي فقط.');
    if (/colou?r|blue|لون|أزرق/.test(t)) reply = T(language, 'The blue is the main colour of the design system: it marks the one thing to do on the page, and it is dark enough to read on white. Nothing changed, this was just my view.', 'الأزرق هو اللون الرئيسي في نظام التصميم: يميّز الشيء الوحيد المطلوب في الصفحة، وهو داكن بما يكفي ليُقرأ على الأبيض. لم يتغير شيء، هذا رأيي فقط.');
    else if (/older|variant|elder|كبار|نسخة/.test(t)) reply = T(language, 'I would pick the one-page variant: everything is visible at once and there is one main button. Step by step is better when there are many days to choose from. Nothing changed, this was just my view.', 'أختار نسخة الصفحة الواحدة: كل شيء ظاهر مرة واحدة وفيها زر رئيسي واحد. الخطوات أفضل عندما تكثر الأيام. لم يتغير شيء، هذا رأيي فقط.');
    return { kind: 'answer', reply };
  }
  if (yes && lastReply === undefined) return { kind: 'answer', reply: T(language, 'Tell me what to change first.', 'أخبرني أولًا بما تريد تغييره.') };
  const work = screens.length ? screens.map((s) => ({ id: s.id, name: s.name, change: text })) : [{ name: 'Form', change: text }, { name: 'Confirmation', change: text }];
  return { kind: 'change', reply: T(language, screens.length ? `I will change ${work.length === 1 ? 'the screen' : `the ${work.length} screens`}, one at a time.` : 'I will draw the booking form and its confirmation.', screens.length ? 'سأغيّر الشاشات واحدة بعد الأخرى.' : 'سأرسم نموذج الحجز وصفحة التأكيد.'), screens: work };
}

const PAGE = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui,sans-serif;color:#0f172a;background:#fff}header{display:flex;align-items:center;gap:8px;padding:14px 24px;border-bottom:1px solid #e2e8f0;font-weight:600}header i{width:14px;height:14px;border-radius:3px;background:#1f6fb2;display:inline-block}main{padding:24px;max-width:720px}h1{font-size:22px;margin:0 0 6px}p{color:#64748b;margin:0 0 18px}label{display:block;font-size:13px;color:#475569;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}button{margin-top:22px;width:100%;padding:12px;border:0;border-radius:8px;background:#1f6fb2;color:#fff;font:inherit;font-weight:600}</style></head><body><header><i></i>Al Noor Clinic</header><main>${body}</main></body></html>`;

/** The sample pages for a sketch with no screens yet. */
function samplePage(name: string): string {
  if (/confirm/i.test(name)) return PAGE('<h1>Your visit is booked</h1><p>Tue 17 at 10:00 with Dr. Hana Saleh, Cardiology.</p><button>Add to calendar</button>');
  return PAGE('<h1>Book a follow-up</h1><p>Last visit: 2 Nov with Dr. Hana</p><label>Doctor</label><input value="Dr. Hana Saleh · Cardiology"><label>Reason</label><input value="Follow-up after test results"><label>Day and time</label><input value="Tue 17, 10:00"><button>Book visit</button>');
}

/** The sample change: bigger buttons, added to the page's own style. */
const BIGGER = '<style>button{font-size:1.2em;padding:16px 28px;border-radius:12px}</style>';

function changed(html: string): string {
  return html.includes('</head>') ? html.replace('</head>', `${BIGGER}</head>`) : `${BIGGER}${html}`;
}

export function demoWorker(bp: BoardPaths, turn: ChatTurn, sketch: Sketch | null, o: ChatOptions): ChatWorker {
  const L = turn.language;
  return {
    release: () => undefined,
    async sort() {
      await sleep(600, o.signal);
      if (o.signal?.aborted) return { error: 'You stopped the Designer.' };
      const before = readConversation(bp, turn.owner, turn.chat).messages.slice(0, -1);
      const lastReply = [...before].reverse().find((m) => m.role === 'designer')?.kind;
      return demoSort(turn.text, L, lastReply, sketch ? sketch.screens.map((s) => ({ id: s.id, name: s.name })) : [{ id: 'components', name: 'Components' }]);
    },
    async screen(w) {
      await sleep(DEMO_SCREEN_MS, o.signal);
      if (o.signal?.aborted) return { error: 'You stopped the Designer.' };
      const frames: Record<string, string> = {};
      for (const f of w.frames) {
        const file = w.files[f] ? path.join(bp.root, w.files[f]!) : null;
        frames[f] = file && fs.existsSync(file) ? changed(fs.readFileSync(file, 'utf8')) : samplePage(w.work.name);
      }
      return { frames, note: '' };
    },
    async system(w) {
      await sleep(DEMO_SCREEN_MS, o.signal);
      if (o.signal?.aborted) return { error: 'You stopped the Designer.' };
      const button = Object.entries(w.current.components)[0];
      return { components: button ? { [button[0]]: changed(button[1]) } : { button: changed(PAGE('<button>Book visit</button>')) }, tokens: { ...w.current.tokens, radius: '12px' }, note: '' };
    },
  };
}

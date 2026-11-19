import fs from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../board/store.js';
import { readDesignSystem, type Sketch } from '../board/studio.js';
import { readConversation } from '../board/studio-chats.js';
import { sketchNameFrom } from '../board/studio-start.js';
import type { ChatOptions, ChatTurn, ChatWorker } from './studio-chat.js';
import type { ChatLanguage, ChatSort } from './studio-chat-prompts.js';

/**
 * The sample board's AI Designer (US-52): no AI and no sign-in, only a few fixed replies, so the Studio's chat can be
 * shown. A question gets an answer and a "maybe" a question back, both changing nothing; export, frames and approving
 * are "not available yet"; "rename the sketch to …" and "duplicate this sketch" are done, and "delete this sketch" points to the card menu; anything else changes every screen, one at a time, slowly enough to press Stop. A sketch
 * with no screens gets a booking form and its confirmation. A sketch started from the start page (US-08) is named from
 * a few plain words ("book" → Booking / Form); a short first message gets two questions first, a longer one has its
 * first screen drawn once per variant, each a little different.
 *
 * Variants (US-17): "Draw 3 variants of the Form screen" draws A, B and C ("One page", "Step by step", "Big and
 * simple") in the design system's own colors, font and font sizes; with no number, 2 of each screen named. A message
 * that says "red" paints variant B's button a red the design system lacks, to show the token warning. "Use B" picks.
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

/**
 * The sample Designer's words for the sketch's own actions: each needs "the sketch" (or "this sketch", "my sketch"),
 * in English or Arabic, right after the verb, so a change to a part of a screen is never taken for one.
 */
const SKETCH = String.raw`(?:this|the|my)\s+sketch\b`;
const SKETCH_AR = '(?:هذا\\s+)?المخطط';
const SKETCH_WORDS = {
  delete: new RegExp(String.raw`\b(?:delete|remove)\s+${SKETCH}|(?:احذف|حذف)\s+${SKETCH_AR}`),
  rename: new RegExp(String.raw`\brename\s+${SKETCH}|\bcall\s+${SKETCH}|(?:أعد\s+تسمية|غيّر\s+اسم|غير\s+اسم)\s+${SKETCH_AR}`),
  duplicate: new RegExp(String.raw`\b(?:duplicate|copy)\s+${SKETCH}|\bmake\s+a\s+copy\s+of\s+${SKETCH}|(?:انسخ|كرّر|كرر)\s+${SKETCH_AR}`),
};

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, واحدة: 1, واحد: 1, اثنتين: 2, نسختين: 2, ثلاث: 3, ثلاثة: 3 };

/**
 * The variants a message asks for (US-17), by plain words: "Draw 3 variants of the Form screen", "Draw variants of Form
 * and Confirm", "ارسم ٣ نسخ". The number as written, or 2 with none; null when it asks for no variants.
 */
export function demoVariantsAsked(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!/\bvariants?\b|\boptions\b|\balternatives\b|نسخ|بدائل/.test(t)) return null;
  if (!/\b(?:draw|make|show|give|try|create|design|sketch)\b|ارسم|اعمل|صمم|أعطني/.test(t)) return null;
  const digit = /(\d+)\s*(?:more\s+)?(?:variants?|options|alternatives|نسخ|بدائل)/.exec(t)?.[1];
  if (digit) return Number(digit);
  const word = Object.keys(NUMBER_WORDS).find((w) => new RegExp(`(?:^|\\s)${w}\\s+(?:variants?|options|alternatives|نسخ|بدائل)`).test(t) || (w === 'نسختين' && t.includes(w)));
  return word ? NUMBER_WORDS[word]! : 2;
}

/** The screens a message names, in the order it names them: "Form and Confirm". */
function screensNamed(text: string, screens: { id: string; name: string }[]): { id: string; name: string }[] {
  const t = text.toLowerCase();
  return screens
    .map((s) => ({ s, at: t.search(new RegExp(`(?:^|[^\\p{L}])${s.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u')) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.s);
}

/** What the sample Designer makes of a message, by a few plain rules. */
export function demoSort(text: string, language: ChatLanguage, lastReply: string | undefined, screens: { id: string; name: string }[], onSketch = true, lookingAt?: string): ChatSort {
  const t = text.trim().toLowerCase();
  if (onSketch) {
    // The sketch's own actions (US-13): rename and duplicate are done; delete points to the card menu. Only a message
    // that names the sketch itself counts: "Delete the footer", "Copy the header from Checkout" and "Rename the button
    // to Confirm" are about a screen, so they go on to the rules below.
    if (SKETCH_WORDS.delete.test(t)) return { kind: 'unavailable', action: 'delete', reply: T(language, 'I do not delete sketches from the chat.', 'لا أحذف المخططات من المحادثة.') };
    const renamed = SKETCH_WORDS.rename.test(t) ? newNameIn(text) : null;
    if (renamed) return { kind: 'change', action: 'rename-sketch', name: renamed, reply: T(language, `I will rename the sketch to "${renamed}".`, `سأغيّر اسم المخطط إلى "${renamed}".`) };
    if (SKETCH_WORDS.duplicate.test(t)) return { kind: 'change', action: 'duplicate-sketch', reply: T(language, 'I will make a copy of the sketch.', 'سأنشئ نسخة من المخطط.') };
    // "Use B", "Use variant C" (US-17): the screen named, or the one the person looks at.
    const pick = /\buse\s+(?:variant\s+)?([abc])(?=\s*(?:$|[.,!;:]|\s+(?:for|of|on|in|instead)\b))/i.exec(text.trim()) ?? /(?:استخدم|اختر)\s+(?:النسخة\s+)?([abc])\b/i.exec(text);
    const looked = screens.find((s) => s.id === lookingAt) ?? screens[0];
    const on = screensNamed(text, screens)[0] ?? looked;
    if (pick && on) {
      const letter = pick[1]!.toUpperCase();
      return { kind: 'change', action: 'pick-variant', letter, screens: [{ id: on.id, name: on.name, change: text }], reply: T(language, `I will use variant ${letter} of ${on.name}.`, `سأستخدم النسخة ${letter} من "${on.name}".`) };
    }
    // "Draw 3 variants of the Form screen" (US-17): the screens named, or the one the person looks at.
    const variants = demoVariantsAsked(text);
    if (variants !== null) {
      const named = screensNamed(text, screens);
      const work = (named.length ? named : looked ? [looked] : [{ id: '', name: 'Form' }]).map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name, change: text }));
      const n = Math.min(variants, 3) * work.length;
      return {
        kind: 'change',
        variants,
        screens: work,
        reply: T(language, `I will draw ${n === 1 ? '1 variant' : `${n} variants`}, one at a time.`, `سأرسم ${n} من النسخ، واحدة بعد الأخرى.`),
      };
    }
  }
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

/** The sample Designer's names for a started sketch and its first screen, by a few plain words; else the message's first words. */
const DEMO_NAMES: [RegExp, string, string, string, string][] = [
  // The first that fits wins: "An admin dashboard with today's visits" is a dashboard, not a booking.
  [/dashboard|لوحة/i, 'Dashboard', 'Today', 'لوحة التحكم', 'اليوم'],
  [/\blog ?in\b|\bsign ?in\b|دخول/i, 'Login', 'Sign in', 'الدخول', 'تسجيل الدخول'],
  [/profile|ملف/i, 'Profile', 'Details', 'الملف الشخصي', 'التفاصيل'],
  [/checkout|\bcart\b|\bpay|دفع|سلة/i, 'Checkout', 'Cart', 'الدفع', 'السلة'],
  [/\bbook|appointment|visit|حجز|موعد/i, 'Booking', 'Form', 'الحجز', 'النموذج'],
];

export function demoNames(text: string, language: ChatLanguage): { sketchName: string; screenName: string } {
  const hit = DEMO_NAMES.find(([re]) => re.test(text));
  if (hit) return language === 'Arabic' ? { sketchName: hit[3], screenName: hit[4] } : { sketchName: hit[1], screenName: hit[2] };
  return { sketchName: sketchNameFrom(text).slice(0, 60), screenName: T(language, 'Main', 'الرئيسية') };
}

/** A first message this short gets questions first: there is too little to draw from. */
const FEW_WORDS = 5;

/**
 * The sample Designer's first turn on a sketch started from the start page (US-08): it names the sketch and its first
 * screen, then asks two questions when the message is short or a question, or else draws the first screen.
 */
export function demoFirstSort(text: string, language: ChatLanguage): ChatSort {
  const names = demoNames(text, language);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words < FEW_WORDS || /[?؟]\s*$/.test(text.trim())) {
    return {
      kind: 'ask',
      ...names,
      reply: T(
        language,
        `Two quick questions first: who uses it most, and on which device? What must ${names.screenName} show? Answer them, or say "just draw" and I start.`,
        `سؤالان سريعان أولًا: من يستخدمها أكثر، وعلى أي جهاز؟ وماذا يجب أن تعرض "${names.screenName}"؟ أجب، أو قل «ارسم» وأبدأ.`,
      ),
    };
  }
  return { kind: 'change', ...names, reply: T(language, `I will draw ${names.screenName} first.`, `سأرسم "${names.screenName}" أولًا.`), screens: [{ name: names.screenName, change: text }] };
}

/** The new name in "Rename the sketch to "Book a visit"": the words in quotes, or else the words after "to". */
function newNameIn(text: string): string | null {
  const quoted = /["“«']([^"”»']{1,120})["”»']/.exec(text)?.[1]?.trim();
  if (quoted) return quoted;
  const after = /\b(?:to|as)\s+(.{1,120})$/i.exec(text.trim())?.[1]?.replace(/[.!]+$/, '').trim();
  return after || null;
}

const PAGE = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui,sans-serif;color:#0f172a;background:#fff}header{display:flex;align-items:center;gap:8px;padding:14px 24px;border-bottom:1px solid #e2e8f0;font-weight:600}header i{width:14px;height:14px;border-radius:3px;background:#1f6fb2;display:inline-block}main{padding:24px;max-width:720px}h1{font-size:22px;margin:0 0 6px}p{color:#64748b;margin:0 0 18px}label{display:block;font-size:13px;color:#475569;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}button{margin-top:22px;width:100%;padding:12px;border:0;border-radius:8px;background:#1f6fb2;color:#fff;font:inherit;font-weight:600}</style></head><body><header><i></i>Al Noor Clinic</header><main>${body}</main></body></html>`;

/** The sample pages for a screen with no pages yet. */
function samplePage(name: string): string {
  if (/confirm/i.test(name)) return PAGE('<h1>Your visit is booked</h1><p>Tue 17 at 10:00 with Dr. Hana Saleh, Cardiology.</p><button>Add to calendar</button>');
  if (/sign|log|دخول/i.test(name)) return PAGE('<h1>Sign in</h1><p>Welcome back · أهلًا بعودتك</p><label>Phone number</label><input value="+966 5x xxx xxxx"><label>Password</label><input type="password" value="secret"><button>Sign in</button>');
  return PAGE('<h1>Book a follow-up</h1><p>Last visit: 2 Nov with Dr. Hana</p><label>Doctor</label><input value="Dr. Hana Saleh · Cardiology"><label>Reason</label><input value="Follow-up after test results"><label>Day and time</label><input value="Tue 17, 10:00"><button>Book visit</button>');
}

/** The sample variants' short names and ideas (US-17), A, B and C. */
export const DEMO_VARIANTS: { en: [string, string]; ar: [string, string] }[] = [
  { en: ['One page', 'Everything on one page: who, what and when, with one main button.'], ar: ['صفحة واحدة', 'كل شيء في صفحة واحدة، مع زر رئيسي واحد.'] },
  { en: ['Step by step', 'One choice per step: first the day, then the time, then confirm.'], ar: ['خطوة بخطوة', 'اختيار واحد في كل خطوة: اليوم، ثم الوقت، ثم التأكيد.'] },
  { en: ['Big and simple', 'One large card with big text and a big button, easy for older eyes.'], ar: ['كبير وبسيط', 'بطاقة واحدة كبيرة بخط كبير وزر كبير، سهلة لكبار السن.'] },
];

/** The colors, font and font sizes a sample variant is drawn with: the design system's own, so the token check passes. */
interface DemoLook {
  primary: string;
  ink: string;
  muted: string;
  surface: string;
  soft: string;
  line: string;
  font: string;
  sizes: { h1: string; body: string; small: string };
}

/** Plain, neutral styles: a sketch with no design system (US-17), or a design system with no colors. */
const PLAIN_LOOK: DemoLook = { primary: '#1f2937', ink: '#111827', muted: '#6b7280', surface: '#ffffff', soft: '#f3f4f6', line: '#e5e7eb', font: 'system-ui, sans-serif', sizes: { h1: '26px', body: '16px', small: '13px' } };

/** The look a sample variant takes from the design system's tokens: its colors by role, its font, its font sizes. */
export function demoLook(tokens: Record<string, unknown> | null): DemoLook {
  if (!tokens) return PLAIN_LOOK;
  const colors: [string, string][] = [];
  const fonts: string[] = [];
  const sizes: number[] = [];
  const walk = (x: unknown, key: string, depth: number) => {
    if (depth > 6) return;
    if (typeof x === 'string') {
      if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(x.trim())) colors.push([key.toLowerCase(), x.trim()]);
      else if (/font|famil/i.test(key) && !/\d/.test(x)) fonts.push(x.trim());
      else if (/size|font|text/i.test(key) && /^\d+(?:\.\d+)?px$/.test(x.trim())) sizes.push(parseFloat(x));
    } else if (x && typeof x === 'object' && !Array.isArray(x)) for (const [k, v] of Object.entries(x)) walk(v, `${key}.${k}`, depth + 1);
  };
  walk(tokens, '', 0);
  if (!colors.length) return { ...PLAIN_LOOK, ...(fonts[0] ? { font: fonts[0] } : {}) };
  const role = (re: RegExp, fallback: string) => colors.find(([k]) => re.test(k))?.[1] ?? fallback;
  const primary = role(/primary|brand|accent|main/, colors[0]![1]);
  const surface = role(/surface|background|\bbg|white|paper/, primary);
  const ink = role(/ink|text|fore|dark|black/, primary);
  const sorted = [...new Set(sizes)].sort((a, b) => a - b);
  const near16 = sorted.length ? sorted.reduce((a, b) => (Math.abs(b - 16) < Math.abs(a - 16) ? b : a)) : 16;
  return {
    primary,
    ink,
    surface,
    muted: role(/muted|subtle|secondary|grey|gray/, ink),
    soft: role(/soft|light|tint|subtle/, surface),
    line: role(/line|border|divider|stroke/, role(/soft|light/, ink)),
    font: fonts[0] ?? 'system-ui, sans-serif',
    sizes: sorted.length ? { h1: `${sorted[sorted.length - 1]}px`, body: `${near16}px`, small: `${sorted[0]}px` } : PLAIN_LOOK.sizes,
  };
}

/** What a sample screen shows, by its name: a confirmation, a sign in, or the booking form. */
function demoContent(name: string): { title: string; line: string; rows: [string, string][]; choices: string[]; button: string } {
  if (/confirm|تأكيد/i.test(name)) return { title: 'Your visit is booked', line: 'We sent the details to your phone.', rows: [['Doctor', 'Dr. Hana Saleh'], ['When', 'Tue 17 · 10:00'], ['Where', 'Floor 2, Room 14']], choices: ['Add to calendar', 'Get directions', 'Change'], button: 'Done' };
  if (/sign|log|دخول/i.test(name)) return { title: 'Sign in', line: 'Welcome back · أهلًا بعودتك', rows: [['Phone', '+966 5x xxx xxxx'], ['Password', '••••••••']], choices: ['Remember me', 'Forgot password'], button: 'Sign in' };
  return { title: 'Book a follow-up', line: 'Last visit: 2 Nov with Dr. Hana', rows: [['Doctor', 'Dr. Hana Saleh · Cardiology'], ['Reason', 'Follow-up after test results']], choices: ['Mon 16', 'Tue 17', 'Wed 18', 'Thu 19'], button: 'Book visit' };
}

/**
 * A sample variant's page (US-17), in the look of the design system: A keeps everything on one page, B goes step by
 * step, C is one big card. `red` paints the button a red the design system does not have, so its card shows a warning.
 */
export function demoVariantPage(screen: string, n: number, look: DemoLook, frame: string, red = false): string {
  const c = demoContent(screen);
  const small = frame === 'mobile';
  const button = red ? '#dc2626' : look.primary;
  const css = `*{box-sizing:border-box}body{margin:0;font-family:${look.font};font-size:${look.sizes.body};color:${look.ink};background:${look.soft}}
header{display:flex;align-items:center;justify-content:space-between;padding:${small ? '12px 16px' : '14px 32px'};background:${look.surface};border-bottom:1px solid ${look.line};font-weight:700}
header span{color:${look.muted};font-weight:400;font-size:${look.sizes.small}}
main{padding:${small ? '18px 16px' : '28px 32px'};max-width:880px}h1{margin:0 0 6px;font-size:${look.sizes.h1}}p{margin:0 0 16px;color:${look.muted}}
.card{background:${look.surface};border:1px solid ${look.line};border-radius:12px;padding:16px;margin-bottom:14px}
.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid ${look.line}}.row:last-child{border-bottom:0}.row b{color:${look.muted};font-weight:400}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chips i{font-style:normal;padding:8px 12px;border:1px solid ${look.line};border-radius:8px;background:${look.surface}}.chips i.on{background:${look.primary};color:${look.surface};border-color:${look.primary}}
.btn{display:block;text-align:center;background:${button};color:${look.surface};border-radius:10px;padding:14px;font-weight:700;margin-top:18px}
.steps{display:flex;gap:10px;align-items:center;margin-bottom:14px;color:${look.muted};font-size:${look.sizes.small}}.steps b{display:inline-flex;width:22px;height:22px;border-radius:50%;align-items:center;justify-content:center;background:${look.line};color:${look.ink}}.steps b.on{background:${look.primary};color:${look.surface}}
.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}.grid i{font-style:normal;text-align:center;padding:${small ? '8px 0' : '14px 0'};border-radius:8px;background:${look.surface};border:1px solid ${look.line}}.grid i.on{background:${look.primary};color:${look.surface}}
.big{max-width:560px;margin:${small ? '0' : '12px auto'};text-align:center}.big h1{font-size:${look.sizes.h1}}.big .btn{border-radius:999px;padding:18px}`;
  const rows = c.rows.map(([k, v]) => `<div class="row"><b>${k}</b><span>${v}</span></div>`).join('');
  const chips = c.choices.map((x, i) => `<i${i === 1 ? ' class="on"' : ''}>${x}</i>`).join('');
  let body: string;
  if (n === 2) {
    const days = Array.from({ length: 14 }, (_, i) => `<i${i === 9 ? ' class="on"' : ''}>${i + 8}</i>`).join('');
    body = `<div class="steps"><b class="on">1</b> ${c.choices[0] ? 'Choose' : 'Step'} <b>2</b> Check <b>3</b> Confirm</div><h1>${c.title}</h1><p>Step 1 of 3 · ${c.line}</p><div class="card"><div class="grid">${days}</div></div><span class="btn">Next</span>`;
  } else if (n === 3) body = `<div class="big"><h1>${c.title}</h1><p>${c.line}</p><div class="card">${rows}</div><span class="btn">${c.button}</span></div>`;
  else body = `<h1>${c.title}</h1><p>${c.line}</p><div class="card">${rows}</div><div class="card"><div class="chips">${chips}</div></div><span class="btn">${c.button}</span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><header>Al Noor Clinic<span>Visits · Doctors · Profile</span></header><main>${body}</main></body></html>`;
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
    async sort(brief) {
      await sleep(600, o.signal);
      if (o.signal?.aborted) return { error: 'You stopped the Designer.' };
      if (brief.naming) return demoFirstSort(turn.text, L);
      const before = readConversation(bp, turn.owner, turn.chat).messages.slice(0, -1);
      const lastReply = [...before].reverse().find((m) => m.role === 'designer')?.kind;
      // The answer to its questions: the first screen is still to be drawn.
      const first = brief.firstScreen && sketch?.screens[0];
      if (first) {
        const sorted = demoSort(turn.text, L, lastReply, [{ id: first.id, name: first.name }], true);
        return sorted.kind === 'change' && !sorted.action ? { ...sorted, reply: T(L, `I will draw ${first.name} now.`, `سأرسم "${first.name}" الآن.`) } : sorted;
      }
      return demoSort(turn.text, L, lastReply, sketch ? sketch.screens.map((s) => ({ id: s.id, name: s.name })) : [{ id: 'components', name: 'Components' }], sketch !== null, turn.lookingAt?.screen);
    },
    async screen(w) {
      await sleep(DEMO_SCREEN_MS, o.signal);
      if (o.signal?.aborted) return { error: 'You stopped the Designer.' };
      const frames: Record<string, string> = {};
      if (w.variant) {
        // A variant of an ask (US-17): in the design system's own look, with its name and idea. "Red" in the message
        // paints variant B's button a red the design system lacks, so its card shows the warning.
        const ds = sketch?.designSystem ? readDesignSystem(bp, sketch.designSystem.id) : null;
        const tokens = ds?.versions.find((v) => v.version === sketch!.designSystem!.version)?.tokens ?? null;
        const look = demoLook(tokens);
        const red = w.variant.n === 2 && /\bred\b|أحمر|احمر/i.test(turn.text);
        for (const f of w.frames) frames[f] = demoVariantPage(w.work.name, w.variant.n, look, f, red);
        const [variantName, idea] = DEMO_VARIANTS[(w.variant.n - 1) % DEMO_VARIANTS.length]![L === 'Arabic' ? 'ar' : 'en'];
        return { frames, note: '', variantName, idea };
      }
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

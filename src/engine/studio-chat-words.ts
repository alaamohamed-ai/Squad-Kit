import type { ChatLanguage } from './studio-chat-prompts.js';

/**
 * The AI Designer's own words in a chat reply (US-52, US-57), in the language of the message: what it did, what it
 * left, and why. Part of the Studio chat (studio-chat.ts); the steps of the work have theirs in studio-chat-progress.ts.
 */

export const CHAT_WORDS: Record<
  ChatLanguage,
  {
    changed: (list: string) => string;
    stopped: (list: string) => string;
    stoppedNothing: string;
    systemChanged: (v: number) => string;
    partly: (why: string) => string;
    renamed: (from: string, to: string) => string;
    duplicated: (copy: string, screens: number, from: string) => string;
    deleteHere: string;
    named: (sketch: string, screen: string) => string;
    screenNamed: (screen: string) => string;
    drewVariants: (n: number, screen: string | null, list: string) => string;
    stoppedVariants: (list: string) => string;
    offTokens: (variant: string, system: string, values: string) => string;
    plainStyles: string;
    needsDesignSystem: (sketch: string) => string;
    picked: (screen: string, variant: string) => string;
    noVariant: (screen: string, variant: string) => string;
    noScreen: (screen: string) => string;
    approved: (screens: string[]) => string;
    notSaved: (screens: string[]) => string;
  }
> = {
  English: {
    drewVariants: (n, screen, list) =>
      screen
        ? `Done. ${n === 1 ? `1 variant of ${screen} is drawn` : `${n} variants of ${screen} are drawn`}: ${list}. Variant A is in use; pick another with "Use this one".`
        : `Done. ${n} variants are drawn: ${list}. Each screen uses its variant A; pick another with "Use this one".`,
    stoppedVariants: (list) => `Stopped. The finished variants are kept: ${list}. Nothing half drawn was saved.`,
    offTokens: (variant, system, values) => `${variant} uses what "${system}" does not have: ${values}.`,
    plainStyles: 'Drawn in plain styles: the sketch has no design system.',
    needsDesignSystem: (sketch) => `"${sketch}" has no design system selected, so I drew nothing. Select one, then ask again, so the variants use its colors, fonts and sizes. Or skip to draw them in plain styles this once.`,
    picked: (screen, variant) => `Done. ${screen} now uses variant ${variant}. The other variants stay.`,
    noVariant: (screen, variant) => `${screen} has no variant ${variant}. Nothing changed.`,
    noScreen: (screen) => `The sketch has no screen "${screen}". Nothing changed.`,
    approved: (s) => (s.length === 1 ? `${s[0]} is approved, so I did not change it. Reopen it first.` : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]} are approved, so I did not change them. Reopen them first.`),
    named: (sketch, screen) => `I named the sketch "${sketch}" and its first screen "${screen}". You can rename both later.`,
    screenNamed: (screen) => `I named the new screen "${screen}". You can rename it later.`,
    renamed: (from, to) => `Done. "${from}" is now called "${to}".`,
    duplicated: (copy, n, from) => `Done. I made "${copy}" with ${n === 1 ? '1 screen' : `${n} screens`}, all Draft, and no conversation. "${from}" is unchanged.`,
    deleteHere: "To delete a sketch, use Delete in its ⋯ menu on the Sketches page: it asks first and says how many screens go with it.",
    notSaved: (s) => `Not saved: ${s.length === 1 ? `${s[0]} was` : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]} were`} changed elsewhere while I drew. The drawings are kept here on this computer. "Save them anyway" saves them as a new version on top; the other version stays in the history.`,
    changed: (list) => `Done. New versions: ${list}.`,
    stopped: (list) => `Stopped. The finished screens are kept as a new version: ${list}.`,
    stoppedNothing: 'Stopped before anything was finished. Nothing changed.',
    systemChanged: (v) => `Done. The design system is now version ${v}.`,
    partly: (why) => `The rest did not get done: ${why}`,
  },
  Arabic: {
    drewVariants: (n, screen, list) =>
      screen
        ? `تم. رسمت ${n} من نسخ "${screen}": ${list}. النسخة A هي المستخدمة؛ اختر غيرها بزر «Use this one».`
        : `تم. رسمت ${n} من النسخ: ${list}. كل شاشة تستخدم نسختها A؛ اختر غيرها بزر «Use this one».`,
    stoppedVariants: (list) => `توقفت. النسخ التي انتهت محفوظة: ${list}. لم يُحفظ شيء نصف مرسوم.`,
    offTokens: (variant, system, values) => `النسخة ${variant} تستخدم ما ليس في "${system}": ${values}.`,
    plainStyles: 'رسمتها بأنماط بسيطة: لا نظام تصميم لهذا المخطط.',
    needsDesignSystem: (sketch) => `لم يُختر نظام تصميم للمخطط "${sketch}"، فلم أرسم شيئًا. اختر نظامًا ثم اطلب مرة أخرى لتستخدم النسخ ألوانه وخطوطه وأحجامه، أو تخطَّ لأرسمها بأنماط بسيطة هذه المرة.`,
    picked: (screen, variant) => `تم. صارت "${screen}" تستخدم النسخة ${variant}. باقي النسخ محفوظة.`,
    noVariant: (screen, variant) => `لا توجد في "${screen}" نسخة ${variant}. لم يتغير شيء.`,
    noScreen: (screen) => `لا توجد في المخطط شاشة "${screen}". لم يتغير شيء.`,
    approved: (s) => (s.length === 1 ? `الشاشة "${s[0]}" معتمدة، فلم أغيّرها. أعد فتحها أولًا.` : `الشاشات ${s.map((x) => `"${x}"`).join(' و')} معتمدة، فلم أغيّرها. أعد فتحها أولًا.`),
    named: (sketch, screen) => `سمّيت المخطط "${sketch}" وشاشته الأولى "${screen}". يمكنك تغيير الاسمين لاحقًا.`,
    screenNamed: (screen) => `سمّيت الشاشة الجديدة "${screen}". يمكنك تغيير اسمها لاحقًا.`,
    renamed: (from, to) => `تم. صار اسم المخطط "${to}" بدل "${from}".`,
    duplicated: (copy, n, from) => `تم. أنشأت "${copy}" وفيه ${n} من الشاشات، كلها مسودة، وبلا محادثة. لم يتغير "${from}".`,
    deleteHere: 'لحذف مخطط، استخدم «حذف» من قائمة ⋯ في بطاقته في صفحة المخططات: يسألك أولًا ويذكر عدد الشاشات التي ستُحذف معه.',
    notSaved: (s) => `لم تُحفظ: تغيّرت ${s.map((x) => `"${x}"`).join(' و')} في مكان آخر أثناء الرسم. الرسوم محفوظة هنا على هذا الجهاز. زر «Save them anyway» يحفظها نسخة جديدة فوقها، وتبقى النسخة الأخرى في السجل.`,
    changed: (list) => `تم. النسخ الجديدة: ${list}.`,
    stopped: (list) => `توقفت. الشاشات التي انتهت محفوظة في نسخة جديدة: ${list}.`,
    stoppedNothing: 'توقفت قبل أن ينتهي أي شيء. لم يتغير شيء.',
    systemChanged: (v) => `تم. نظام التصميم الآن في النسخة ${v}.`,
    partly: (why) => `لم يكتمل الباقي: ${why}`,
  },
};

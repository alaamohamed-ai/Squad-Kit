import type { BoardPaths } from './store.js';
import { dumpYaml, writeNewVersion, writeShared } from './studio-files.js';
import { designSystemFile, frameFile, screenFile, sketchFile, tokensFile, variantDir, variantMetaFile } from './studio-paths.js';
import { AI_DESIGNER, type EditMark, type ScreenFile, type ScreenStatus, type SketchFile, type SystemFile, type VariantMetaFile } from './studio-read.js';

/**
 * The sample board's Studio (US-06, AB-131): one design system, "Brand", and six sketches with edits by different
 * people, so the Sketches home shows its cards: "Checkout" drawn for desktop and mobile and redrawn by the AI Designer
 * for Sara, "Profile" just made by Omar with nothing drawn yet, and "Onboarding" drawn for desktop only, renamed by
 * Sara yesterday, with two of its five screens approved. For US-13 (rename, duplicate, delete), "Booking" has two drawn
 * screens with one Approved, "Patient profile" three, and "Login" is a name already used. The files are the ones the Studio store writes, with times
 * in the past, so the sample board looks lived in.
 */

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const mark = (minutes: number, by: string, forWhom?: string): EditMark => ({ at: ago(minutes), by, ...(forWhom ? { for: forWhom } : {}) });

const BRAND = { primary: '#0d8a42', ink: '#10231a', muted: '#5f6f66', surface: '#ffffff', soft: '#eef5f0', line: '#dce5df' };

function page(body: string, width: 'desktop' | 'mobile'): string {
  const pad = width === 'desktop' ? '40px 56px' : '24px 20px';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sample</title>
<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:${BRAND.ink};background:${BRAND.soft}}
header{display:flex;align-items:center;justify-content:space-between;padding:${width === 'desktop' ? '18px 56px' : '14px 20px'};background:${BRAND.surface};border-bottom:1px solid ${BRAND.line}}
.logo{font-weight:800;color:${BRAND.primary};letter-spacing:-.02em;font-size:20px}
main{padding:${pad}}h1{margin:0 0 20px;font-size:${width === 'desktop' ? '34px' : '26px'};letter-spacing:-.02em}
.card{background:${BRAND.surface};border:1px solid ${BRAND.line};border-radius:14px;padding:20px;margin-bottom:16px}
.row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid ${BRAND.line}}
.row:last-child{border-bottom:0}.muted{color:${BRAND.muted};font-size:14px}
.btn{display:block;text-align:center;background:${BRAND.primary};color:#fff;border-radius:10px;padding:14px;font-weight:700}
.grid{display:grid;grid-template-columns:${width === 'desktop' ? '2fr 1fr' : '1fr'};gap:20px}
.thumb{width:56px;height:56px;border-radius:10px;background:${BRAND.soft}}
.dots{display:flex;gap:8px;justify-content:center;margin:20px 0}.dots i{width:10px;height:10px;border-radius:50%;background:${BRAND.line}}.dots i.on{background:${BRAND.primary}}
.hero{height:${width === 'desktop' ? '260px' : '200px'};border-radius:18px;background:linear-gradient(135deg,${BRAND.primary},#5cc489);margin-bottom:24px}
</style></head>
<body>${body}</body></html>
`;
}

function cart(width: 'desktop' | 'mobile'): string {
  const items = [
    ['Running shoes', '1 × $89.00'],
    ['Sport socks, 3 pairs', '2 × $12.00'],
    ['Water bottle', '1 × $18.00'],
  ]
    .map(([name, price]) => `<div class="row"><span style="display:flex;gap:12px;align-items:center"><span class="thumb"></span>${name}</span><span class="muted">${price}</span></div>`)
    .join('');
  return page(
    `<header><span class="logo">Brand</span><span class="muted">Cart (3)</span></header>
<main><h1>Your cart</h1><div class="grid"><div class="card">${items}</div>
<div class="card"><div class="row"><span>Subtotal</span><b>$131.00</b></div><div class="row"><span class="muted">Delivery</span><span class="muted">Free</span></div><br><span class="btn">Go to payment</span></div></div></main>`,
    width,
  );
}

function onboarding(title: string, line: string, step: number): string {
  const dots = [1, 2, 3, 4, 5].map((n) => `<i${n === step ? ' class="on"' : ''}></i>`).join('');
  return page(
    `<header><span class="logo">Brand</span><span class="muted">Skip</span></header>
<main style="max-width:760px;margin:0 auto;text-align:center"><div class="hero"></div><h1>${title}</h1><p class="muted">${line}</p><div class="dots">${dots}</div><span class="btn" style="max-width:320px;margin:0 auto">Next</span></main>`,
    'desktop',
  );
}

/** A simple page of the clinic sketches (US-13): a title, a line and a few rows, with one main button. */
function clinic(title: string, line: string, rows: [string, string][], button: string, width: 'desktop' | 'mobile'): string {
  const list = rows.map(([k, v]) => `<div class="row"><span class="muted">${k}</span><span>${v}</span></div>`).join('');
  return page(
    `<header><span class="logo">Al Noor Clinic</span><span class="muted">Visits · Doctors · Profile</span></header>
<main style="max-width:760px"><h1>${title}</h1><p class="muted">${line}</p><div class="card">${list}</div><span class="btn">${button}</span></main>`,
    width,
  );
}

const both = (f: (w: 'desktop' | 'mobile') => string) => ({ desktop: f('desktop'), mobile: f('mobile') });

interface DemoScreen {
  id: string;
  name: string;
  status: ScreenStatus;
  edited: EditMark;
  /** Each drawing, oldest first; the last one is chosen. */
  drawings: { minutes: number; by: string; for?: string; frames: Record<string, string> }[];
}

function writeSketch(bp: BoardPaths, id: string, sketch: SketchFile, screens: DemoScreen[]): void {
  writeShared(sketchFile(bp, id), dumpYaml(sketch));
  screens.forEach((s, i) => {
    s.drawings.forEach((d, j) => {
      const version = j + 1;
      const meta: VariantMetaFile = { madeAt: ago(d.minutes), madeBy: d.by, ...(d.for ? { madeFor: d.for } : {}) };
      const files: Record<string, string> = { [variantMetaFile(bp, id, s.id, version)]: dumpYaml(meta) };
      for (const [f, html] of Object.entries(d.frames)) files[frameFile(bp, id, s.id, version, f)] = html;
      writeNewVersion(variantDir(bp, id, s.id, version), files);
    });
    const file: ScreenFile = { name: s.name, order: i + 1, status: s.status, chosen: s.drawings.length || null, edited: s.edited };
    writeShared(screenFile(bp, id, s.id), dumpYaml(file));
  });
}

export interface DemoStudioOptions {
  /** False leaves the sample Studio empty (tests of a project with no Studio work); left out, its sketches are written. */
  studio?: boolean;
}

/**
 * Writes the sample Studio, so the Sketches home shows its cards (US-06): the sketches' edits are by the person's
 * teammates, Sara and Omar, and the AI Designer.
 */
export function seedDemoStudio(bp: BoardPaths, opts: DemoStudioOptions = {}): void {
  if (opts.studio === false) return;
  const system: SystemFile = { name: 'Brand', default: true, version: 1, madeAt: ago(60 * 24 * 30) };
  writeShared(designSystemFile(bp, 'brand'), dumpYaml(system));
  writeShared(tokensFile(bp, 'brand', 1), `${JSON.stringify({ colors: BRAND, font: 'system-ui', radius: '12px' }, null, 2)}\n`);
  const brand = { id: 'brand', version: 1 };

  // Drawn for desktop and mobile; its first screen redrawn by the AI Designer for Sara 10 minutes ago.
  writeSketch(bp, 'checkout', { name: 'Checkout', designSystem: brand, frames: ['desktop', 'mobile'], edited: mark(60 * 24 * 3, 'Sara') }, [
    {
      id: 'cart',
      name: 'Cart',
      status: 'ready',
      edited: mark(60 * 24 * 2, 'Sara'),
      drawings: [
        { minutes: 60 * 24 * 2, by: 'Sara', frames: { desktop: cart('desktop'), mobile: cart('mobile') } },
        { minutes: 10, by: AI_DESIGNER, for: 'Sara', frames: { desktop: cart('desktop'), mobile: cart('mobile') } },
      ],
    },
    { id: 'payment', name: 'Payment', status: 'draft', edited: mark(60 * 24 * 2, 'Sara'), drawings: [] },
    { id: 'done', name: 'Order placed', status: 'draft', edited: mark(60 * 24 * 2, 'Sara'), drawings: [] },
  ]);

  // Just made by Omar an hour ago: its first screen has no picture yet.
  writeSketch(bp, 'profile', { name: 'Profile', designSystem: brand, frames: ['desktop', 'mobile'], edited: mark(60, 'Omar') }, [
    { id: 'profile', name: 'Profile', status: 'draft', edited: mark(60, 'Omar'), drawings: [] },
  ]);

  // US-13's examples: "Booking" with 2 drawn screens, 1 Approved; "Patient profile" with 3; "Login", a used name.
  const form = (w: 'desktop' | 'mobile') => clinic('Book a follow-up', 'Last visit: 2 Nov with Dr. Hana', [['Doctor', 'Dr. Hana Saleh · Cardiology'], ['Day', 'Tue 17 Nov'], ['Time', '10:00']], 'Book visit', w);
  const booked = (w: 'desktop' | 'mobile') => clinic('Visit booked', 'We sent the details to your phone.', [['Doctor', 'Dr. Hana Saleh'], ['When', 'Tue 17 Nov · 10:00'], ['Where', 'Floor 2, Room 14']], 'Add to calendar', w);
  writeSketch(bp, 'booking', { name: 'Booking', designSystem: brand, frames: ['desktop', 'mobile'], edited: mark(60 * 24, 'Sara') }, [
    { id: 'form', name: 'Form', status: 'approved', edited: mark(30, 'Sara'), drawings: [{ minutes: 60 * 5, by: AI_DESIGNER, for: 'Sara', frames: both(form) }] },
    { id: 'confirmation', name: 'Confirmation', status: 'draft', edited: mark(60 * 5, 'Sara'), drawings: [{ minutes: 60 * 5, by: AI_DESIGNER, for: 'Sara', frames: both(booked) }] },
  ]);
  writeSketch(bp, 'patient-profile', { name: 'Patient profile', designSystem: brand, frames: ['desktop'], edited: mark(60 * 24 * 2, 'Omar') }, [
    ['overview', 'Overview', 'Mona Adel', [['Born', '12 Mar 1958'], ['Phone', '+20 100 555 0101']], 'Edit details'],
    ['visits', 'Visits', 'Your last visits', [['2 Nov', 'Dr. Hana Saleh'], ['14 Sep', 'Dr. Karim Nour']], 'Book a visit'],
    ['edit', 'Edit details', 'Keep your details up to date', [['Phone', '+20 100 555 0101'], ['Email', 'mona@example.com']], 'Save'],
  ].map(([id, name, line, rows, button]) => ({
    id: id as string,
    name: name as string,
    status: 'draft' as ScreenStatus,
    edited: mark(60 * 3, 'Omar'),
    drawings: [{ minutes: 60 * 3, by: 'Omar', frames: { desktop: clinic(name as string, line as string, rows as [string, string][], button as string, 'desktop') } }],
  })));
  writeSketch(bp, 'login', { name: 'Login', designSystem: brand, frames: ['desktop', 'mobile'], edited: mark(60 * 24 * 2, 'Sara') }, [
    { id: 'sign-in', name: 'Sign in', status: 'draft', edited: mark(60 * 24 * 2, 'Sara'), drawings: [{ minutes: 60 * 24 * 2, by: 'Sara', frames: both((w) => clinic('Sign in', 'Welcome back to Al Noor Clinic.', [['Phone', '+20 100 555 0101'], ['Password', '••••••••']], 'Sign in', w)) }] },
  ]);

  // Drawn for desktop only, renamed by Sara yesterday; two of its five screens approved.
  const steps: [string, string, string, ScreenStatus][] = [
    ['welcome', 'Welcome', 'Everything you need, in one place.', 'approved'],
    ['account', 'Your account', 'Sign in or make an account in a minute.', 'approved'],
    ['interests', 'Your interests', 'Pick what you like, we do the rest.', 'ready'],
    ['notifications', 'Notifications', 'Hear about orders and offers.', 'draft'],
    ['all-set', 'All set', 'You are ready to go.', 'draft'],
  ];
  writeSketch(
    bp,
    'onboarding',
    { name: 'Onboarding', designSystem: brand, frames: ['desktop'], edited: mark(60 * 26, 'Sara') },
    steps.map(([id, name, line, status], i) => ({
      id,
      name,
      status,
      edited: mark(60 * 24 * 4, 'Omar'),
      drawings: [{ minutes: 60 * 24 * 4, by: 'Omar', frames: { desktop: onboarding(name, line, i + 1) } }],
    })),
  );
}

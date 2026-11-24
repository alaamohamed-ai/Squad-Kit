import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportPlan, type Sketch } from '../src/board/studio.js';
import { makeSketchPdf } from '../src/engine/studio-pdf.js';
import { browserThere, launchPlaywright } from '../src/modules/playwright/index.js';
import type { Browser } from '../src/modules/browser/types.js';
import { inGuard } from './support/in-guard.js';

/**
 * US-46 Export sketch to PDF: squad-kit's own browser makes a real PDF in memory, with one tall page for a long
 * right-to-left screen. It uses the Playwright squad-kit already set up on this computer, and skips itself inside
 * squad-kit's guard and on a computer where it is not set up yet (it never downloads a browser in a test).
 */

const dir = path.join(os.homedir(), '.squad-kit', 'tools', 'playwright');
const ready = !inGuard && fs.existsSync(path.join(dir, 'node_modules', 'playwright-core', 'index.mjs')) && browserThere(dir) === true;
if (!ready) console.log(inGuard ? 'The real PDF check skips inside squad-kit\'s guard.' : 'The real PDF check skips: squad-kit\'s browser is not set up on this computer.');

const long = `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;font-family:Tahoma,sans-serif">
<h1>نموذج الحجز</h1>${Array.from({ length: 60 }, (_, i) => `<p style="height:60px;margin:0">حقل ${i + 1}</p>`).join('')}
<script>document.body.innerHTML = 'scripts ran'</script></body></html>`;

const sketch: Sketch = {
  id: 'arabic-booking',
  name: 'الحجز',
  designSystem: null,
  frames: ['desktop', 'mobile'],
  lastEdit: null,
  stamp: 's',
  screens: [{ id: 'form', name: 'نموذج الحجز', order: 1, status: 'draft', chosen: 1, variants: [{ version: 1, madeAt: '2026-11-20T10:00:00.000Z', frames: { desktop: long, mobile: long } }] }],
};

let browser: Browser | null = null;
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!ready)('a real PDF from squad-kit\'s browser', () => {
  it('prints the cover and one tall page per frame, in memory', async () => {
    const plan = exportPlan(sketch, { screens: ['form'], frames: ['desktop', 'mobile'] });
    const pdf = await makeSketchPdf(plan, { project: 'عيادة النور', browser: async () => (browser = await launchPlaywright({ dir })) });
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.match(/\/Type\s*\/Page\b/g)).toHaveLength(3);
    // The long screen (over 3,600 pixels) stays on one page, taller than the cover.
    const heights = [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => Number(m[2]));
    expect(Math.max(...heights)).toBeGreaterThan(2500);
  }, 120_000);
});

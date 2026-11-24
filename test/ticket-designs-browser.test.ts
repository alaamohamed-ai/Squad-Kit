import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealed } from '../src/engine/studio-pdf.js';
import { readPicture } from '../src/engine/proof-check.js';
import { browserThere, launchPlaywright } from '../src/modules/playwright/index.js';
import type { Browser } from '../src/modules/browser/types.js';
import { inGuard } from './support/in-guard.js';

/**
 * US-55 done when 4: squad-kit's own browser draws a ticket's design frame to a picture, sealed (its scripts do not
 * run) and at the frame's size, and an Arabic screen reads right to left: its words sit on the right. It uses the
 * Playwright squad-kit already set up on this computer, and skips itself inside squad-kit's guard and on a computer
 * where it is not set up yet (it never downloads a browser in a test).
 */

const dir = path.join(os.homedir(), '.squad-kit', 'tools', 'playwright');
const ready = !inGuard && fs.existsSync(path.join(dir, 'node_modules', 'playwright-core', 'index.mjs')) && browserThere(dir) === true;
if (!ready) console.log(inGuard ? 'The real drawing check skips inside squad-kit\'s guard.' : 'The real drawing check skips: squad-kit\'s browser is not set up on this computer.');

const arabic = `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#fff">
<div style="display:inline-block;width:200px;height:120px;background:#000"></div>
<script>document.body.style.background = '#f00'</script></body></html>`;

let browser: Browser | null = null;
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!ready)('a real sealed drawing from squad-kit\'s browser', () => {
  it('draws at the frame\'s size, with scripts off, right to left', async () => {
    browser = await launchPlaywright({ dir });
    const [desktop, mobile] = await browser.draw!({ pages: [{ html: sealed(arabic), width: 1280, height: 800 }, { html: sealed(arabic), width: 390, height: 844 }] });
    for (const [png, width, height] of [[desktop!, 1280, 800], [mobile!, 390, 844]] as const) {
      const p = readPicture(png)!;
      expect([p.width, p.height]).toEqual([width, height]);
      const at = (x: number, y: number) => Array.from(p.pixels!.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 3));
      // The block starts at the right edge in a right-to-left page, and the page stays white: the script did not run.
      expect(at(width - 10, 60)).toEqual([0, 0, 0]);
      expect(at(10, 60)).toEqual([255, 255, 255]);
      expect(at(10, height - 10)).toEqual([255, 255, 255]);
    }
  }, 120_000);
});

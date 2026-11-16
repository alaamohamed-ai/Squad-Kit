import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { RunOptions, RunResult } from '../src/modules/claude/direct.js';

/**
 * US-16 The AI Designer agent (AB-141): one Designer runner for every AI action in the Studio. It is on the agents
 * list with its three steps, reads files only, hands in its screens in one checked shape, and squad-kit saves them as
 * a new sketch version with the stamp read at the start. Claude Code itself never starts here: its direct run is
 * replaced, and each run's settings are kept to look at.
 */

const calls: RunOptions[] = [];
const answers: unknown[] = [];
/** Runs while the Designer works, before it hands in its answer: a teammate's change, for example. */
let during: (() => void) | null = null;
vi.mock('../src/modules/claude/direct.js', async (orig) => ({
  ...(await orig<typeof import('../src/modules/claude/direct.js')>()),
  runClaude: async (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    during?.();
    during = null;
    return { ok: true, text: '', structured: answers.length ? answers.shift() : undefined, sessionId: opts.resume ?? opts.sessionId ?? 'designer-1' } as RunResult;
  },
}));

const { AGENTS, STEPS, readAgent, writeAgent } = await import('../src/engine/agents.js');
const { resolveLevel } = await import('../src/engine/levels.js');
const { screensProblem } = await import('../src/engine/answers.js');
const { SCREENS_SCHEMA, MAX_SCREENS, MAX_PAGE_BYTES } = await import('../src/engine/studio-prompts.js');
const { runDesigner, DESIGNER_PERMISSIONS } = await import('../src/engine/studio-designer.js');
const { claudeLaunch, claudeRunOptions, FILES_ONLY } = await import('../src/modules/claude/index.js');
const { deniedTools } = await import('../src/modules/claude/direct.js');
const { answerPermission } = await import('../src/engine/acp-runner.js');
const { harnessView } = await import('../src/engine/harness.js');
const { boardPaths, readMeta, writeMeta } = await import('../src/board/store.js');
const { seedDemoBoard } = await import('../src/board/demo.js');
const { mountBoardApi } = await import('../src/console/api/board.js');
const { buildPaths } = await import('../src/core/paths.js');
const studio = await import('../src/board/studio.js');
const { sketchChatsDir } = await import('../src/board/studio-paths.js');

let tmp: string;
let bp: ReturnType<typeof boardPaths>;

const page = (words: string) => `<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body><main>${words}</main></body></html>`;
const signIn = (more: Record<string, unknown> = {}) => ({ screens: [{ name: 'Sign in', frames: [{ frame: 'desktop', html: page('Sign in') }] }], note: 'A sign-in screen with email and password.', ...more });

/** Every file in the project's Studio folder, with its bytes. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}/${e.name}`);
      else out[`${rel}/${e.name}`] = fs.readFileSync(path.join(d, e.name), 'utf8');
    }
  };
  walk(bp.studioDir, 'studio');
  return out;
}

function loginSketch() {
  return studio.saveSketch(bp, { name: 'Login', frames: ['desktop'] });
}

const draw = (stamp: string, more: Partial<Parameters<typeof runDesigner>[1]> = {}) =>
  runDesigner(bp, { step: 'draw', ask: 'Draw a sign-in screen for the project.', target: { kind: 'sketch', id: 'login' }, stamp, ...more }, { place: async () => () => undefined });

beforeEach(() => {
  calls.length = 0;
  answers.length = 0;
  during = null;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-designer-')));
  vi.stubEnv('SQUAD_KIT_HOME', path.join(tmp, 'home'));
  bp = boardPaths(path.join(tmp, '.squad'));
  seedDemoBoard(bp, { speed: 50, studio: false });
  writeMeta(bp, { ...readMeta(bp), engine: 'live', runner: 'direct', quality: 'thrifty' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('done when 1: the Designer is on the agents list, with its three steps and its rules file', () => {
  it('lists the Designer next to the other agents, with Draw, Change and Design system at the Thrifty levels', async () => {
    expect(AGENTS.map((a) => a.role)).toEqual(['analyst', 'architect', 'builder', 'reviewer', 'tester', 'designer']);
    expect(STEPS.designer).toEqual([
      { id: 'draw', name: 'Draw' },
      { id: 'change', name: 'Change' },
      { id: 'system', name: 'Design system' },
    ]);
    const a = new Hono();
    mountBoardApi(a, { paths: buildPaths(tmp) });
    type Row = { step: string; name: string; standard: { level: string; effort?: string }; now: { level: string; effort?: string; modelName: string } };
    const agents = (await (await a.request('/api/v1/agents')).json()) as { role: string; name: string; file: string; stepList: { id: string }[]; levels: Row[] }[];
    expect(agents.map((x) => x.role)).toContain('designer');
    const designer = agents.find((x) => x.role === 'designer')!;
    expect(designer.name).toBe('Designer');
    expect(designer.stepList.map((s) => s.id)).toEqual(['draw', 'change', 'system']);
    expect(designer.levels.map((l) => [l.step, l.name, l.now.level, l.now.effort])).toEqual([
      ['draw', 'Draw', 'balanced', 'high'],
      ['change', 'Change', 'balanced', 'medium'],
      ['system', 'Design system', 'balanced', 'high'],
    ]);
    for (const l of designer.levels) expect(l.now).toMatchObject(resolveLevel({ role: 'designer', step: l.step, quality: 'thrifty' }));
    expect(designer.levels.every((l) => l.now.modelName === 'Sonnet')).toBe(true);
    // The place for the team's own rules: its file in .squad/rules, made when the page is opened.
    expect(designer.file).toBe('.squad/rules/designer.md');
    expect(fs.existsSync(path.join(bp.rulesDir, 'designer.md'))).toBe(true);
    // Its core prompts show on the page too, one per step.
    const core = (await (await a.request('/api/v1/agents/designer/prompts')).json()) as { prompts: { step: string; prompt: string }[] };
    expect(core.prompts.map((p) => p.step)).toEqual(['draw', 'change', 'system']);
    expect(core.prompts.every((p) => p.prompt.includes('You are the Designer'))).toBe(true);
  });

  it('says on the Harness page that it reads only: no code changes, no commands, no internet', () => {
    const can = new Map(harnessView({ quality: 'thrifty' } as never).agents.designer.can);
    expect(can.get('Read your project')).toBe(true);
    expect(can.get('Read the Studio and the pictures you add')).toBe(true);
    expect(can.get('Change code')).toBe(false);
    expect(can.get('Run commands')).toBe(false);
    expect(can.get('No internet')).toBe(false);
    expect(harnessView({ quality: 'thrifty' } as never).caps.find((c) => c.key === 'designer')).toMatchObject({ turns: 36, spendUsd: 3 });
  });
});

describe('done when 2: the answer is checked, then saved as a new sketch version', () => {
  it('passes a whole answer and refuses a broken one in plain words', () => {
    const frames = ['desktop', 'mobile'];
    expect(screensProblem(signIn(), { frames })).toBeNull();
    const two = { screens: [{ name: 'Sign in', frames: [{ frame: 'desktop', html: page('A') }, { frame: 'mobile', html: page('B') }] }], note: 'Both frames.' };
    expect(screensProblem(two, { frames })).toBeNull();
    const cases: [unknown, RegExp][] = [
      [undefined, /there is no answer/],
      ['<main>x</main>', /there is no answer/],
      [{ note: 'x' }, /it has no screens/],
      [{ screens: [], note: 'x' }, /it has no screens/],
      [{ screens: Array.from({ length: MAX_SCREENS + 1 }, (_, i) => ({ name: `Screen ${i}`, frames: [{ frame: 'desktop', html: page('x') }] })), note: 'x' }, new RegExp(`more than the ${MAX_SCREENS}`)],
      [{ screens: [{ name: ' ', frames: [{ frame: 'desktop', html: page('x') }] }], note: 'x' }, /screen 1 has no name/],
      [{ screens: [{ name: 'Sign in', frames: [] }], note: 'x' }, /"Sign in" has no page/],
      [{ screens: [{ name: 'Sign in', frames: [{ frame: 'desktop', html: '   ' }] }], note: 'x' }, /desktop page of "Sign in" is empty/],
      [{ screens: [{ name: 'Sign in', frames: [{ frame: 'desktop', html: 'just words' }] }], note: 'x' }, /is not HTML/],
      [{ screens: [{ name: 'Sign in', frames: [{ frame: 'desktop', html: page('x'.repeat(MAX_PAGE_BYTES)) }] }], note: 'x' }, /is too big \(\d+ KB, at most 300 KB\)/],
      [{ screens: [{ name: 'Sign in', frames: [{ frame: 'tablet', html: page('x') }] }], note: 'x' }, /"tablet", which is not one of the frames \(desktop, mobile\)/],
      [{ screens: [{ name: 'Sign in', frames: [{ frame: 'desktop', html: page('x') }, { frame: 'desktop', html: page('y') }] }], note: 'x' }, /two pages for "desktop"/],
      [{ screens: [signIn().screens[0], { name: 'sign in', frames: [{ frame: 'desktop', html: page('y') }] }], note: 'x' }, /two screens are called "Sign in"/],
      [{ screens: signIn().screens }, /note is missing/],
    ];
    for (const [answer, words] of cases) expect(screensProblem(answer, { frames }), JSON.stringify(answer)?.slice(0, 80)).toMatch(words);
  });

  it('saves the screens of a good answer as a new version of the sketch, drawn by the Designer', async () => {
    const before = loginSketch();
    answers.push(signIn());
    const r = await draw(before.stamp);
    expect(r).toMatchObject({ ok: true, note: 'A sign-in screen with email and password.', saved: [{ screen: 'sign-in', version: 1 }] });
    const after = studio.readSketch(bp, 'login')!;
    expect(after.stamp).not.toBe(before.stamp);
    expect(after.screens.map((s) => [s.id, s.name, s.chosen])).toEqual([['sign-in', 'Sign in', 1]]);
    expect(after.screens[0]!.variants[0]).toMatchObject({ version: 1, madeBy: 'AI Designer', madeFor: readMeta(bp).user.name, note: 'A sign-in screen with email and password.', frames: { desktop: page('Sign in') } });
    // The Designer was asked with the answer's shape, and once.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.schema).toBe(SCREENS_SCHEMA);

    // Asked again, the same screen gets its next version; the first one stays, pickable.
    answers.push(signIn({ screens: [{ id: 'sign-in', name: 'Sign in', frames: [{ frame: 'desktop', html: page('Sign in, bigger') }] }] }));
    const again = await runDesigner(bp, { step: 'change', ask: 'Make the button bigger.', target: { kind: 'sketch', id: 'login' }, stamp: after.stamp }, { place: async () => () => undefined });
    expect(again).toMatchObject({ ok: true, saved: [{ screen: 'sign-in', version: 2 }] });
    const screen = studio.readSketch(bp, 'login')!.screens[0]!;
    expect(screen.chosen).toBe(2);
    expect(screen.variants.map((v) => v.frames.desktop)).toEqual([page('Sign in'), page('Sign in, bigger')]);
    // The Change step is told where the current page is, to read it first.
    expect(calls[1]!.prompt).toContain('.squad/studio/sketches/login/screens/sign-in/v1/desktop.html');
  });

  it('asks once more for a broken answer, then refuses it with a plain message and saves nothing', async () => {
    const sketch = loginSketch();
    const files = snapshot();
    const twice = { screens: [signIn().screens[0], { name: 'Sign in', frames: [{ frame: 'desktop', html: page('Again') }] }], note: 'Two.' };
    answers.push(twice, twice);
    const r = await draw(sketch.stamp);
    expect(r).toEqual({ ok: false, error: 'The Designer\'s answer could not be used: two screens are called "Sign in". Nothing was saved.', model: 'Sonnet (balanced, high effort)' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.resume).toBe('designer-1');
    expect(calls[1]!.prompt).toContain('two screens are called "Sign in"');
    expect(snapshot()).toEqual(files);
    expect(studio.readSketch(bp, 'login')!.stamp).toBe(sketch.stamp);
  });

  it('refuses an answer in the wrong shape, and uses the second one when it fits', async () => {
    const sketch = loginSketch();
    answers.push({ screens: 'Sign in' }, signIn());
    const r = await draw(sketch.stamp);
    expect(r.ok).toBe(true);
    expect(calls[1]!.prompt).toContain('its screens are not a list');
    expect(studio.readSketch(bp, 'login')!.screens.map((s) => s.id)).toEqual(['sign-in']);

    const files = snapshot();
    answers.push(undefined, { screens: [{ name: 'Sign in', frames: [{ frame: 'desktop', html: '' }] }], note: 'x' });
    const broken = await draw(studio.readSketch(bp, 'login')!.stamp);
    expect(broken).toMatchObject({ ok: false, error: 'The Designer\'s answer could not be used: the desktop page of "Sign in" is empty. Nothing was saved.' });
    expect(snapshot()).toEqual(files);
  });

  it('saves nothing when the sketch changed during the run: "Changed elsewhere, reload"', async () => {
    const sketch = loginSketch();
    answers.push(signIn());
    // A teammate renames the sketch while the Designer draws.
    during = () => studio.saveSketch(bp, { id: 'login', name: 'Log in', frames: ['desktop'] }, sketch.stamp);
    const r = await draw(sketch.stamp);
    expect(r).toEqual({ ok: false, error: 'Changed elsewhere, reload' });
    const now = studio.readSketch(bp, 'login')!;
    expect(now.name).toBe('Log in');
    expect(now.screens).toEqual([]);

    // A stamp already old when asked: refused before the Designer runs.
    calls.length = 0;
    expect(await draw(sketch.stamp)).toEqual({ ok: false, error: 'Changed elsewhere, reload' });
    expect(calls).toHaveLength(0);
  });

  it('saves the Design system step as a design system version, with its tokens and components', async () => {
    answers.push({ screens: [{ name: 'Button', frames: [{ frame: 'desktop', html: '<button class="primary">Go</button>' }] }], tokens: { colors: { primary: '#2563eb' } }, note: 'A calm blue system.' });
    const r = await runDesigner(bp, { step: 'system', ask: 'Make a calm design system in blue.', target: { kind: 'design-system', id: 'brand' }, stamp: null, name: 'Brand' }, { place: async () => () => undefined });
    expect(r).toMatchObject({ ok: true, saved: [{ screen: 'button' }] });
    const ds = studio.readDesignSystem(bp, 'brand')!;
    expect(ds).toMatchObject({ name: 'Brand', version: 1, markedDefault: true });
    expect(ds.versions[0]).toEqual({ version: 1, tokens: { colors: { primary: '#2563eb' } }, components: { button: '<button class="primary">Go</button>' } });
    // A step on the wrong kind of item never runs.
    calls.length = 0;
    expect(await runDesigner(bp, { step: 'system', ask: 'x', target: { kind: 'sketch', id: 'login' }, stamp: 'x' }, { place: async () => () => undefined })).toMatchObject({ ok: false, error: 'The Design system step works on a design system.' });
    expect(calls).toHaveLength(0);
  });
});

describe('done when 3: the Designer reads files only', () => {
  it('runs with read, find and search alone: the shell, file writes and web pages are refused', async () => {
    const sketch = loginSketch();
    answers.push(signIn());
    await draw(sketch.stamp);
    const opts = calls[0]!;
    expect(DESIGNER_PERMISSIONS).toEqual(['files']);
    expect(opts.cwd).toBe(bp.root);
    expect(opts.allowedTools).toEqual(FILES_ONLY);
    expect(opts.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'LS']);
    expect(opts.permissionMode).toBe('default');
    expect(opts.window).toBeUndefined();
    const denied = deniedTools(opts);
    for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Task']) expect(denied, t).toContain(t);
    // Over ACP the adapter gets the same rules, and any tool it was not given is answered no.
    const launch = claudeLaunch(opts, '/adapter.js', '/bin/claude');
    const options = (launch.meta as { claudeCode: { options: { allowedTools: string[]; disallowedTools: string[]; allowDangerouslySkipPermissions: boolean } } }).claudeCode.options;
    expect(options.allowedTools).toEqual(FILES_ONLY);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit']));
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    expect(answerPermission({ toolCall: { title: 'Bash' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] })).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    // The other agents' read set keeps its read commands in the shell; read files only has none.
    expect(claudeRunOptions({ cwd: tmp, prompt: 'x', permissions: ['read'] }).allowedTools).toContain('Bash(cat:*)');
    expect(claudeRunOptions({ cwd: tmp, prompt: 'x', permissions: ['files'] }).allowedTools?.some((t) => t.startsWith('Bash'))).toBe(false);
  });

  it("reads the pictures added to the message from the sketch's chat on this computer, and no other picture", async () => {
    const sketch = loginSketch();
    const dir = sketchChatsDir(bp, 'login');
    fs.mkdirSync(dir, { recursive: true });
    const picture = path.join(dir, 'chat-1-1.png');
    fs.writeFileSync(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    answers.push(signIn());
    expect((await draw(sketch.stamp, { pictures: [picture] })).ok).toBe(true);
    expect(calls[0]!.addDirs).toEqual([dir]);
    expect(calls[0]!.prompt).toContain(picture);

    calls.length = 0;
    const outside = path.join(tmp, 'elsewhere.png');
    fs.writeFileSync(outside, 'x');
    expect(await draw(studio.readSketch(bp, 'login')!.stamp, { pictures: [outside] })).toEqual({ ok: false, error: "A picture is not one added to this sketch's messages." });
    expect(calls).toHaveLength(0);
  });
});

describe("done when 5: the team's rules for the Designer are part of every run", () => {
  it('puts the rule from .squad/rules/designer.md into what each of the three steps is told to follow', async () => {
    const rule = 'Use only the colors from the design system';
    writeAgent(bp, 'designer', { instructions: rule, steps: { change: 'Keep the layout as it is.' } });
    expect(fs.readFileSync(path.join(bp.rulesDir, 'designer.md'), 'utf8')).toContain(rule);
    expect(readAgent(bp, 'designer').instructions).toBe(rule);

    const sketch = loginSketch();
    answers.push(signIn());
    expect((await draw(sketch.stamp)).ok).toBe(true);
    answers.push(signIn());
    const change = await runDesigner(bp, { step: 'change', ask: 'Make it calmer.', target: { kind: 'sketch', id: 'login' }, stamp: studio.readSketch(bp, 'login')!.stamp }, { place: async () => () => undefined });
    expect(change.ok).toBe(true);
    answers.push({ screens: [{ name: 'Button', frames: [{ frame: 'desktop', html: '<button>Go</button>' }] }], note: 'x' });
    const system = await runDesigner(bp, { step: 'system', ask: 'Make a design system.', target: { kind: 'design-system', id: 'brand' }, stamp: null }, { place: async () => () => undefined });
    expect(system.ok).toBe(true);

    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.appendSystemPrompt).toContain('You are the Designer');
      expect(c.appendSystemPrompt).toContain(`Instructions from the project team for the Designer. Follow them unless they conflict with the task:\n${rule}`);
    }
    // A rule for one step reaches that step only.
    expect(calls.map((c) => c.appendSystemPrompt!.includes('Keep the layout as it is.'))).toEqual([false, true, false]);
  });
});

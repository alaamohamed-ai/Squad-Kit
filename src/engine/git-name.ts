import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { gitEnv } from './git.js';

/**
 * The person's first name from git, as the project's own folder sees it, or "You" when git has none. Read in that
 * folder, never in the one the command was started from: a repository there may keep a name of its own. Setting up a
 * project (engine/setup.ts) and the sample board (board/demo.ts) both read it here.
 */
export function gitFirstName(dir?: string): string {
  try {
    return execSync('git config user.name', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(), ...(dir && fs.existsSync(dir) ? { cwd: dir } : {}) }).trim().split(/\s+/)[0] || 'You';
  } catch {
    return 'You';
  }
}

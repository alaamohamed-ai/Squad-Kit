import fs from 'node:fs';
import type { BoardPaths } from './store.js';
import { sketchDir, sketchFile, sketchesDir } from './studio-paths.js';
import { idsIn, plainFile, sha1 } from './studio-files.js';
import { readSketchFile } from './studio-read.js';

/**
 * Names and ids in the Studio (AB-138.1): the one name rule for sketches, used by every save that names a sketch, and
 * the free-name and free-id helpers. Part of the Studio store: later stories import these through studio.ts. They only
 * read; the store calls checkSketchNameFree under the lock and the stamp check of the save (AB-129.1).
 */

/** The longest name a sketch, a screen or a design system may have. */
export const MAX_NAME = 120;

/** A name as it is saved: one line, trimmed, up to MAX_NAME letters. */
export function checkedName(name: unknown, what: string): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new Error(`Give the ${what} a name.`);
  if (n.length > MAX_NAME || /[\r\n]/.test(n)) throw new Error(`The ${what}'s name must be one line of up to ${MAX_NAME} letters.`);
  return n;
}

/* ── Sketch names: one per project (AB-138.1) ───────────── */

/** How two sketch names are compared: capital letters and spaces at the ends do not count, so "login " is "Login". */
export function sketchNameKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** Another sketch already has the name. Nothing was written. */
export class StudioNameTaken extends Error {
  constructor(
    /** The name as the other sketch has it. */
    readonly taken: string,
    readonly sketch: string,
  ) {
    super(`A sketch called "${taken}" already exists. Pick another name.`);
    this.name = 'StudioNameTaken';
  }
}

/** Every saved sketch's id and name, as their files say. A sketch that cannot be read is left out; readStudio lists it. */
function sketchNames(bp: BoardPaths): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const id of idsIn(sketchesDir(bp))) {
    const file = sketchFile(bp, id);
    if (!plainFile(file)) continue;
    try {
      out.push({ id, name: readSketchFile(file).name });
    } catch {
      // readStudio lists it as broken.
    }
  }
  return out;
}

/** The other sketch that already uses a name, or null when it is free. `except` is the sketch being renamed. */
export function sketchUsingName(bp: BoardPaths, name: string, except?: string): { id: string; name: string } | null {
  const key = sketchNameKey(name);
  return sketchNames(bp).find((s) => s.id !== except && sketchNameKey(s.name) === key) ?? null;
}

/**
 * The one free-name helper (AB-138.1): the name itself when no other sketch uses it, else "Booking 2", "Booking 3" …
 * For a copy, ask for "Booking copy": it gives "Booking copy", then "Booking copy 2". The start page, Duplicate and
 * later stories that name a sketch use it. A name too long is cut to fit. It only reads; the save checks again under
 * the lock.
 */
export function freeSketchName(bp: BoardPaths, wanted: string, except?: string): string {
  const base = typeof wanted === 'string' ? wanted.trim() : '';
  if (!base || /[\r\n]/.test(base)) checkedName(base, 'sketch');
  const used = new Set(sketchNames(bp).filter((s) => s.id !== except).map((s) => sketchNameKey(s.name)));
  for (let n = 1; n < 10_000; n++) {
    const tail = n === 1 ? '' : ` ${n}`;
    const name = `${base.slice(0, MAX_NAME - tail.length).trimEnd()}${tail}`;
    if (!used.has(sketchNameKey(name))) return name;
  }
  throw new Error('This project has too many sketches with that name. Use other words.');
}

/** A new sketch's id is kept short, so -2, -3 … always fit. */
const ID_MAX = 40;

/** A short id from the name, with -2, -3 … when the project already has a sketch folder by it. */
export function freeSketchId(bp: BoardPaths, name: string): string {
  const base = studioIdFor(name).slice(0, ID_MAX).replace(/-+$/, '') || 'sketch';
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!fs.existsSync(sketchDir(bp, id))) return id;
  }
  throw new Error('This project has too many sketches with that name. Use other words.');
}

/** Refuses a name another sketch already uses, under the lock, before anything is written. */
export function checkSketchNameFree(bp: BoardPaths, name: string, id: string): void {
  const other = sketchUsingName(bp, name, id);
  if (other) throw new StudioNameTaken(other.name, other.id);
}

/** A short id from a name: "Checkout" → "checkout", "Order history" → "order-history". */
export function studioIdFor(name: string): string {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  // A name with no Latin letters (Arabic, Japanese …) still gets a short id that stays the same for the same name.
  return id || `item-${sha1(name).slice(0, 8)}`;
}

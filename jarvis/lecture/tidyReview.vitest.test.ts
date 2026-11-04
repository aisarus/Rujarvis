// Тесты независимого рецензента кнопки «Упорядочить хранилище» (04.11.2026): каждый
// фиксирует обещанное поведение. Подставная модель и временные папки, настоящих
// хранилища и модели нет. Написаны снаружи и намеренно не подогнаны под код.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Failure and crash switch for every call that changes the disk. A "crash" makes this call and
// all later ones throw, so nothing more reaches the disk: what is left on disk is what a real
// power cut at that moment would leave.
const точка = vi.hoisted(() => ({
  armed: false,
  count: 0,
  crashAt: Infinity,
  crashed: false,
  failRename: null as null | ((to: string) => boolean),
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const guard = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    if (точка.armed) {
      точка.count += 1;
      if (точка.count >= точка.crashAt) {
        точка.crashed = true;
        throw new Error('SIMULATED CRASH');
      }
    }
    return fn(...args);
  };
  return {
    ...real,
    default: real,
    writeFileSync: guard(real.writeFileSync),
    copyFileSync: guard(real.copyFileSync),
    mkdirSync: guard(real.mkdirSync),
    renameSync: guard((from: fs.PathLike, to: fs.PathLike) => {
      if (точка.armed && точка.failRename?.(String(to))) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename to ${String(to)}`), { code: 'EPERM' });
      }
      real.renameSync(from, to);
    }),
  };
});

const { VaultTidier } = await import('./tidy');
const { formulaCandidates, mergeFormulaLine } = await import('./formulaLines');
const { parseFrontmatter, renderFrontmatter, renameCourseFolder, listLectures } = await import('./courses');
const { moveLecture } = await import('./finalize');
const { deleteRecording, recordingOf } = await import('./recordings');
const { setLanguage } = await import('../locale/language');

setLanguage('en');
// Обходы всех точек записи идут дольше обычного теста.
vi.setConfig({ testTimeout: 120_000 });

type Tidier = InstanceType<typeof VaultTidier>;

interface Bench {
  vault: string;
  root: string;
  dir: string;
  graph: string;
  a: string;
  b: string;
  originals: Map<string, Buffer>;
  graphOriginal: string;
  calls: string[];
  reply: { fn: (prompt: string) => string };
  open: { state: 'running' | 'closed' | 'unknown' };
  tidier(extra?: Partial<ConstructorParameters<typeof VaultTidier>[0]>): Tidier;
}

const note = (course: string, body: string): string =>
  `${renderFrontmatter({ course, number: 1, date: '2026-10-13', topic: 'Topic' }, 'en')}# Topic\n\n## Notes\n\n### Part (00:00–05:00)\n${body}\n`;

/** Wraps "name = value" in $…$ and leaves the words before it, the way a careful model would. */
const wrapAll = (prompt: string): string =>
  (prompt.split('Строки:\n')[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/^(\d+\| (?:- )?.*?)([a-zA-Z]\w* = .+)$/u, '$1$$$2$$'))
    .join('\n');

function bench(bodyA = '- speed v = s/t\n- plain words about physics\n- force F = m·a', bodyB = '- root x = 5'): Bench {
  const base = mkdtempSync(path.join(tmpdir(), 'rv-tidy-'));
  const vault = path.join(base, 'vault');
  const root = path.join(vault, 'Lectures');
  const dir = path.join(base, 'data', 'tidy');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Physics'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Algebra'), { recursive: true });
  const graph = path.join(vault, '.obsidian', 'graph.json');
  const graphOriginal = JSON.stringify({ search: '', showOrphans: true, 'own-key': 1, colorGroups: [{ query: 'tag:#mine', color: { a: 1, rgb: 7 } }], scale: 0.4 });
  fs.writeFileSync(graph, graphOriginal, 'utf8');
  const a = path.join(root, 'Physics', '2026-10-13 — Topic.md');
  const b = path.join(root, 'Algebra', '2026-10-13 — Topic.md');
  fs.writeFileSync(a, note('Physics', bodyA), 'utf8');
  fs.writeFileSync(b, note('Algebra', bodyB), 'utf8');
  for (const n of [a, b]) {
    fs.writeFileSync(n.replace(/\.md$/u, ' — transcript.md'), '# Transcript\n\n**[00:00]** words\n', 'utf8');
    fs.writeFileSync(n.replace(/\.md$/u, '.wav'), Buffer.alloc(44));
  }
  const originals = new Map([a, b].map((f) => [f, fs.readFileSync(f)] as const));
  const calls: string[] = [];
  const reply = { fn: wrapAll };
  const open = { state: 'closed' as Bench['open']['state'] };
  return {
    vault, root, dir, graph, a, b, originals, graphOriginal, calls, reply, open,
    tidier: (extra = {}) =>
      new VaultTidier({
        root,
        dir,
        summarize: async (prompt: string) => {
          calls.push(prompt);
          return reply.fn(prompt);
        },
        obsidian: async () => open.state,
        now: () => Date.UTC(2026, 10, 4),
        pollMs: 5,
        ...extra,
      }),
  };
}

const bytes = (f: string): string => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sameAsOriginal = (b: Bench, f: string): boolean => fs.readFileSync(f).equals(b.originals.get(f) as Buffer);

function tmpFiles(folder: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
    const p = path.join(folder, e.name);
    if (e.isDirectory()) out.push(...tmpFiles(p));
    else if (e.name.endsWith('.tmp')) out.push(e.name);
  }
  return out;
}

beforeEach(() => {
  точка.armed = false;
  точка.count = 0;
  точка.crashAt = Infinity;
  точка.crashed = false;
  точка.failRename = null;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('T1 the code check must refuse a reply that changes the mathematics', () => {
  // [original line, what a model replied]. Each reply changes the meaning, the value or a mark.
  const wrong: Array<[string, string, string]> = [
    ['decimal point moved', 'x = 1.5', '$x = 15$'],
    ['decimal comma moved', 'x = 3,14', '$x = 31{,}4$'],
    ['digits become a power', 'x = 103', '$x = 10^3$'],
    ['digits regrouped across a fraction', 'x = 12/3', '$x = \\dfrac{1}{23}$'],
    ['digits regrouped across a plus', 'y = 12 + 3', '$y = 1 + 23$'],
    ['plus and minus swapped', 'a - b + c', '$a + b - c$'],
    ['equals sign moved', 'x = y + z', '$x + y = z$'],
    ['fraction takes in the wrong terms', 'a + b/c', '$\\dfrac{a+b}{c}$'],
    ['brackets dropped', '(a + b)c', '$a + bc$'],
    ['square becomes an index', 'x² = 4', '$x_2 = 4$'],
    ['derivative mark dropped', "f'(x) = 2x", '$f(x) = 2x$'],
    ['factorial dropped', 'n! = 5', '$n = 5$'],
    ['percent dropped', 'p = 50%', '$p = 50$'],
    ['absolute value dropped', '|x| = 5', '$x = 5$'],
    ['root dropped', '√x = 2', '$x = 2$'],
    ['root added', 'x = 2', '$\\sqrt{x} = 2$'],
    ['equals turned into not-equals', 'a = b', '$a \\not= b$'],
    ['union turned into intersection', 'A ∪ B = C', '$A \\cap B = C$'],
    ['mean bar dropped', 'x̄ = 5', '$x = 5$'],
    ['integral dropped', '∫ x dx = 5', '$x dx = 5$'],
    ['exponent becomes subtraction', 'e^-x = 1', '$e - x = 1$'],
    ['the doubt mark is lost', 'x = 5 (⚠ 12:05: heard 6)', '$x = 5 (12:05: heard 6)$'],
    ['English words swallowed into a formula', 'Total cost = fixed cost + variable cost', '$Total cost = fixed cost + variable cost$'],
    ['wikilink broken', 'see [[a = b]] and x = 1', 'see [[$a = b$]] and $x = 1$'],
    ['web address broken', 'https://a.io/q?x=1 and y = 2', 'https://a.io/q?$x=1$ and $y = 2$'],
    ['table column broken', '| |x| = 5 | y |', '| $|x| = 5$ | y |'],
  ];
  it.each(wrong)('%s: %s → %s', (_name, original, reply) => {
    expect(mergeFormulaLine(original, reply)).toBeNull();
  });

  it('end to end: a moved decimal point lands in the note and is reported as success', async () => {
    const b = bench('- speed v = 1.5', '- plain');
    b.reply.fn = () => '1| - speed $v = 15$';
    const state = await b.tidier().run();
    expect(state.lines.join(' ')).not.toMatch(/Formulas in LaTeX: 1 notes, 1 lines/u);
    expect(fs.readFileSync(b.a, 'utf8')).toContain('v = 1.5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('T2 lines that are already maths or are code must not be offered to the model', () => {
  it('inside a multi-line $$ block', () => {
    expect(formulaCandidates('intro\n$$\nx = \\frac{a}{b}\n$$\nend\n').map((c) => c.line)).toEqual([]);
  });
  it('inside a ~~~ code block', () => {
    expect(formulaCandidates('~~~python\ntotal = price + 2\n~~~\n').map((c) => c.line)).toEqual([]);
  });
  it('inside an indented code block', () => {
    expect(formulaCandidates('Text:\n\n    total = price + 2\n\nMore.\n').map((c) => c.line)).toEqual([]);
  });
  it('inside a multi-line %% comment', () => {
    expect(formulaCandidates('%%\nprivate x = 5\n%%\n').map((c) => c.line)).toEqual([]);
  });
  it('end to end: a $$ block stays valid', async () => {
    const b = bench('$$\nx = \\frac{a}{b}\n$$', '- plain');
    await b.tidier().run();
    expect(fs.readFileSync(b.a, 'utf8')).toContain('$$\nx = \\frac{a}{b}\n$$');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('T3 undo must keep working after normal use of the app', () => {
  it('the weekly audio clean-up rewrites the player line after tidying: formulas can still be undone', async () => {
    const body = '- root x = 5';
    const b = bench('- plain', body);
    const wav = `${path.basename(b.b, '.md')}.wav`;
    fs.writeFileSync(b.b, fs.readFileSync(b.b, 'utf8').replace('## Notes', `![[${wav}]]\n\n## Notes`), 'utf8');
    fs.writeFileSync(b.b.replace(/\.md$/u, '.wav'), Buffer.alloc(44));
    await b.tidier().run();
    expect(fs.readFileSync(b.b, 'utf8')).toContain('$x = 5$');
    const rec = recordingOf(b.b);
    if (!rec) throw new Error('no recording');
    await deleteRecording(rec);
    const state = await b.tidier().undo();
    expect(state.lines.join(' ')).not.toMatch(/edited since/u);
    expect(fs.readFileSync(b.b, 'utf8')).toContain('- root x = 5');
  });

  it('the lecture was moved to another course: formulas can still be undone', async () => {
    const b = bench('- plain', '- root x = 5');
    await b.tidier().run();
    const moved = await moveLecture(b.root, b.b, 'Geometry', 'en');
    await b.tidier().undo();
    expect(fs.readFileSync(moved.notesFile, 'utf8')).toContain('- root x = 5');
  });

  it('the course was renamed: formulas can still be undone', async () => {
    const b = bench('- plain', '- root x = 5');
    await b.tidier().run();
    await renameCourseFolder(b.root, 'Algebra', 'Algebra One');
    await b.tidier().undo();
    expect(fs.readFileSync(path.join(b.root, 'Algebra One', path.basename(b.b)), 'utf8')).toContain('- root x = 5');
  });

  it('a note skipped by undo stays undoable: the edit is reverted and undo is pressed again', async () => {
    const b = bench();
    await b.tidier().run();
    const tidied = fs.readFileSync(b.b);
    fs.writeFileSync(b.b, `${tidied.toString('utf8')}\nmy edit\n`, 'utf8');
    await b.tidier().undo();
    fs.writeFileSync(b.b, tidied);
    const again = await b.tidier().undo();
    expect(again.lines.join(' ')).not.toMatch(/Nothing to undo/u);
    expect(sameAsOriginal(b, b.b)).toBe(true);
  });

  it('undo is byte for byte, including a stray non-UTF-8 byte', async () => {
    const b = bench();
    const raw = Buffer.concat([fs.readFileSync(b.b), Buffer.from([0xcf, 0x20, 0x41, 0x0a])]); // a Windows-1251 letter
    fs.writeFileSync(b.b, raw);
    await b.tidier().run();
    await b.tidier().undo();
    expect(fs.readFileSync(b.b).equals(raw)).toBe(true);
  });

  it('tidying does not change bytes outside the formula lines, including a stray non-UTF-8 byte', async () => {
    const b = bench();
    const raw = Buffer.concat([fs.readFileSync(b.b), Buffer.from([0xcf, 0x20, 0x41, 0x0a])]);
    fs.writeFileSync(b.b, raw);
    await b.tidier().run();
    expect(fs.readFileSync(b.b).includes(Buffer.from([0xcf, 0x20, 0x41]))).toBe(true);
  });

  it('one locked note does not stop undo for the other notes and the graph', async () => {
    const b = bench();
    await b.tidier().run();
    const t = b.tidier();
    точка.armed = true;
    // Undo goes newest first: Physics, then Algebra. Physics (b.a) is the locked one.
    точка.failRename = (to) => path.resolve(to) === path.resolve(b.a);
    let threw = '';
    try {
      await t.undo();
    } catch (e) {
      threw = (e as Error).message.slice(0, 30);
    }
    точка.armed = false;
    expect({ threw, otherNoteRestored: sameAsOriginal(b, b.b), graphRestored: fs.readFileSync(b.graph, 'utf8') === b.graphOriginal }).toEqual({ threw: '', otherNoteRestored: true, graphRestored: true });
  });

  it('a graph restore that fails can be tried again', async () => {
    const b = bench();
    await b.tidier().run();
    const t = b.tidier();
    точка.armed = true;
    точка.failRename = (to) => path.resolve(to) === path.resolve(b.graph);
    await t.undo();
    точка.armed = false;
    точка.failRename = null;
    expect(fs.readFileSync(b.graph, 'utf8')).not.toBe(b.graphOriginal); // the failure really happened
    await b.tidier().undo();
    expect(fs.readFileSync(b.graph, 'utf8')).toBe(b.graphOriginal);
  });

  it('a graph the student changed after tidying is not overwritten by undo without a word', async () => {
    const b = bench();
    await b.tidier().run();
    const now = JSON.parse(fs.readFileSync(b.graph, 'utf8'));
    fs.writeFileSync(b.graph, JSON.stringify({ ...now, colorGroups: [...now.colorGroups, { query: 'tag:#added-later', color: { a: 1, rgb: 9 } }] }), 'utf8');
    const state = await b.tidier().undo();
    const kept = fs.readFileSync(b.graph, 'utf8').includes('added-later');
    expect(kept || /changed|edited|kept|copy/iu.test(state.lines.join(' '))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('T4 a crash at any moment must leave undo complete', () => {
  async function sweep(what: 'run' | 'undo'): Promise<{ steps: number; violations: string[] }> {
    const violations: string[] = [];
    let k = 1;
    for (; k < 200; k += 1) {
      const b = bench();
      if (what === 'undo') await b.tidier().run();
      точка.count = 0;
      точка.crashAt = k;
      точка.crashed = false;
      точка.armed = true;
      const t = b.tidier();
      try {
        await (what === 'run' ? t.run() : t.undo());
      } catch {
        // a crash thrown out of the call is fine: the process would be gone
      }
      t.dispose();
      точка.armed = false;
      const crashed = точка.crashed;
      точка.crashAt = Infinity;
      if (!crashed) break;
      for (const f of [b.a, b.b]) {
        const text = fs.readFileSync(f, 'utf8');
        const whole = sameAsOriginal(b, f) || (parseFrontmatter(text)?.formulas === true && text.includes('$'));
        if (!whole) violations.push(`crash at write ${k}: ${path.basename(path.dirname(f))} is half-done`);
      }
      const after = await b.tidier().undo();
      for (const f of [b.a, b.b]) if (!sameAsOriginal(b, f)) violations.push(`crash at write ${k}: undo after restart left ${path.basename(path.dirname(f))} not restored`);
      if (fs.readFileSync(b.graph, 'utf8') !== b.graphOriginal) violations.push(`crash at write ${k}: undo after restart left the graph not restored`);
      if (/edited since/u.test(after.lines.join(' '))) violations.push(`crash at write ${k}: undo after restart wrongly says a note was edited`);
      const junk = tmpFiles(b.vault);
      if (junk.length > 0) violations.push(`crash at write ${k}: temp file left in the vault`);
    }
    return { steps: k - 1, violations };
  }

  it('crash at every write while tidying', async () => {
    const { steps, violations } = await sweep('run');
    console.log(`T4 run: ${steps} write points tried`);
    expect(violations).toEqual([]);
  });

  it('crash at every write while undoing', async () => {
    const { steps, violations } = await sweep('undo');
    console.log(`T4 undo: ${steps} write points tried`);
    expect(violations).toEqual([]);
  });

  it('held: a crash at any write never damages a note (every note is original or fully tidied)', async () => {
    for (const what of ['run', 'undo'] as const) {
      for (let k = 1; k < 200; k += 1) {
        const b = bench();
        if (what === 'undo') await b.tidier().run();
        точка.count = 0;
        точка.crashAt = k;
        точка.crashed = false;
        точка.armed = true;
        const t = b.tidier();
        await (what === 'run' ? t.run() : t.undo()).catch(() => undefined);
        t.dispose();
        точка.armed = false;
        const crashed = точка.crashed;
        точка.crashAt = Infinity;
        if (!crashed) break;
        for (const f of [b.a, b.b]) {
          const text = fs.readFileSync(f, 'utf8');
          expect(sameAsOriginal(b, f) || (parseFrontmatter(text)?.formulas === true && text.includes('$'))).toBe(true);
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('T5 reports must say what really happened', () => {
  it('every reply rejected: not reported as "no formulas found", and the note can be tried again', async () => {
    const b = bench('- plain', '- root x = 5');
    b.reply.fn = () => '1| - root $x = 6$';
    const state = await b.tidier().run();
    const said = state.lines.join(' ');
    expect(said).toMatch(/Lines rejected: 1/u);
    expect(said).not.toMatch(/No formulas found/u);
    expect(parseFrontmatter(fs.readFileSync(b.b, 'utf8'))?.formulas).toBeUndefined();
  });

  it('a reply that skips lines by mistake: the note is not marked finished', async () => {
    const b = bench('- first x = 5\n- second y = 6\n- third z = 7', '- plain');
    b.reply.fn = () => '1| - first $x = 5$'; // cut off after one line
    await b.tidier().run();
    expect(parseFrontmatter(fs.readFileSync(b.a, 'utf8'))?.formulas).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('a note that could not be written leaves no temp file and no false undo entry (real file lock)', async () => {
    const b = bench('- plain', '- root x = 5');
    process.env.RV_LOCK = b.b;
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', "$f=[IO.File]::Open($env:RV_LOCK,'Open','Read','Read'); Start-Sleep 8; $f.Close()"], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => setTimeout(r, 2500));
    const state = await b.tidier().run();
    ps.kill();
    await new Promise((r) => setTimeout(r, 500));
    const said = state.lines.join(' ');
    expect(said).toMatch(/note unchanged/u); // the lock really hit
    const leftover = tmpFiles(b.vault).length;
    const undo = await b.tidier().undo();
    expect({ leftover, saysEdited: /edited since/u.test(undo.lines.join(' ')) }).toEqual({ leftover: 0, saysEdited: false });
  }, 30_000);

  it('locked notes are not blamed on the model', async () => {
    const b = bench();
    const third = path.join(b.root, 'Physics', '2026-10-20 — Other.md');
    fs.writeFileSync(third, note('Physics', '- y = 6'), 'utf8');
    точка.armed = true;
    точка.failRename = (to) => to.endsWith('.md');
    const state = await b.tidier().run();
    точка.armed = false;
    expect(state.lines.join(' ')).not.toMatch(/model keeps failing/u);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('T6 a recording that starts during the run', () => {
  it('no note is written once a recording has started', async () => {
    const b = bench('- plain', '- root x = 5');
    const busy = { why: null as string | null };
    b.reply.fn = (prompt) => {
      busy.why = 'recording'; // the student pressed "Lecture notes" while the model was thinking
      return wrapAll(prompt);
    };
    await b.tidier({ busy: () => busy.why }).run();
    expect(sameAsOriginal(b, b.b)).toBe(true);
  });

  it('no more model calls for a long note once a recording has started', async () => {
    const lines = Array.from({ length: 130 }, (_, i) => `- x${i} = ${i}`).join('\n');
    const b = bench('- plain', lines);
    const busy = { why: null as string | null };
    b.reply.fn = (prompt) => {
      busy.why = 'recording';
      return wrapAll(prompt);
    };
    await b.tidier({ busy: () => busy.why }).run();
    expect(b.calls.length).toBe(1);
  });
});

describe('held: claims that survived attack', () => {
  it('text outside formulas: 20,000 mutated replies never changed a word or digit outside $…$', () => {
    const lines = [
      '- цена x = 5 при спросе 300 единиц (⚠ 12:05: на слух 6)',
      '> [!tip] масса m = 12,5 кг и v = 3',
      '| 5 + 3 | восемь | y |',
      '  - L0 — граница, x = 5, см. [[Заметка]]',
      '- price P = 40 and Q = 7 per week',
    ];
    const goods = [
      '- цена $x = 5$ при спросе 300 единиц (⚠ 12:05: на слух 6)',
      '> [!tip] масса $m = 12{,}5$ кг и $v = 3$',
      '| $5 + 3$ | восемь | $y$ |',
      '- $L_0$ — граница, $x = 5$, см. [[Заметка]]',
      '- price $P = 40$ and $Q = 7$ per week',
    ];
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = '0123456789abxyцена $=+-. ';
    const outside = (s: string): string => s.replace(/\$\$?[^$]*\$\$?/gu, '\u0000').split('\u0000').map((p) => p.trim()).filter(Boolean).join('\u0001');
    let accepted = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const k = rnd(lines.length);
      const original = lines[k] as string;
      let m = goods[k] as string;
      for (let edits = 1 + rnd(2); edits > 0; edits -= 1) {
        const at = rnd(m.length);
        const c = alphabet[rnd(alphabet.length)] as string;
        m = rnd(2) === 0 ? `${m.slice(0, at)}${c}${m.slice(at + 1)}` : `${m.slice(0, at)}${m.slice(at + 1)}`;
      }
      const merged = mergeFormulaLine(original, m);
      if (merged === null) continue;
      accepted += 1;
      // Every piece outside a formula must be a literal piece of the original line, in order.
      let from = 0;
      for (const piece of outside(merged).split('\u0001').filter(Boolean)) {
        const where = original.indexOf(piece, from);
        expect(where, `${original} ← ${merged}`).toBeGreaterThanOrEqual(0);
        from = where + piece.length;
      }
    }
    console.log(`held fuzz: ${accepted} of 20000 mutated replies accepted, none changed text outside formulas`);
  });

  it('confirmation is needed: plan alone changes nothing and calls no model', async () => {
    const b = bench();
    const before = { a: bytes(b.a), g: bytes(b.graph) };
    await b.tidier().plan();
    expect({ a: bytes(b.a), g: bytes(b.graph) }).toEqual(before);
    expect(b.calls).toEqual([]);
  });

  it('valid UTF-8 and CRLF notes come back byte for byte; originals are exact copies', async () => {
    const b = bench();
    const crlf = fs.readFileSync(b.a, 'utf8').replace(/\n/gu, '\r\n');
    fs.writeFileSync(b.a, crlf, 'utf8');
    await b.tidier().run();
    expect(fs.readFileSync(b.a, 'utf8')).toContain('- speed $v = s/t$\r\n');
    await b.tidier().undo();
    expect(fs.readFileSync(b.a, 'utf8')).toBe(crlf);
    expect(sameAsOriginal(b, b.b)).toBe(true);
    expect(fs.readFileSync(b.graph, 'utf8')).toBe(b.graphOriginal);
  });

  it('the student\'s own frontmatter survives: the mark adds exactly one line', async () => {
    const b = bench('- plain', '- root x = 5');
    const withTags = fs.readFileSync(b.b, 'utf8').replace('---\n# Topic', 'tags: [mine]\naliases: ["x"]\n---\n# Topic');
    fs.writeFileSync(b.b, withTags, 'utf8');
    await b.tidier().run();
    const after = fs.readFileSync(b.b, 'utf8');
    expect(after).toContain('tags: [mine]\naliases: ["x"]\nformulas: LaTeX\n---');
  });

  it('a second press calls no model and writes nothing', async () => {
    const b = bench();
    await b.tidier().run();
    const n = b.calls.length;
    const before = { a: bytes(b.a), b: bytes(b.b), g: bytes(b.graph) };
    await b.tidier().run();
    expect(b.calls.length).toBe(n);
    expect({ a: bytes(b.a), b: bytes(b.b), g: bytes(b.graph) }).toEqual(before);
  });

  it('the graph is never written while Obsidian runs or when its state is unknown', async () => {
    const b = bench();
    b.open.state = 'running';
    const t = b.tidier();
    await t.run();
    await new Promise((r) => setTimeout(r, 40));
    expect(fs.readFileSync(b.graph, 'utf8')).toBe(b.graphOriginal);
    t.dispose();
    b.open.state = 'unknown';
    await b.tidier().run();
    expect(fs.readFileSync(b.graph, 'utf8')).toBe(b.graphOriginal);
  });

  it('a recording that is already running blocks the press', async () => {
    const b = bench();
    await expect(b.tidier({ busy: () => 'recording' }).run()).rejects.toThrow(/recording/u);
    await expect(b.tidier({ busy: () => 'recording' }).undo()).rejects.toThrow(/recording/u);
    expect(sameAsOriginal(b, b.a)).toBe(true);
  });

  it('the live lecture note is never offered: it has no lecture properties yet', async () => {
    const b = bench('- plain', '- plain too');
    const live = path.join(b.root, 'Physics', '2026-11-04 1000 Lecture.md');
    fs.writeFileSync(live, '# Lecture\n\n## Notes\n\n- x = 5\n', 'utf8');
    await b.tidier().run();
    expect(fs.readFileSync(live, 'utf8')).toBe('# Lecture\n\n## Notes\n\n- x = 5\n');
    expect(listLectures(b.root, 'Physics').map((l) => l.file)).not.toContain(live);
  });

  it('a model failure part-way through a long note applies nothing to it', async () => {
    const lines = Array.from({ length: 130 }, (_, i) => `- x${i} = ${i}`).join('\n');
    const b = bench('- plain', lines);
    let n = 0;
    b.reply.fn = (prompt) => {
      n += 1;
      if (n === 2) throw new Error('limit');
      return wrapAll(prompt);
    };
    await b.tidier().run();
    expect(sameAsOriginal(b, b.b)).toBe(true);
  });
});

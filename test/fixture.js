// fixture.js — a synthetic vault on disk for the claim-layer tests.
//
// Deliberately invented content. This repository is public, so no test may read
// the real vault or name a real person, project or firm.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Vault-relative path → file body. Line numbers in the tests refer to these. */
export const FILES = {
  // A project hub carrying all three zone kinds from the hub template.
  '10-Projects/widget.md': [
    '# widget',                                  // 1
    '',                                          // 2
    'Preamble prose pointing at [[gadget-study]].', // 3  → related_to (no section)
    '',                                          // 4
    '## What it is',                             // 5
    '<!-- HUMAN ZONE: agents never write here. -->', // 6
    'A thing built on [[sprocket]].',            // 7  → describes, human
    '',                                          // 8
    '## Todos',                                  // 9
    '- [ ] Wire [[gadget-study]] into the run',  // 10 → todo_on
    '',                                          // 11
    '## Recent decisions',                       // 12
    '- [2026-01-10] — Chose [[sprocket]] over the alternative — it was cheaper', // 13 → decided_about, validFrom 2026-01-10
    '- [2026-01-14] — Revisited the sprocket call — cost held up', // 14
    '',                                          // 15
    '## Key docs & references',                  // 16
    '- [2026-01-12] — [[gadget-study]] — the sizing work', // 17 → references
    '',                                          // 18
    '## Related patterns and standards',         // 19
    '<!-- HUMAN ZONE: agents never write here. -->', // 20
    '- [[style-rules]]',                         // 21 → governed_by, human
    '',                                          // 22
    '## Worth noticing',                         // 23  unmapped section
    'Also see [[gadget-study]].',                // 24 → related_to, unmapped
    '',
  ].join('\n'),

  // A research note: a broken link, and a wikilink inside a code fence.
  '20-Research/gadget-study.md': [
    '# gadget study',                            // 1
    '',                                          // 2
    'Builds on [[widget]] and [[note-that-does-not-exist]].', // 3 → one resolved, one broken
    '',                                          // 4
    '```',                                       // 5
    'A fenced [[sprocket]] must not count.',     // 6  → ignored
    '```',                                       // 7
    '',                                          // 8
    'Prose naming `[[sprocket]]` in backticks must not count either.', // 9 → ignored
    '',
  ].join('\n'),

  '20-Research/sprocket.md': '# sprocket\n\nNothing links out of here.\n',

  '60-Standards/style-rules.md': '# style rules\n\nRules.\n',

  // A daily note: Worked on inherits the filename date as validFrom.
  '40-Daily/2026-01-15.md': [
    '# 2026-01-15',                              // 1
    '',                                          // 2
    '## Worked on',                              // 3
    'Shipped the first half of [[widget]].',     // 4 → worked_on, validFrom 2026-01-15
    '',                                          // 5
    '## Decisions',                              // 6
    '- [2026-01-15] — Kept [[sprocket]] for now — no reason to churn', // 7 → decided_about
    // Regression guard: "sprocket" must NOT match this as a whole word. Found
    // against the real vault, where a search for "Linear" matched `scaleLinear`.
    '- [2026-01-09] — Sized the microSprocket variant — unrelated subject', // 8
    '',
  ].join('\n'),

  // Outside SCANNED_DIRS: must never be parsed.
  '99-Archive/old.md': 'Archived [[widget]] link that must not be counted.\n',
};

/** Write FILES into a fresh temp dir. Returns its path. */
export async function makeVault() {
  const root = await mkdtemp(path.join(tmpdir(), 'vault-hud-test-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return root;
}

export const cleanup = (root) => rm(root, { recursive: true, force: true });

// env.js — load ./.env, as a side effect, before anything reads it.
//
// WHY THIS IS A MODULE AND NOT A LINE IN server.js. It was a line in server.js,
// and it ran too late. ES modules evaluate every import before the importing
// module's own body, so `process.loadEnvFile` sat below a dozen imports that had
// already captured what they needed at their own module scope:
//
//   metrics.js   VAULT_HUD_METRICS_MS     documented in README and SPEC
//   publish.js   VAULT_HUD_MIN_DEPLOY_MS  its own comment says "without a code change"
//   sessions.js  VAULT_HUD_AGENTS         the Kimi-visibility override
//
// All three are documented as configurable and none of them could be set from
// `.env` at all. They worked only as real environment variables, so the failure
// presents as "I set the knob and nothing changed" — no error, no warning, and
// the default silently in force. Latent today because none is currently set.
//
// Imported FIRST by server.js, which is what makes the ordering a fact rather
// than a convention: an import graph is evaluated depth-first in source order,
// so this module's body runs before any sibling import's does.
//
// The alternative was making each read lazy. That is three changes instead of
// one, it has to be remembered by whoever adds the fourth knob, and a knob read
// once at boot is the correct shape — a metrics interval that changes under a
// running sampler is not a feature.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Missing file is fine and is the normal case for a fresh checkout: everything
// this configures has a default, and the vault path falls back to a generic one.
try {
  process.loadEnvFile(path.join(HERE, '.env'));
} catch {
  /* no .env — real environment and defaults below stand */
}

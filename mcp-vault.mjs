#!/usr/bin/env node
// mcp-vault.mjs — read-only MCP server over the vault's claim index.
//
// Lets an agent in any repo ask what the vault actually asserts, with citations,
// instead of grepping or guessing. Stdio, newline-delimited JSON-RPC, zero deps.
//
// Read-only is structural, not promised: this process imports only buildClaims and
// the three pure verdict functions, and no code path it can reach opens a file for
// writing. The index is rebuilt per call — a full parse of a few hundred notes
// measures ~10ms (worst observed 18ms), and a stale answer about your own vault is
// worse than a cheap one.

import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { buildClaims } from './claims.js';
import { checkClaim, checkDecision, getNote } from './check.js';

if (!process.env.VAULT_HUD_VAULT) {
  try { process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env')); } catch { /* no .env is fine */ }
}
const VAULT = process.env.VAULT_HUD_VAULT ?? path.join(homedir(), 'Obsidian', 'vault');

const TOOLS = [
  {
    name: 'check_claim',
    description:
      'Fact-check a triple against the vault. Returns "supported" (with the file and line that assert it), '
      + '"related" (the notes are linked but under a different predicate — NOT a contradiction), or '
      + '"no vault evidence". No verdict is a basis for rejecting a change: the vault holds assertions, not refutations.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Note name, e.g. "vault-hud"' },
        predicate: { type: 'string', description: 'One of: decided_about, references, governed_by, describes, todo_on, worked_on, related_to' },
        object: { type: 'string', description: 'Note name' },
      },
      required: ['subject', 'predicate', 'object'],
    },
  },
  {
    name: 'check_decision',
    description:
      'Search the vault\'s dated decision ledger for a topic. This is where "did we decide X?" is answered. '
      + 'Returns matching decisions newest first, each with its date, file and line. The ledger is append-only, '
      + 'so the newest dated entry on a topic is the live one.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to match in decision entries, e.g. "Linear"' } },
      required: ['query'],
    },
  },
  {
    name: 'get_note',
    description:
      'Everything the vault asserts about one note: its outbound and inbound claims (each with predicate, '
      + 'source file and line) and the decisions recorded in it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Note name, e.g. "vault-hud"' } },
      required: ['name'],
    },
  },
];

const HANDLERS = {
  check_claim: (i, a) => checkClaim(i, a.subject, a.predicate, a.object),
  check_decision: (i, a) => checkDecision(i, a.query),
  get_note: (i, a) => getNote(i, a.name),
};

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vault', version: '0.1.0' },
      },
    });
    return;
  }
  if (method?.startsWith('notifications/')) return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }

  if (method === 'tools/call') {
    const handler = HANDLERS[params?.name];
    if (!handler) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
      return;
    }
    try {
      const index = await buildClaims(VAULT);
      const result = handler(index, params.arguments ?? {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } });
    }
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});

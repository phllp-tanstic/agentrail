// ============================================================================
// AgentRail MCP TEST HARNESS
//
// Two modes, deliberately:
//
//   node build/mcp-test.mjs <tool> '<json args>'
//       Calls the tool function in ./mcp-core.mjs directly. Fast, no transport.
//
//   node build/mcp-test.mjs --mcp <tool> '<json args>'
//       Spawns build/mcp-server.mjs and drives it over the REAL MCP stdio
//       protocol with an MCP client. This is what proves the server wiring —
//       schemas, registration, serialisation — and not merely the core function.
//
//   node build/mcp-test.mjs --mcp --list
//       Lists the tools the server advertises, with their input schemas.
// ============================================================================
import * as core from './mcp-core.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const useMcp = argv.includes('--mcp');
const wantList = argv.includes('--list');
const rest = argv.filter((a) => a !== '--mcp' && a !== '--list');
const tool = rest[0];
const args = rest[1] ? JSON.parse(rest[1]) : {};

const T0 = Date.now();
const el = () => `[+${((Date.now() - T0) / 1000).toFixed(1)}s]`;
const out = (o) => console.log(JSON.stringify(core.jsonSafe(o), null, 2));

if (!useMcp) {
  // ------------------------------------------------ direct in-process call
  if (!core[tool]) {
    console.error(`unknown tool "${tool}". available: list_markets, place_order, get_position, redeem`);
    process.exit(2);
  }
  console.error(`${el()} DIRECT call ${tool}(${JSON.stringify(args)})`);
  const res = await core[tool](args);
  out(res);
  console.error(`${el()} done — ok=${res?.ok} refused=${!!res?.refused}`);
  process.exit(res?.ok === false && !res?.refused ? 1 : 0);
}

// ------------------------------------------------ real MCP protocol round-trip
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(__dir, 'mcp-server.mjs')],
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'agentrail-test-harness', version: '0.1.0' });
await client.connect(transport);
console.error(`${el()} MCP connected to build/mcp-server.mjs over stdio`);

const listed = await client.listTools();
console.error(`${el()} server advertises ${listed.tools.length} tools: ${listed.tools.map((t) => t.name).join(', ')}`);

if (wantList) {
  out(listed.tools.map((t) => ({ name: t.name, title: t.title,
    inputs: Object.keys(t.inputSchema?.properties ?? {}),
    required: t.inputSchema?.required ?? [] })));
  await client.close();
  process.exit(0);
}

if (!tool) { console.error('no tool given'); await client.close(); process.exit(2); }
console.error(`${el()} MCP callTool ${tool}(${JSON.stringify(args)})`);
const res = await client.callTool({ name: tool, arguments: args });
const text = res.content?.map((c) => c.text).join('\n') ?? '';
console.log(text);
console.error(`${el()} done — isError=${!!res.isError}`);
await client.close();
process.exit(res.isError ? 1 : 0);

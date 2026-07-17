#!/usr/bin/env node
// Thin CLI shim for driving a running Flamingo server's MCP tools.
// Usage: node scripts/mcp-call.mjs <tool> ['<json-args>'] [--out <image-path>]
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const imageOut = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : null;
const [tool, argsJson] = argv;
if (!tool) {
  console.error('usage: mcp-call.mjs <tool> [json-args] [--out image.png]');
  process.exit(2);
}

const url = process.env.FLAMINGO_URL ?? 'http://localhost:4242/mcp';
const client = new Client({ name: 'flamingo-cli', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const res = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
for (const c of res.content ?? []) {
  if (c.type === 'text') console.log(c.text);
  else if (c.type === 'image' && imageOut) {
    writeFileSync(imageOut, Buffer.from(c.data, 'base64'));
    console.log(`[image -> ${imageOut}]`);
  }
}
await client.close();
process.exit(res.isError ? 1 : 0);

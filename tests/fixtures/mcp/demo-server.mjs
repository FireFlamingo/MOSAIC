// Minimal stdio MCP server for tests and the demo. Tool definitions come from the JSON file given as argv[2],
// so a test can change a description after it was trusted. It performs no real actions.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const toolsFile = process.argv[2];
const tools = () => JSON.parse(readFileSync(toolsFile, 'utf8'));
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'card-demo-mcp', version: '1.0.0' } });
  else if (message.method === 'tools/list') reply(message.id, { tools: tools() });
  else if (message.method === 'tools/call') reply(message.id, { content: [{ type: 'text', text: `Demo result for ${message.params?.name}` }] });
  else if (message.id !== undefined) reply(message.id, {});
});

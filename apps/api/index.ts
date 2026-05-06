// Blue Agent x402 API — local dev server
// Production: handlers are deployed to x402.bankr.bot infrastructure

import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import deepAnalysis from './x402/deep-analysis/index.js';
import walletPnl from './x402/wallet-pnl/index.js';
import launchAdvisor from './x402/launch-advisor/index.js';
import tokenLaunch from './x402/token-launch/index.js';
import grantEvaluator from './x402/grant-evaluator/index.js';
import riskGate from './x402/risk-gate/index.js';
import quantumPremium from './x402/quantum-premium/index.js';
import quantumBatch from './x402/quantum-batch/index.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const HANDLERS: Record<string, (req: Request) => Promise<Response>> = {
  'deep-analysis': deepAnalysis,
  'wallet-pnl': walletPnl,
  'launch-advisor': launchAdvisor,
  'token-launch': tokenLaunch,
  'grant-evaluator': grantEvaluator,
  'risk-gate': riskGate,
  'quantum-premium': quantumPremium,
  'quantum-batch': quantumBatch,
};

const __dir = dirname(fileURLToPath(import.meta.url));
let services: Record<string, unknown> = {};
try {
  services = JSON.parse(readFileSync(join(__dir, 'bankr.x402.json'), 'utf8'));
} catch {}

function setCors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment, x-api-key, Authorization');
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const toolId = url.pathname.split('/').filter(Boolean)[0];

  // Health / service list
  if (!toolId || req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'blue-agent-x402',
      version: '0.1.0',
      tools: Object.keys(HANDLERS),
      services,
    }, null, 2));
    return;
  }

  const handler = HANDLERS[toolId];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown tool: ${toolId}. Available: ${Object.keys(HANDLERS).join(', ')}` }));
    return;
  }

  // Collect request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();

  try {
    const webReq = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
      body: req.method !== 'GET' && req.method !== 'HEAD' && body ? body : null,
    });

    const webRes = await handler(webReq);
    const responseBody = await webRes.text();
    const ct = webRes.headers.get('content-type') ?? 'application/json';

    res.writeHead(webRes.status, { 'Content-Type': ct });
    res.end(responseBody);
  } catch (err) {
    console.error(`[${toolId}] Error:`, err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error', message: (err as Error).message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🔵 Blue Agent API — http://localhost:${PORT}`);
  console.log(`   Tools: ${Object.keys(HANDLERS).join(', ')}\n`);
});

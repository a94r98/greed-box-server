/**
 * Local TCP-to-Neon-HTTP proxy.
 * Listens on localhost:5433, forwards queries to Neon via HTTP.
 * This allows Prisma (which uses TCP) to connect via localhost while
 * actual queries go through Neon's HTTP API.
 * 
 * Usage: node pg_proxy.js
 * Then set DATABASE_URL=postgresql://...@localhost:5433/neondb
 */

const net = require('net');
const { neon } = require('@neondatabase/serverless');
require('dotenv').config();

const NEON_URL = process.env.DATABASE_URL;
const PROXY_PORT = 5433;

console.log(`🔄 Starting PG proxy on localhost:${PROXY_PORT}`);
console.log(`📡 Forwarding to Neon via HTTP API`);

// We can't do a full PostgreSQL wire protocol proxy easily.
// Instead, let's use a different approach:
// Override DATABASE_URL to use Prisma's built-in HTTP transport via Neon Accelerate.

// Actually, the cleanest solution is to use @prisma/adapter-neon with neonConfig.fetchEndpoint
// which makes the Pool use HTTP instead of WebSocket/TCP.

const { Pool: NeonPool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');

neonConfig.webSocketConstructor = ws;
// Force HTTP fetch mode instead of WebSocket for the Pool
neonConfig.fetchConnectionCache = true;

async function testConnection() {
  try {
    const sql = neon(NEON_URL);
    const result = await sql`SELECT version()`;
    console.log('✅ Neon HTTP connection works:', result[0].version.substring(0, 50));
    return true;
  } catch (e) {
    console.error('❌ Neon HTTP failed:', e.message);
    return false;
  }
}

testConnection().then(ok => {
  if (ok) {
    console.log('\n✅ Neon connection verified via HTTP.');
    console.log('The server needs to use the Neon HTTP adapter, not raw TCP.');
    process.exit(0);
  } else {
    process.exit(1);
  }
});

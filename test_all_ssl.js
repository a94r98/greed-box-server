const { Client } = require('pg');

const config = {
  host: 'aws-1-ap-southeast-2.pooler.supabase.com',
  user: 'postgres.dliggrtbbuhulrgpslft',
  password: 'Ali11278050a',
  database: 'postgres'
};

const options = [
  { name: "5432 with ssl", port: 5432, ssl: { rejectUnauthorized: false } },
  { name: "5432 no ssl", port: 5432, ssl: false },
  { name: "6543 with ssl", port: 6543, ssl: { rejectUnauthorized: false } },
  { name: "6543 no ssl", port: 6543, ssl: false },
];

async function test(opt) {
  console.log(`Testing: ${opt.name}...`);
  const client = new Client({
    host: config.host,
    port: opt.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: opt.ssl,
    connectionTimeoutMillis: 5000
  });

  try {
    await client.connect();
    console.log(`SUCCESS on ${opt.name}!`);
    const res = await client.query('SELECT 1');
    console.log(`QUERY SUCCESS on ${opt.name}:`, res.rows);
    await client.end();
    return true;
  } catch (err) {
    console.error(`FAILED on ${opt.name}:`, err.message);
    try { await client.end(); } catch(e) {}
    return false;
  }
}

async function main() {
  for (const opt of options) {
    const ok = await test(opt);
    if (ok) {
      console.log("\nFound working combination!");
      break;
    }
  }
  console.log("\nFinished all tests.");
}

main();

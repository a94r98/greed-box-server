const { neon } = require('@neondatabase/serverless');

const sql = neon("postgresql://neondb_owner:npg_pneU2I5hQdcS@ep-delicate-pond-at5yvq6y-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require");

async function main() {
  console.log("Testing Neon serverless connection...");
  try {
    const result = await sql`SELECT 1 as test, NOW() as time`;
    console.log("SUCCESS! Connected to Neon:", result);
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
}

main();

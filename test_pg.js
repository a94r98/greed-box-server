const { Client } = require('pg');

// Try with Neon
const connectionString = "postgresql://neondb_owner:npg_pneU2I5hQdcS@ep-delicate-pond-at5yvq6y-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require";

const client = new Client({
  connectionString: connectionString,
});

console.log("Connecting using pg client...");
client.connect((err) => {
  if (err) {
    console.error("CONNECTION ERROR DETAILS:", err);
  } else {
    console.log("SUCCESSFULLY CONNECTED via PG!");
    client.query('SELECT 1', (err, res) => {
      if (err) {
        console.error("QUERY ERROR:", err);
      } else {
        console.log("QUERY SUCCESS:", res.rows);
      }
      client.end();
    });
  }
});

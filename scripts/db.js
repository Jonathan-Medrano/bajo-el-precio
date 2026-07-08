// Levanta un Postgres local (embedded, sin Docker) y lo mantiene vivo.
// Correr en background: node scripts/db.js
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", ".pgdata");

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port: 5433,
  persistent: true,
});

if (!existsSync(dataDir)) {
  console.log("Inicializando Postgres local (primera vez)...");
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase("keepa");
  console.log("Base 'keepa' creada.");
} catch {
  console.log("Base 'keepa' ya existía.");
}

console.log("✅ Postgres local corriendo en localhost:5433/keepa (user postgres / pass postgres)");

process.stdin.resume();
const stop = async () => {
  console.log("\nParando Postgres...");
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

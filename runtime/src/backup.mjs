import { mkdirSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";

const sourcePath = process.env.DATABASE_PATH || "/data/pact.sqlite";
const backupDir = process.env.BACKUP_DIR || "/data/backups";
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll(":", "-").replace(".000Z", "Z");
const targetPath = `${backupDir}/pact-${stamp}.sqlite`;
const database = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(database, targetPath);
  process.stdout.write(`${targetPath}\n`);
} finally {
  database.close();
}

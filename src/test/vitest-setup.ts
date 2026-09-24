/**
 * Isolate tests from the operator's live data/ tree (and any FARMER_* env the
 * farmer/dash PM2 processes export). Runs before each test file loads config.ts.
 */
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "farmer-vitest-"));
const tmpl = join(process.cwd(), "config.toml");
process.env.FARMER_CONFIG_PATH = join(dir, "config.toml");
process.env.FARMER_ENV_PATH = join(dir, ".env");
process.env.FARMER_DB_PATH = ":memory:";
delete process.env.FARMER_ROOT;
// Mode isolation: config.ts copies the repo .env into FARMER_ENV_PATH when the
// target is missing, and its loader also falls back to cwd/.env — both carry
// FARMER_MODE=live on this box, which flips currentMode() to "live" and makes
// every paper-mode test row invisible to mode-filtered risk/loop queries (58
// silent failures). process.env wins over both file reads, and setup runs
// before config.ts loads; tests that need live mode set it explicitly.
process.env.FARMER_MODE = "paper";

if (existsSync(tmpl)) copyFileSync(tmpl, process.env.FARMER_CONFIG_PATH);
else writeFileSync(process.env.FARMER_CONFIG_PATH, "");
// Pre-create an empty .env so ensureRuntimeDefaults never bootstraps it from
// the repo checkout's secrets.
writeFileSync(process.env.FARMER_ENV_PATH, "");

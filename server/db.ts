import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- infra-agent instances (ADR 0018, 0031). Each enrols once with a one-time token and then has its own secret;
   -- only hashes of both are stored. The agent keeps its SSH CA and keys; we keep what it reports for Setup.
   CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     enroll_token_hash TEXT UNIQUE,
     enroll_expires_at TEXT,
     secret_hash TEXT UNIQUE,
     version TEXT,
     ca_public_key TEXT,
     key_public_key TEXT,
     setup TEXT,
     last_seen_at TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL
   );
   -- Hosts an agent reads over SSH. host_keys are pinned after an admin checked the fingerprint; pending_host_keys
   -- are what the host presents now when it differs.
   CREATE TABLE hosts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     agent_id TEXT NOT NULL REFERENCES agents (id),
     address TEXT NOT NULL,
     port INTEGER NOT NULL DEFAULT 22,
     ssh_user TEXT NOT NULL DEFAULT 'openasy',
     auth TEXT NOT NULL CHECK (auth IN ('certificate', 'key')),
     jump_host_id TEXT REFERENCES hosts (id) ON DELETE SET NULL,
     containers INTEGER NOT NULL DEFAULT 0,
     interval_minutes INTEGER NOT NULL DEFAULT 5,
     tags TEXT NOT NULL DEFAULT '{}',
     host_keys TEXT NOT NULL DEFAULT '[]',
     pending_host_keys TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'new',
     status_detail TEXT,
     last_attempt_at TEXT,
     last_success_at TEXT,
     collect_requested INTEGER NOT NULL DEFAULT 0,
     -- Ask the agent for the key the host presents.
     key_requested INTEGER NOT NULL DEFAULT 1,
     -- A job handed to the agent and not answered yet; handed out again after this time.
     lease_until TEXT,
     -- The last collection, gzipped JSON: what the screens show, including values that move (load, free memory).
     latest_facts BLOB,
     created_at TEXT NOT NULL
   );
   -- Kubernetes clusters read through their API with a read-only token.
   CREATE TABLE clusters (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     server TEXT NOT NULL,
     ca_cert TEXT,
     token_sealed TEXT NOT NULL,
     interval_minutes INTEGER NOT NULL DEFAULT 5,
     tags TEXT NOT NULL DEFAULT '{}',
     status TEXT NOT NULL DEFAULT 'new',
     status_detail TEXT,
     last_attempt_at TEXT,
     last_success_at TEXT,
     collect_requested INTEGER NOT NULL DEFAULT 0,
     latest_facts BLOB,
     created_at TEXT NOT NULL
   );
   -- One row per collection that found something different from the last one; collections that changed nothing
   -- only move last_success_at. facts is gzipped JSON.
   CREATE TABLE snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     target_kind TEXT NOT NULL CHECK (target_kind IN ('host', 'cluster')),
     target_id TEXT NOT NULL,
     collected_at TEXT NOT NULL,
     items_hash TEXT NOT NULL,
     facts BLOB NOT NULL
   );
   CREATE INDEX snapshots_target ON snapshots (target_kind, target_id, collected_at);
   CREATE TABLE changes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     target_kind TEXT NOT NULL,
     target_id TEXT NOT NULL,
     at TEXT NOT NULL,
     category TEXT NOT NULL,
     item TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('added', 'removed', 'changed')),
     before TEXT,
     after TEXT
   );
   CREATE INDEX changes_target ON changes (target_kind, target_id, at);
   CREATE INDEX changes_at ON changes (at)`,
  `-- Hosts from the hosts file (OPENASY_HOSTS, ADR 0052) are changed there, not here. file_host_key is the fingerprint
   -- the file gives: a host that presents that key is trusted without an admin comparing it.
   ALTER TABLE hosts ADD COLUMN source TEXT NOT NULL DEFAULT 'ui' CHECK (source IN ('ui', 'file'));
   ALTER TABLE hosts ADD COLUMN file_host_key TEXT`,
  `-- A host from the file with auth key may name a private key in the agent's key folder. Only the name is kept: the
   -- agent reads the file itself, so Infrastructure never holds a key that opens a host (ADR 0031).
   ALTER TABLE hosts ADD COLUMN key_file TEXT`,
  `-- Each host's packages as last sent to Vulnerabilities (INFRA_VULNS_URL): their hash, whether a send is due, and
   -- why the last one failed. asset_id is the host in Vulnerabilities, for a link to it.
   CREATE TABLE vulns_sends (
     host_id TEXT PRIMARY KEY REFERENCES hosts (id) ON DELETE CASCADE,
     hash TEXT,
     due INTEGER NOT NULL DEFAULT 0,
     sent_at TEXT,
     attempt_at TEXT,
     error TEXT,
     asset_id TEXT
   )`,
  `-- BMCs from the hosts file's bmcs: list, read over Redfish by an agent (ADR 0055). Only the name of the password file
   -- is kept: the agent reads the password itself. certificates are the pinned SHA-256 fingerprints of the BMC's TLS
   -- certificate; pending_certificate is the one it presents now when it differs, as JSON.
   CREATE TABLE bmcs (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     agent_id TEXT NOT NULL REFERENCES agents (id),
     address TEXT NOT NULL,
     port INTEGER NOT NULL DEFAULT 443,
     bmc_user TEXT NOT NULL,
     password_file TEXT NOT NULL,
     server TEXT,
     tags TEXT NOT NULL DEFAULT '{}',
     interval_minutes INTEGER NOT NULL DEFAULT 15,
     certificates TEXT NOT NULL DEFAULT '[]',
     pending_certificate TEXT,
     file_certificate TEXT,
     status TEXT NOT NULL DEFAULT 'new',
     status_detail TEXT,
     last_attempt_at TEXT,
     last_success_at TEXT,
     collect_requested INTEGER NOT NULL DEFAULT 0,
     certificate_requested INTEGER NOT NULL DEFAULT 1,
     lease_until TEXT,
     latest_facts BLOB,
     created_at TEXT NOT NULL
   );
   -- snapshots names the kinds it holds in a CHECK, which SQLite cannot change in place: the table is copied.
   CREATE TABLE snapshots_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     target_kind TEXT NOT NULL CHECK (target_kind IN ('host', 'cluster', 'bmc')),
     target_id TEXT NOT NULL,
     collected_at TEXT NOT NULL,
     items_hash TEXT NOT NULL,
     facts BLOB NOT NULL
   );
   INSERT INTO snapshots_new (id, target_kind, target_id, collected_at, items_hash, facts)
     SELECT id, target_kind, target_id, collected_at, items_hash, facts FROM snapshots;
   DROP TABLE snapshots;
   ALTER TABLE snapshots_new RENAME TO snapshots;
   CREATE INDEX snapshots_target ON snapshots (target_kind, target_id, collected_at)`,
  `-- Which machine a host and a BMC say they are on, and the BMC's health, from their last collection, as JSON: a host
   -- and its BMC are matched by them without reading every collection (ADR 0055).
   ALTER TABLE hosts ADD COLUMN hardware TEXT;
   ALTER TABLE bmcs ADD COLUMN hardware TEXT`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

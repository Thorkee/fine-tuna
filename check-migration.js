/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const dns = require("dns");
const util = require("util");

const lookup = util.promisify(dns.lookup);

// Prefer IPv4 when available, but allow IPv6-only hosts (some Supabase DB hosts publish AAAA only).
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

// Load .env.local if present (so POSTGRES_URL etc. are available)
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Support common .env variants:
    // - KEY=value
    // - KEY = value
    // - export KEY=value
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = (m[2] ?? "").trim();
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (!isQuoted) {
      // Basic inline comment stripping for unquoted values.
      // (If a value needs #, it should be quoted in .env.local)
      const hashIdx = value.indexOf(" #");
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    value = value.replace(/^["']|["']$/g, "").trim();
    process.env[key] = value;
  }
}

const EXPECTED_PUBLIC_TABLES = [
  "profiles",
  "user_integrations",
  "integration_repo_connections",
  "chats",
  "messages",
  "agent_states",
  "agent_runs",
  "projects",
  "uploaded_files",
  "eda_results",
  "training_goals",
  "training_jobs",
  "training_checkpoints",
  "model_artifacts",
  "research_sources",
  "chat_shares",
  "billing_accounts",
  "billing_customers",
  "billing_subscriptions",
  "billing_rates",
  "billing_skus",
  "credit_ledger",
  "e2b_session_meters",
  "e2b_training_task_meters",
];

function parseDatabaseUrl(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: parseInt(u.port || "5432", 10),
      user: u.username,
      password: u.password,
      database: u.pathname.slice(1) || "postgres",
    };
  } catch {
    return null;
  }
}

async function resolveDbHostPreferIpv4(host) {
  if (!host) return host;
  const isHostname = /[a-zA-Z]/.test(host);
  if (!isHostname) return host;

  try {
    const v4 = await dns.promises.resolve4(host);
    if (Array.isArray(v4) && v4.length) return v4[0];
  } catch (_) {
    // ignore
  }
  try {
    const v6 = await dns.promises.resolve6(host);
    if (Array.isArray(v6) && v6.length) return v6[0];
  } catch (_) {
    // ignore
  }

  // Fallback to system resolver / default ordering.
  return (await lookup(host)).address;
}

function inferSupabaseProjectRef() {
  const explicit = (process.env.SUPABASE_PROJECT_REF || "").trim();
  if (explicit) return explicit;

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  if (url) {
    try {
      const host = new URL(url).host; // <ref>.supabase.co
      const m = host.match(/^([a-z0-9-]+)\.supabase\.co$/i);
      if (m) return m[1];
    } catch (_) {
      // ignore
    }
  }

  return "";
}

function maybeRewritePoolerUsername(username, connectHostName) {
  const override = (process.env.SUPABASE_DB_USER_OVERRIDE || "").trim();
  if (override) return override;

  if (!connectHostName || !connectHostName.endsWith(".pooler.supabase.com")) return username;
  if (!username || username === "postgres") {
    const ref = inferSupabaseProjectRef();
    if (ref) return `postgres.${ref}`;
  }
  return username;
}

async function getClient() {
  const databaseUrl =
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL;
  let config;

  if (databaseUrl) {
    config = parseDatabaseUrl(databaseUrl);
    if (!config) throw new Error("Invalid POSTGRES_URL / DATABASE_URL / SUPABASE_DB_URL");
    const hostOverride = (process.env.SUPABASE_DB_HOST_OVERRIDE || "").trim();
    const portOverrideRaw = (process.env.SUPABASE_DB_PORT_OVERRIDE || "").trim();
    const portOverride = portOverrideRaw ? Number(portOverrideRaw) : undefined;

    const connectHostName = hostOverride || config.host;
    const connectHost = await resolveDbHostPreferIpv4(connectHostName);
    const connectPort = Number.isFinite(portOverride)
      ? portOverride
      : connectHostName.endsWith(".pooler.supabase.com")
        ? 5432
        : config.port;
    const connectUser = maybeRewritePoolerUsername(config.user, connectHostName);

    return new Client({
      host: connectHost,
      port: connectPort,
      user: connectUser,
      password: config.password,
      database: config.database,
      ssl: { rejectUnauthorized: false },
    });
  }

  const host = (process.env.SUPABASE_DB_HOST || process.env.PGHOST || "").trim();
  if (!host) throw new Error("Set POSTGRES_URL, DATABASE_URL, or PGHOST/SUPABASE_DB_HOST");
  const user = (process.env.SUPABASE_DB_USER || process.env.PGUSER || "postgres").trim();
  const password = process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD || "";
  const database = (process.env.SUPABASE_DB_NAME || process.env.PGDATABASE || "postgres").trim();
  const port = Number(process.env.PGPORT || process.env.SUPABASE_DB_PORT || "5432");
  const hostOverride = (process.env.SUPABASE_DB_HOST_OVERRIDE || "").trim();
  const portOverrideRaw = (process.env.SUPABASE_DB_PORT_OVERRIDE || "").trim();
  const portOverride = portOverrideRaw ? Number(portOverrideRaw) : undefined;

  const connectHostName = hostOverride || host;
  const connectHost = await resolveDbHostPreferIpv4(connectHostName);
  const connectPort = Number.isFinite(portOverride)
    ? portOverride
    : connectHostName.endsWith(".pooler.supabase.com")
      ? 5432
      : port;
  const connectUser = maybeRewritePoolerUsername(user, connectHostName);

  const client = new Client({
    host: connectHost,
    port: connectPort,
    user: connectUser,
    password: String(password).trim(),
    database,
    ssl: { rejectUnauthorized: false },
  });
  return client;
}

async function checkMigration() {
  let client;
  try {
    client = await getClient();
    await client.connect();
    console.log("Connected. Checking schema against supabase/schema.sql...\n");

    const tablesRes = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const existingTables = new Set(tablesRes.rows.map((r) => r.table_name));

    const missingTables = EXPECTED_PUBLIC_TABLES.filter((t) => !existingTables.has(t));
    const extraTables = [...existingTables].filter((t) => !EXPECTED_PUBLIC_TABLES.includes(t));

    if (missingTables.length) {
      console.log("Missing tables (migration not fully applied):");
      missingTables.forEach((t) => console.log("  -", t));
      console.log("");
    } else {
      console.log("All expected public tables exist.");
    }
    if (extraTables.length) {
      console.log("Extra public tables (not in schema):", extraTables.join(", "));
    }

    const extRes = await client.query(
      "SELECT extname FROM pg_extension WHERE extname = 'uuid-ossp'"
    );
    if (extRes.rows.length === 0) {
      console.log("uuid-ossp extension: MISSING (schema expects it)");
    } else {
      console.log("uuid-ossp extension: ok");
    }

    try {
      const pubRes = await client.query(
        "SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'messages'"
      );
      if (pubRes.rows.length === 0) {
        console.log("Realtime (messages in supabase_realtime): MISSING");
      } else {
        console.log("Realtime (messages in supabase_realtime): ok");
      }
    } catch (e) {
      console.log("Realtime check:", e.message);
    }

    try {
      const bucketRes = await client.query(
        "SELECT id FROM storage.buckets WHERE id IN ('uploads', 'artifacts')"
      );
      const bucketIds = bucketRes.rows.map((r) => r.id);
      const missingBuckets = ["uploads", "artifacts"].filter((b) => !bucketIds.includes(b));
      if (missingBuckets.length) {
        console.log("Storage buckets missing:", missingBuckets.join(", "));
      } else {
        console.log("Storage buckets (uploads, artifacts): ok");
      }
    } catch (e) {
      console.log("Storage buckets check:", e.message);
    }

    const allOk =
      missingTables.length === 0 &&
      extRes.rows.length > 0;
    console.log("");
    if (allOk && !missingTables.length) {
      console.log("Migration appears complete. Run 'node migrate.js' if you see any MISSING above.");
    } else {
      console.log("Run: node migrate.js (with same DB env vars) to apply supabase/schema.sql");
    }
  } catch (err) {
    if (
      err &&
      err.code === "EHOSTUNREACH" &&
      typeof err.address === "string" &&
      err.address.includes(":")
    ) {
      console.error(
        [
          "",
          "Hint: your DB hostname resolved to an IPv6-only address, but this machine can't reach IPv6 (EHOSTUNREACH).",
          "Fix: use a Supabase Postgres connection string/host that has IPv4 (often the pooling host ending in '.pooler.supabase.com'),",
          "or run 'supabase/schema.sql' directly in the Supabase SQL editor.",
          "You can also set SUPABASE_DB_HOST_OVERRIDE to override the hostname used by this script (no code changes needed).",
          "",
        ].join("\n")
      );
    }
    console.error("Check failed:", err.message);
    process.exit(1);
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

checkMigration();

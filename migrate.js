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

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(v).trim();
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

async function runMigration() {
  const databaseUrl =
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL;

  if (databaseUrl) {
    const parsed = parseDatabaseUrl(databaseUrl);
    if (!parsed) {
      throw new Error("Invalid POSTGRES_URL / DATABASE_URL / SUPABASE_DB_URL");
    }
  }

  const host = (process.env.SUPABASE_DB_HOST || process.env.PGHOST || "").trim();
  const user = (process.env.SUPABASE_DB_USER || process.env.PGUSER || "postgres").trim();
  const password = process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD || "";
  const database = (process.env.SUPABASE_DB_NAME || process.env.PGDATABASE || "postgres").trim();
  const port = Number(process.env.PGPORT || process.env.SUPABASE_DB_PORT || "5432");

  if (!databaseUrl) {
    if (!host) {
      throw new Error("Missing DB host. Set SUPABASE_DB_HOST or PGHOST.");
    }
    if (!password || !String(password).trim()) {
      requireEnv("SUPABASE_DB_PASSWORD"); // throws with a clearer message
    }
    if (!Number.isFinite(port)) {
      throw new Error("Invalid DB port. Set PGPORT or SUPABASE_DB_PORT.");
    }
  }

  let client;
  try {
    if (databaseUrl) {
      const parsed = parseDatabaseUrl(databaseUrl);
      if (!parsed) {
        throw new Error("Invalid POSTGRES_URL / DATABASE_URL / SUPABASE_DB_URL");
      }

      // Resolve IPv4 first (some environments prefer this for Postgres connectivity).
      const hostOverride = (process.env.SUPABASE_DB_HOST_OVERRIDE || "").trim();
      const portOverrideRaw = (process.env.SUPABASE_DB_PORT_OVERRIDE || "").trim();
      const portOverride = portOverrideRaw ? Number(portOverrideRaw) : undefined;

      const resolveHost = hostOverride || parsed.host;
      console.log(`Resolving ${resolveHost}...`);
      const address = await resolveDbHostPreferIpv4(resolveHost);
      console.log(`Resolved to ${address}`);

      const connectUser = maybeRewritePoolerUsername(parsed.user, resolveHost);
      const connectPort = Number.isFinite(portOverride)
        ? portOverride
        : resolveHost.endsWith(".pooler.supabase.com")
          ? 5432
          : parsed.port;

      client = new Client({
        host: address,
        port: connectPort,
        user: connectUser,
        password: parsed.password,
        database: parsed.database,
        ssl: { rejectUnauthorized: false },
      });
    } else {
      // Resolve IPv4 first (some environments prefer this for Postgres connectivity).
      const hostOverride = (process.env.SUPABASE_DB_HOST_OVERRIDE || "").trim();
      const portOverrideRaw = (process.env.SUPABASE_DB_PORT_OVERRIDE || "").trim();
      const portOverride = portOverrideRaw ? Number(portOverrideRaw) : undefined;

      const resolveHost = hostOverride || host;
      console.log(`Resolving ${resolveHost}...`);
      const address = await resolveDbHostPreferIpv4(resolveHost);
      console.log(`Resolved to ${address}`);

      const connectUser = maybeRewritePoolerUsername(user, resolveHost);
      const connectPort = Number.isFinite(portOverride)
        ? portOverride
        : resolveHost.endsWith(".pooler.supabase.com")
          ? 5432
          : port;

      client = new Client({
        host: address,
        port: connectPort,
        user: connectUser,
        password: String(password).trim(),
        database,
        ssl: { rejectUnauthorized: false },
      });
    }

    await client.connect();
    console.log("Connected to database");

    const schemaPath = path.join(process.cwd(), "supabase", "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");

    console.log("Running migration...");
    await client.query(sql);
    console.log("Migration completed successfully.");
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
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    if (client) {
      await client.end().catch(() => undefined);
    }
  }
}

runMigration().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

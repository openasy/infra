import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { openDb } from "./db.ts";
import { watchHosts } from "./hosts.ts";
import { createInfra } from "./infra.ts";
import { createKeyring } from "./kek.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { createVulnsLink } from "./vulns.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.INFRA_DB ?? "/data/infra.db";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.INFRA_HEADLESS === "true";
const retentionDays = Number(process.env.INFRA_RETENTION_DAYS ?? 365);
const secretsKeyFile = process.env.INFRA_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";

// Cluster tokens and sign-in secrets are encrypted with it (ADR 0021): Infrastructure does not start without it.
const kek = readSecretsKey(secretsKeyFile);
if (!kek) {
  log("error", "no key-encryption key: mount 32 random bytes (openssl rand -hex 32) and set INFRA_SECRETS_KEY_FILE if not at the default", {
    file: secretsKeyFile,
  });
  process.exit(1);
}
if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("INFRA_RETENTION_DAYS must be a number of days");

const db = openDb(dbPath);
const keyring = createKeyring(kek);
// Each host's packages to Vulnerabilities, so the hosts Infrastructure reads need no vulns-agent (ADR 0031).
const vulnsUrl = process.env.INFRA_VULNS_URL?.trim();
const vulnsToken = process.env.INFRA_VULNS_TOKEN?.trim();
if (!!vulnsUrl !== !!vulnsToken)
  log("warn", "set both INFRA_VULNS_URL and INFRA_VULNS_TOKEN to send hosts' packages to Vulnerabilities; neither is used alone");
const vulns = vulnsUrl && vulnsToken ? createVulnsLink({ db, url: vulnsUrl, token: vulnsToken, version, log }) : undefined;
const infra = createInfra(db, keyring, { version, concurrency: Number(process.env.INFRA_CONCURRENCY ?? 4), vulns });
// The address people open Infrastructure at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC use it.
const publicUrl = (process.env.INFRA_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const auth = createAuth({
  db,
  product: "infra",
  productName: "OpenAsy Infrastructure",
  origin: publicUrl,
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.INFRA_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "INFRA_"),
  secretsKey: kek,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" || event.type === "session-ended" ? "warn" : "info", "auth", { event }),
});

const metricsPort = process.env.INFRA_METRICS_PORT ? Number(process.env.INFRA_METRICS_PORT) : undefined;
// The install's servers, one file for every product that reaches them (ADR 0052).
const hostsPath = process.env.OPENASY_HOSTS?.trim() || undefined;
const hostsFile = hostsPath
  ? watchHosts(hostsPath, (list, bmcs) => infra.syncFile(list, bmcs), {
      onChange: (s) =>
        s.error
          ? log("error", "hosts file not applied; the hosts from its last good version stay", { path: s.path, error: s.error })
          : log(s.warnings.length ? "warn" : "info", "hosts file applied", { path: s.path, entries: s.entries, warnings: s.warnings }),
    })
  : undefined;
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    infra,
    auth,
    version,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    products: products.products,
    serveMetrics: metricsPort === undefined,
    hostsFile: hostsFile && (() => hostsFile.state),
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(infra, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "infra started", { version, port, db: dbPath, headless, vulns: vulnsUrl && vulnsToken ? vulnsUrl : null }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "INFRA_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put Infrastructure behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

let ticking = false;
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    infra
      .tick()
      .catch((err: unknown) => log("error", "collection round failed", { error: String(err) }))
      .finally(() => (ticking = false));
  }, 10_000),
  setInterval(() => infra.purge(retentionDays), 24 * 3_600_000),
  ...(vulns ? [setInterval(() => void vulns.deliver(), 30_000)] : []),
];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  hostsFile?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

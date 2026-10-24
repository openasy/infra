import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";
import { AuthError, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { HostsFileState } from "./hosts.ts";
import { InfraError, type Infra, type ProblemCode } from "./infra.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  infra: Infra;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
  /** Where the hosts file stands (OPENASY_HOSTS, ADR 0052); absent when there is none. */
  hostsFile?: () => HostsFileState;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
}

/** Serves only /metrics, for a port that is not exposed with the rest (INFRA_METRICS_PORT). */
export function createMetricsHandler(infra: Infra, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, renderMetrics(version, infra.summary()), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}
const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));

const TITLES: Record<ProblemCode, string> = {
  "invalid-json": "Invalid JSON",
  "invalid-token": "Invalid token",
  "version-mismatch": "Version mismatch",
  "invalid-body": "Invalid request body",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-configured": "Not configured",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/** Reads a JSON body, gunzipping it when sent with Content-Encoding: gzip (agents do), up to limit bytes. */
async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const encoding = req.headers["content-encoding"];
  if (encoding && encoding !== "gzip" && encoding !== "identity") throw new InfraError(400, "invalid-json", "Content-Encoding must be gzip or absent.");
  const source = encoding === "gzip" ? req.pipe(createGunzip()) : req;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new InfraError(400, "invalid-json", `The body must be JSON, at most ${Math.round(limit / 1024)} KiB.`);
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof InfraError) throw err;
    throw new InfraError(400, "invalid-json", "The gzip body could not be read.");
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new InfraError(400, "invalid-json", "The body must be a JSON object.");
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
  /** The calling agent, on agent routes. */
  agent: ReturnType<Infra["agentBySecret"]>;
}
interface Route {
  method: string;
  path: string;
  /** The role a route needs (ADR 0003), or "agent" for infra-agent with its own secret. */
  auth: "none" | "agent" | Role;
  /** Largest body; 64 KiB by default. */
  bodyLimit?: number;
  handle: (ctx: Ctx) => unknown;
}

/** Facts from a host with many packages and processes, uncompressed. */
const RESULT_LIMIT = 32 * 1024 * 1024;

function limitOf(url: URL) {
  const v = url.searchParams.get("limit");
  if (v === null) return 100;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new InfraError(422, "invalid-body", "limit is 1 to 500.");
  return n;
}
function cursorOf(url: URL) {
  const v = url.searchParams.get("cursor");
  if (v === null) return undefined;
  if (!/^\d+$/.test(v)) throw new InfraError(422, "invalid-body", "cursor is the nextCursor of the previous page.");
  return Number(v);
}
function timeOf(url: URL, name: string) {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  if (Number.isNaN(Date.parse(v))) throw new InfraError(422, "invalid-body", `${name} is a date and time, such as 2026-10-20T10:00:00Z.`);
  return new Date(v).toISOString();
}

export function createApp({ db, infra, version, auth, webDir, docsDir, openapi, products = [], serveMetrics = true, hostsFile }: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const created = (res: ServerResponse, data: unknown) => (json(res, 201, data), undefined);
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const accepted = (res: ServerResponse) => (json(res, 202, { status: "requested" }), undefined);
  const changesOf = (url: URL, kind?: "host" | "cluster", id?: string) => {
    const kindParam = url.searchParams.get("kind");
    if (kindParam !== null && kindParam !== "host" && kindParam !== "cluster") throw new InfraError(422, "invalid-body", "kind is host or cluster.");
    return infra.changes({
      kind: kind ?? (kindParam as "host" | "cluster" | null) ?? undefined,
      id,
      category: url.searchParams.get("category") ?? undefined,
      since: timeOf(url, "since"),
      cursor: cursorOf(url),
      limit: limitOf(url),
    });
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "infra", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => ({ ...infra.summary(), hostsFile: hostsFile?.() ?? null }) },

    // The read-only Kubernetes role. What to put on hosts comes from each agent.
    { method: "GET", path: "/api/v1/setup", auth: "viewer", handle: () => ({ kubernetesRbac: infra.kubernetesRbac() }) },

    // infra-agent instances (ADR 0018, 0031): added here, enrolled with a one-time token.
    { method: "GET", path: "/api/v1/agents", auth: "viewer", handle: () => ({ agents: infra.listAgents() }) },
    { method: "POST", path: "/api/v1/agents", auth: "admin", handle: async ({ res, body }) => created(res, infra.createAgent(await body())) },
    { method: "GET", path: "/api/v1/agents/:id", auth: "viewer", handle: ({ params }) => infra.agent(params[0]!) },
    { method: "DELETE", path: "/api/v1/agents/:id", auth: "admin", handle: ({ res, params }) => (infra.deleteAgent(params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/agents/:id/enroll-token", auth: "admin", handle: ({ params }) => infra.reEnroll(params[0]!) },
    { method: "GET", path: "/api/v1/agents/:id/setup", auth: "viewer", handle: ({ params }) => infra.agentSetup(params[0]!) },

    // What infra-agent calls. It asks; Infrastructure never connects to it.
    { method: "POST", path: "/api/v1/agent/enroll", auth: "none", handle: async ({ body }) => infra.enroll(await body()) },
    { method: "POST", path: "/api/v1/agent/work", auth: "agent", handle: async ({ agent, body }) => infra.work(agent, await body()) },
    {
      method: "POST",
      path: "/api/v1/agent/results",
      auth: "agent",
      bodyLimit: RESULT_LIMIT,
      handle: async ({ res, agent, body }) => (json(res, 202, infra.result(agent, await body())), undefined),
    },

    // Hosts over SSH.
    { method: "GET", path: "/api/v1/hosts", auth: "viewer", handle: () => ({ hosts: infra.listHosts() }) },
    { method: "GET", path: "/api/v1/hosts/:id", auth: "viewer", handle: ({ params }) => infra.host(params[0]!) },
    { method: "DELETE", path: "/api/v1/hosts/:id", auth: "admin", handle: ({ res, params }) => (infra.deleteHost(params[0]!), noContent(res)) },
    {
      method: "GET",
      path: "/api/v1/hosts/:id/facts",
      auth: "viewer",
      handle: ({ url, params }) => {
        const f = infra.hostFacts(params[0]!, timeOf(url, "at"));
        if (!f) throw new InfraError(404, "not-found", "Nothing collected from this host yet.");
        return f;
      },
    },
    {
      method: "GET",
      path: "/api/v1/hosts/:id/changes",
      auth: "viewer",
      handle: ({ url, params }) => (infra.host(params[0]!), changesOf(url, "host", params[0]!)),
    },
    {
      method: "POST",
      path: "/api/v1/hosts/:id/collect",
      auth: "editor",
      handle: ({ res, params }) => (infra.requestCollect("host", params[0]!), accepted(res)),
    },
    // Host keys: ask the host again, and accept one after checking its fingerprint on the host (ADR 0031).
    { method: "POST", path: "/api/v1/hosts/:id/host-key", auth: "admin", handle: ({ params }) => infra.requestHostKey(params[0]!) },
    {
      method: "POST",
      path: "/api/v1/hosts/:id/host-key/accept",
      auth: "admin",
      handle: async ({ params, body }) => infra.acceptHostKey(params[0]!, (await body()).fingerprint),
    },

    // Kubernetes through its API.
    { method: "GET", path: "/api/v1/clusters", auth: "viewer", handle: () => ({ clusters: infra.listClusters() }) },
    { method: "POST", path: "/api/v1/clusters", auth: "admin", handle: async ({ res, body }) => created(res, infra.createCluster(await body())) },
    { method: "GET", path: "/api/v1/clusters/:id", auth: "viewer", handle: ({ params }) => infra.cluster(params[0]!) },
    { method: "PATCH", path: "/api/v1/clusters/:id", auth: "admin", handle: async ({ params, body }) => infra.updateCluster(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/clusters/:id", auth: "admin", handle: ({ res, params }) => (infra.deleteCluster(params[0]!), noContent(res)) },
    {
      method: "GET",
      path: "/api/v1/clusters/:id/facts",
      auth: "viewer",
      handle: ({ params }) => {
        const f = infra.clusterFacts(params[0]!);
        if (!f) throw new InfraError(404, "not-found", "Nothing collected from this cluster yet.");
        return f;
      },
    },
    {
      method: "GET",
      path: "/api/v1/clusters/:id/changes",
      auth: "viewer",
      handle: ({ url, params }) => (infra.cluster(params[0]!), changesOf(url, "cluster", params[0]!)),
    },
    {
      method: "POST",
      path: "/api/v1/clusters/:id/collect",
      auth: "editor",
      handle: ({ res, params }) => (infra.requestCollect("cluster", params[0]!), accepted(res)),
    },

    // Across everything.
    { method: "GET", path: "/api/v1/containers", auth: "viewer", handle: () => ({ containers: infra.containers() }) },
    { method: "GET", path: "/api/v1/changes", auth: "viewer", handle: ({ url }) => changesOf(url) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");
    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }
    if (path === "/metrics") {
      if (!serveMetrics) problem(res, 404, "not-found");
      else send(res, 200, renderMetrics(version, infra.summary()), "text/plain; version=0.0.4");
      return "/metrics";
    }
    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");
    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      if (!(await serveFile(res, docsDir, path.slice("/api/docs/".length) || "index.html"))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const agent = r.auth === "agent" ? infra.agentBySecret(req.headers.authorization) : (undefined as never);
        if (r.auth !== "none" && r.auth !== "agent") auth.authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, agent, body: () => readJson(req, r.bodyLimit) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) sendProblem(res, err);
        else if (err instanceof InfraError) problem(res, err.status, err.code, err.message);
        else throw err;
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");
    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }
    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: (req.url ?? "/").split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

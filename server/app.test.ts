import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI } from "../scripts/openapi.ts";
import { fingerprint } from "./infra.ts";
import { CA_KEY, facts, HOST_KEY, OTHER_KEY, REPORT, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response matches openapi.json and every operation is called. The scenario is
// also the behaviour test: agents, roles, host keys, collections, changes.

type Spec = typeof OPENAPI & { paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>> };
const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");
const covered = new Set<string>();

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version, openapi: spec });
});
afterAll(() => app.close());

type Role = "admin" | "editor" | "viewer" | "none";
async function call(role: Role | { secret: string }, method: string, path: string, opts: { concrete?: string; body?: unknown } = {}) {
  const url = app.base + (opts.concrete ?? path);
  const init: RequestInit = { method, ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }) };
  const res =
    typeof role === "object"
      ? await fetch(url, { ...init, headers: { authorization: `Bearer ${role.secret}`, "content-type": "application/json" } })
      : role === "none"
        ? await fetch(url, { ...init, headers: { "content-type": "application/json" } })
        : await app[role](opts.concrete ?? path, init);
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${opts.concrete ?? path} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? (spec.components.responses as Record<string, { content: Record<string, unknown> }>)[shared]! : declared!;
  if (!response.content) return { status: res.status, body: undefined as never };
  const type = res.headers.get("content-type")!.split(";")[0]!;
  const data = type.endsWith("json") ? await res.json() : await res.text();
  const at = shared ? `openapi#/components/responses/${shared}` : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(data), `${method} ${opts.concrete ?? path}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { status: res.status, body: data };
}

type Host = { id: string; status: string; pendingHostKeys: Array<{ fingerprint: string }>; summary: { packages: number } | null };
const hostPath = (id: string, rest = "") => `/api/v1/hosts/${id}${rest}`;
let agent: Awaited<ReturnType<Awaited<ReturnType<typeof startApp>>["enroll"]>>;

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes", () => {
    expect(JSON.parse(JSON.stringify(OPENAPI))).toEqual(spec);
    expect(spec.info.version).toBe(version);
  });

  it("is served with sign-in merged in", async () => {
    const served = (await (await fetch(`${app.base}/api/openapi.json`)).json()) as Spec;
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });
});

describe("agents", () => {
  it("are added by admins and enrol once with their token", async () => {
    expect((await call("editor", "POST", "/api/v1/agents", { body: { name: "dc-1" } })).status).toBe(403);
    const created = await call("admin", "POST", "/api/v1/agents", { body: { name: "dc-1" } });
    expect(created.status).toBe(201);
    const { agent: a, enrollToken } = created.body as { agent: { id: string; status: string }; enrollToken: string };
    expect(a.status).toBe("waiting-to-enrol");
    expect((await call("admin", "POST", "/api/v1/agents", { body: { name: "dc-1" } })).status).toBe(409);
    expect((await call("viewer", "GET", "/api/v1/agents/{id}/setup", { concrete: `/api/v1/agents/${a.id}/setup` })).status).toBe(409);
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: "oie_wrong", ...REPORT(version) } })).status).toBe(401);
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: enrollToken, ...REPORT(version), caPublicKey: "not a key" } })).status).toBe(422);
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: enrollToken, ...REPORT(version) } })).status).toBe(200);
    // The token works once.
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: enrollToken, ...REPORT(version) } })).status).toBe(401);
    const setup = (await call("viewer", "GET", "/api/v1/agents/{id}/setup", { concrete: `/api/v1/agents/${a.id}/setup` })).body as { caPublicKey: string; caFingerprint: string };
    expect(setup).toMatchObject({ caPublicKey: CA_KEY, caFingerprint: fingerprint(CA_KEY) });
    expect((await call("admin", "DELETE", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${a.id}` })).status).toBe(204);
    agent = await app.enroll("dc-main");
    await agent.round();
    expect((await call("viewer", "GET", "/api/v1/agents")).body).toMatchObject({ agents: [{ name: "dc-main", status: "online" }] });
  });

  it("refuse an unknown secret and another version", async () => {
    expect((await call({ secret: "oia_nope" }, "POST", "/api/v1/agent/work", { body: REPORT(version) })).status).toBe(401);
    const res = await agent.post("/api/v1/agent/work", REPORT("0.0.1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "version-mismatch" });
    expect(((await call("viewer", "GET", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${agent.id}` })).body as { status: string }).status).toBe("version-mismatch");
    await agent.round();
  });
});

describe("hosts", () => {
  let web: Host;

  it("are added and wait for their key to be checked", async () => {
    agent.hosts.set("10.0.0.5", { key: HOST_KEY, facts: facts("debian-sudo") });
    expect((await call("none", "GET", "/api/v1/hosts")).status).toBe(401);
    expect((await call("editor", "POST", "/api/v1/hosts", { body: { name: "web-1", address: "10.0.0.5" } })).status).toBe(403);
    const r = await call("admin", "POST", "/api/v1/hosts", { body: { name: "web-1", address: "10.0.0.5", tags: { env: "prod" } } });
    expect(r.status).toBe(201);
    web = r.body as Host;
    expect(web).toMatchObject({ status: "new", agent: { name: "dc-main" } });
    expect((await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") })).status).toBe(409);
    // The agent asks the host for its key; nothing is collected before an admin accepts it.
    expect((await agent.round()).map((j) => j.action)).toEqual(["host-key"]);
    web = (await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body as Host;
    expect(web).toMatchObject({ status: "host-key-pending", pendingHostKeys: [{ fingerprint: fingerprint(HOST_KEY) }], summary: null });
    expect(await agent.round()).toEqual([]);
  });

  it("refuse bad input, including values ssh could read as options", async () => {
    for (const body of [{ name: "x", address: "-oProxyCommand=sh" }, { name: "x", address: "10.0.0.6", user: "-oX" }, { name: "x y", address: "a" }, { name: "x", address: "a", port: 0 }, { name: "x", address: "a", tags: { "": "x" } }, { name: "x", address: "a", agentId: "nope" }]) {
      expect((await call("admin", "POST", "/api/v1/hosts", { body })).status, JSON.stringify(body)).toBe(422);
    }
    expect((await call("admin", "POST", "/api/v1/hosts", { body: { name: "web-1", address: "10.0.0.7" } })).status).toBe(409);
    expect((await fetch(`${app.base}/api/v1/hosts`, { method: "POST", headers: { authorization: `Bearer ${app.tokens.admin}` }, body: "nope" })).status).toBe(400);
  });

  it("are collected once the key is accepted", async () => {
    const path = "/api/v1/hosts/{id}/host-key/accept";
    expect((await call("admin", "POST", path, { concrete: hostPath(web.id, "/host-key/accept"), body: { fingerprint: fingerprint(OTHER_KEY) } })).status).toBe(422);
    expect((await call("admin", "POST", path, { concrete: hostPath(web.id, "/host-key/accept"), body: { fingerprint: fingerprint(HOST_KEY) } })).status).toBe(200);
    expect((await agent.round()).map((j) => j.action)).toEqual(["collect"]);
    // Not handed out again until it is due.
    expect(await agent.round()).toEqual([]);
    const h = (await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body as Host & { summary: Record<string, unknown> };
    expect(h).toMatchObject({ status: "ok", summary: { hostname: "web-1", os: "Debian GNU/Linux 13 (trixie)" } });
    const f = (await call("viewer", "GET", "/api/v1/hosts/{id}/facts", { concrete: hostPath(web.id, "/facts") })).body as { facts: { users: Array<{ name: string }> } };
    expect(f.facts.users.map((u) => u.name)).toContain("dana");
    expect((await call("viewer", "GET", "/api/v1/hosts")).status).toBe(200);
  });

  it("keep what changed between collections, and nothing when nothing did", async () => {
    await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") });
    await agent.round();
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}/changes", { concrete: hostPath(web.id, "/changes") })).body).toEqual({ changes: [] });
    const beforeChange = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    // Someone adds an account and a listening port on the host.
    const h = agent.hosts.get("10.0.0.5")!;
    h.facts = structuredClone(h.facts);
    h.facts.users.push({ name: "mallory", uid: 1003, gid: 1003, home: "/home/mallory", shell: "/bin/bash", login: true, password: "locked" });
    h.facts.ports!.push({ proto: "tcp", address: "0.0.0.0", port: 4444, process: "nc", pid: 999 });
    expect((await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") })).status).toBe(202);
    await agent.round();
    const { changes } = (await call("viewer", "GET", "/api/v1/hosts/{id}/changes", { concrete: hostPath(web.id, "/changes") })).body as { changes: Array<{ category: string; item: string; change: string; after: string }> };
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "user", item: "mallory", change: "added" }),
        expect.objectContaining({ category: "port", item: "tcp/0.0.0.0:4444", change: "added", after: "nc" }),
      ]),
    );
    expect(changes).toHaveLength(2);
    const all = (await call("viewer", "GET", "/api/v1/changes", { concrete: "/api/v1/changes?category=user&limit=1" })).body as { changes: Array<{ target: { name: string } }> };
    expect(all.changes[0]!.target.name).toBe("web-1");
    expect((await call("viewer", "GET", "/api/v1/changes", { concrete: "/api/v1/changes?limit=0" })).status).toBe(422);
    const users = async (q: string) => ((await call("viewer", "GET", "/api/v1/hosts/{id}/facts", { concrete: hostPath(web.id, `/facts${q}`) })).body as { facts: { users: Array<{ name: string }> } }).facts.users.map((u) => u.name);
    expect(await users(`?at=${encodeURIComponent(beforeChange)}`)).not.toContain("mallory");
    expect(await users("")).toContain("mallory");
  });

  it("stop being collected when the host key changes, until an admin accepts the new one", async () => {
    agent.hosts.get("10.0.0.5")!.key = OTHER_KEY;
    await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") });
    await agent.round();
    const h = (await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body as Host;
    expect(h).toMatchObject({ status: "host-key-changed", pendingHostKeys: [{ fingerprint: fingerprint(OTHER_KEY) }] });
    expect((await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") })).status).toBe(409);
    expect(await agent.round()).toEqual([]);
    expect((await call("admin", "POST", "/api/v1/hosts/{id}/host-key", { concrete: hostPath(web.id, "/host-key") })).status).toBe(200);
    await agent.round();
    await call("admin", "POST", "/api/v1/hosts/{id}/host-key/accept", { concrete: hostPath(web.id, "/host-key/accept"), body: { fingerprint: fingerprint(OTHER_KEY) } });
    await agent.round();
    expect(((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body as Host).status).toBe("ok");
  });

  it("show why a collection failed", async () => {
    agent.hosts.get("10.0.0.5")!.fail = { kind: "auth-failed", message: "Not allowed to log in: Permission denied (publickey)." };
    await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") });
    await agent.round();
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body).toMatchObject({ status: "auth-failed", statusDetail: expect.stringContaining("Permission denied") });
    delete agent.hosts.get("10.0.0.5")!.fail;
    await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") });
    await agent.round();
    expect(((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body as Host).status).toBe("ok");
  });

  it("take results only from their own agent, for accepted keys, in the right shape", async () => {
    const other = await app.enroll("dc-other");
    expect((await call({ secret: "oia_nope" }, "POST", "/api/v1/agent/results", { body: { jobId: "x", hostId: web.id, ok: true, hostKeys: [HOST_KEY] } })).status).toBe(401);
    expect((await other.post("/api/v1/agent/results", { jobId: "x", hostId: web.id, ok: true, facts: facts("debian-sudo") })).status).toBe(404);
    expect((await agent.post("/api/v1/agent/results", { jobId: "x", hostId: web.id, ok: true, facts: { system: {} } })).status).toBe(422);
    expect((await agent.post("/api/v1/agent/results", { jobId: "x", hostId: web.id, ok: false, error: { kind: "rm -rf", message: "x" } })).status).toBe(422);
    // A jump host must be read by the same agent.
    expect((await call("admin", "POST", "/api/v1/hosts", { body: { name: "elsewhere", address: "10.9.0.1", agentId: other.id, jumpHostId: web.id } })).status).toBe(422);
    // With two agents, the host must say which one reads it.
    expect((await call("admin", "POST", "/api/v1/hosts", { body: { name: "which", address: "10.9.0.2" } })).status).toBe(422);
    // Facts for a host whose key is not accepted are not stored.
    const pending = (await call("admin", "POST", "/api/v1/hosts", { body: { name: "pending", address: "10.9.0.3", agentId: other.id } })).body as Host;
    expect((await other.post("/api/v1/agent/results", { jobId: "x", hostId: pending.id, ok: true, facts: facts("debian-sudo") })).status).toBe(409);
    await call("admin", "DELETE", "/api/v1/hosts/{id}", { concrete: hostPath(pending.id) });
    expect((await call("admin", "DELETE", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${other.id}` })).status).toBe(204);
  });

  it("read containers only when switched on, without environment values", async () => {
    agent.hosts.set("10.0.0.8", { key: HOST_KEY, facts: facts("debian-unprivileged-containers") });
    const h = (await call("admin", "POST", "/api/v1/hosts", { body: { name: "docker-1", address: "10.0.0.8", containers: true, auth: "key" } })).body as Host;
    await agent.round();
    await call("admin", "POST", "/api/v1/hosts/{id}/host-key/accept", { concrete: hostPath(h.id, "/host-key/accept"), body: { fingerprint: fingerprint(HOST_KEY) } });
    const jobs = (await agent.round()) as unknown as Array<{ target: { containers: boolean; auth: string } }>;
    expect(jobs[0]!.target).toMatchObject({ containers: true, auth: "key" });
    const { containers } = (await call("viewer", "GET", "/api/v1/containers")).body as { containers: Array<{ name: string; envNames: string[]; host: { name: string } }> };
    expect(containers.find((c) => c.name === "fx-api")).toMatchObject({ host: { name: "docker-1" }, envNames: ["DATABASE_PASSWORD", "LOG_LEVEL", "PATH"] });
  });

  it("reach hosts through a jump host of the same agent", async () => {
    agent.hosts.set("10.1.0.9", { key: HOST_KEY, facts: facts("alpine-unprivileged") });
    const r = await call("admin", "POST", "/api/v1/hosts", { body: { name: "db-internal", address: "10.1.0.9", jumpHostId: web.id } });
    expect(r.status).toBe(201);
    const inner = r.body as Host;
    const jobs = (await agent.round()) as unknown as Array<{ jump: { address: string; hostKeys: string[] } | null }>;
    expect(jobs[0]!.jump).toMatchObject({ address: "10.0.0.5", hostKeys: [OTHER_KEY] });
    expect((await call("admin", "POST", "/api/v1/hosts", { body: { name: "deeper", address: "10.2.0.1", jumpHostId: inner.id } })).status).toBe(422);
    expect((await call("admin", "DELETE", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).status).toBe(409);
    expect((await call("admin", "DELETE", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${agent.id}` })).status).toBe(409);
    // A new address is a new machine: its key must be checked again.
    const moved = (await call("admin", "PATCH", "/api/v1/hosts/{id}", { concrete: hostPath(inner.id), body: { address: "10.1.0.10", intervalMinutes: 15 } })).body as Host;
    expect(moved.status).toBe("new");
    expect((await call("admin", "DELETE", "/api/v1/hosts/{id}", { concrete: hostPath(inner.id) })).status).toBe(204);
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(inner.id) })).status).toBe(404);
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}/facts", { concrete: hostPath(inner.id, "/facts") })).status).toBe(404);
  });
});

describe("clusters", () => {
  it("are added without returning their token, and collected", async () => {
    const token = "eyJhbGciOiJSUzI1NiIsImtpZCI6IiJ9.fixture-token-value-1234567890";
    expect((await call("admin", "POST", "/api/v1/clusters", { body: { name: "kind", server: "http://127.0.0.1:6443", token } })).status).toBe(422);
    const r = await call("admin", "POST", "/api/v1/clusters", { body: { name: "kind", server: "https://127.0.0.1:6443", token } });
    expect(r.status).toBe(201);
    const c = r.body as { id: string };
    expect(JSON.stringify(r.body)).not.toContain(token);
    expect((await call("admin", "POST", "/api/v1/clusters", { body: { name: "kind", server: "https://x:6443", token } })).status).toBe(409);
    await app.infra.tick();
    expect((await call("viewer", "GET", "/api/v1/clusters/{id}", { concrete: `/api/v1/clusters/${c.id}` })).body).toMatchObject({ status: "ok", summary: { nodes: 1 } });
    expect(JSON.stringify(app.db.prepare("SELECT * FROM clusters").all())).not.toContain(token);
    const f = (await call("viewer", "GET", "/api/v1/clusters/{id}/facts", { concrete: `/api/v1/clusters/${c.id}/facts` })).body as { workloads: Array<{ name: string }> };
    expect(f.workloads.map((w) => w.name)).toContain("web");
    app.clusters.facts.workloads = app.clusters.facts.workloads.map((w) => (w.name === "web" ? { ...w, images: ["nginx:1.28-alpine"] } : w));
    expect((await call("editor", "POST", "/api/v1/clusters/{id}/collect", { concrete: `/api/v1/clusters/${c.id}/collect` })).status).toBe(202);
    await app.infra.tick();
    const { changes } = (await call("viewer", "GET", "/api/v1/clusters/{id}/changes", { concrete: `/api/v1/clusters/${c.id}/changes` })).body as { changes: Array<{ item: string }> };
    expect(changes.map((x) => x.item)).toEqual(["Deployment default/web"]);
    expect((await call("viewer", "GET", "/api/v1/clusters")).status).toBe(200);
    expect((await call("admin", "PATCH", "/api/v1/clusters/{id}", { concrete: `/api/v1/clusters/${c.id}`, body: { intervalMinutes: 10 } })).status).toBe(200);
    expect((await call("admin", "DELETE", "/api/v1/clusters/{id}", { concrete: `/api/v1/clusters/${c.id}` })).status).toBe(204);
    expect((await call("viewer", "GET", "/api/v1/clusters/{id}/facts", { concrete: `/api/v1/clusters/${c.id}/facts` })).status).toBe(404);
  });
});

describe("product", () => {
  it("answers setup, summary, version, health and metrics", async () => {
    const setup = (await call("viewer", "GET", "/api/v1/setup")).body as { kubernetesRbac: string };
    expect(setup.kubernetesRbac).toContain("openasy-infra-read");
    expect((await call("viewer", "GET", "/api/v1/summary")).body).toMatchObject({ agents: { online: 1 }, hosts: { ok: 2 } });
    await call("none", "GET", "/api/v1/version");
    expect((await call("viewer", "GET", "/api/v1/products")).body).toEqual({ products: [] });
    await call("none", "GET", "/api/v1/products");
    await call("none", "GET", "/healthz");
    await call("none", "GET", "/readyz");
    const metrics = await call("none", "GET", "/metrics");
    expect(metrics.body).toContain('openasy_infra_hosts{status="ok"} 2');
    // Infrastructure holds no SSH private key at all.
    expect(JSON.stringify(app.db.prepare("SELECT * FROM agents").all())).not.toMatch(/PRIVATE KEY/);
  });

  it("enrols an agent again, and its old secret stops working", async () => {
    const r = await call("admin", "POST", "/api/v1/agents/{id}/enroll-token", { concrete: `/api/v1/agents/${agent.id}/enroll-token` });
    expect(r.body).toMatchObject({ enrollToken: expect.stringMatching(/^oie_/) });
    expect((await agent.post("/api/v1/agent/work", REPORT(version))).status).toBe(401);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});

describe("other products", () => {
  it("lists the configured products to anyone signed in", async () => {
    const products = [{ id: "vpn", url: "https://vpn.example.com" }];
    const linked = await startApp({ version, products });
    expect(await (await linked.viewer("/api/v1/products")).json()).toEqual({ products });
    expect((await fetch(`${linked.base}/api/v1/products`)).status).toBe(401);
    await linked.close();
  });
});

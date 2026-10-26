import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI } from "../scripts/openapi.ts";
import { parseHosts, parseInventory } from "./hosts.ts";
import { fingerprint } from "./infra.ts";
import { BMC_CERT, bmcFacts, CA_KEY, facts, HOST_KEY, OTHER_CERT, OTHER_KEY, REPORT, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response matches openapi.json and every operation is called. The scenario is
// also the behaviour test: agents, roles, host keys, collections, changes.

type Spec = typeof OPENAPI & {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
};
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
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;
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
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: enrollToken, ...REPORT(version), caPublicKey: "not a key" } })).status).toBe(
      422,
    );
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: enrollToken, ...REPORT(version) } })).status).toBe(200);
    // The token works once.
    expect((await call("none", "POST", "/api/v1/agent/enroll", { body: { token: enrollToken, ...REPORT(version) } })).status).toBe(401);
    const setup = (await call("viewer", "GET", "/api/v1/agents/{id}/setup", { concrete: `/api/v1/agents/${a.id}/setup` })).body as {
      caPublicKey: string;
      caFingerprint: string;
    };
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
    expect(((await call("viewer", "GET", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${agent.id}` })).body as { status: string }).status).toBe(
      "version-mismatch",
    );
    await agent.round();
  });
});

// Hosts come from the hosts file only (ADR 0052): the tests keep one and apply it as the product does.
const file = new Map<string, Record<string, unknown>>();

describe("hosts", () => {
  let web: Host;
  const setHost = (entry: Record<string, unknown> & { name: string }) => (file.set(entry.name, entry), apply());
  const dropHost = (name: string) => (file.delete(name), apply());
  const apply = () => app.infra.syncFile(parseHosts(JSON.stringify({ hosts: [...file.values()] })));
  const named = async (name: string) =>
    ((await call("viewer", "GET", "/api/v1/hosts")).body as { hosts: Array<Host & { name: string }> }).hosts.find((h) => h.name === name)!;

  it("come from the file and wait for their key to be checked", async () => {
    agent.hosts.set("10.0.0.5", { key: HOST_KEY, facts: facts("debian-sudo") });
    expect((await call("none", "GET", "/api/v1/hosts")).status).toBe(401);
    // No route adds or changes one.
    expect((await app.admin("/api/v1/hosts", { method: "POST", body: JSON.stringify({ name: "web-1", address: "10.0.0.5" }) })).status).toBe(404);
    expect(setHost({ name: "web-1", address: "10.0.0.5", tags: { env: "prod" } })).toEqual([]);
    web = await named("web-1");
    expect(web).toMatchObject({ status: "new", source: "file", agent: { name: "dc-main" } });
    expect((await app.admin(hostPath(web.id), { method: "PATCH", body: JSON.stringify({ port: 2200 }) })).status).toBe(404);
    expect((await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") })).status).toBe(409);
    // The agent asks the host for its key; nothing is collected before an admin accepts it.
    expect((await agent.round()).map((j) => j.action)).toEqual(["host-key"]);
    web = (await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body as Host;
    expect(web).toMatchObject({ status: "host-key-pending", pendingHostKeys: [{ fingerprint: fingerprint(HOST_KEY) }], summary: null });
    expect(await agent.round()).toEqual([]);
  });

  it("refuse a file with bad input, including values ssh could read as options", () => {
    for (const entry of [
      { name: "x", address: "-oProxyCommand=sh" },
      { name: "x", address: "10.0.0.6", user: "-oX" },
      { name: "x y", address: "a" },
      { name: "x", address: "a", port: 0 },
      { name: "x", address: "a", tags: { "": "x" } },
    ]) {
      expect(() => parseHosts(JSON.stringify({ hosts: [entry] })), JSON.stringify(entry)).toThrow();
    }
    expect(app.infra.syncFile(parseHosts(JSON.stringify({ hosts: [...file.values(), { name: "x", address: "10.0.0.6", agent: "nope" }] })))).toEqual([
      "x: no agent is named nope; it is added once one is.",
    ]);
  });

  it("are collected once the key is accepted", async () => {
    const path = "/api/v1/hosts/{id}/host-key/accept";
    expect((await call("admin", "POST", path, { concrete: hostPath(web.id, "/host-key/accept"), body: { fingerprint: fingerprint(OTHER_KEY) } })).status).toBe(
      422,
    );
    expect((await call("admin", "POST", path, { concrete: hostPath(web.id, "/host-key/accept"), body: { fingerprint: fingerprint(HOST_KEY) } })).status).toBe(
      200,
    );
    expect((await agent.round()).map((j) => j.action)).toEqual(["collect"]);
    // Not handed out again until it is due.
    expect(await agent.round()).toEqual([]);
    const h = (await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body as Host & { summary: Record<string, unknown> };
    expect(h).toMatchObject({ status: "ok", summary: { hostname: "web-1", os: "Debian GNU/Linux 13 (trixie)" } });
    const f = (await call("viewer", "GET", "/api/v1/hosts/{id}/facts", { concrete: hostPath(web.id, "/facts") })).body as {
      facts: { users: Array<{ name: string }> };
    };
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
    const { changes } = (await call("viewer", "GET", "/api/v1/hosts/{id}/changes", { concrete: hostPath(web.id, "/changes") })).body as {
      changes: Array<{ category: string; item: string; change: string; after: string }>;
    };
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "user", item: "mallory", change: "added" }),
        expect.objectContaining({ category: "port", item: "tcp/0.0.0.0:4444", change: "added", after: "nc" }),
      ]),
    );
    expect(changes).toHaveLength(2);
    const all = (await call("viewer", "GET", "/api/v1/changes", { concrete: "/api/v1/changes?category=user&limit=1" })).body as {
      changes: Array<{ target: { name: string } }>;
    };
    expect(all.changes[0]!.target.name).toBe("web-1");
    expect((await call("viewer", "GET", "/api/v1/changes", { concrete: "/api/v1/changes?limit=0" })).status).toBe(422);
    const users = async (q: string) =>
      (
        (await call("viewer", "GET", "/api/v1/hosts/{id}/facts", { concrete: hostPath(web.id, `/facts${q}`) })).body as {
          facts: { users: Array<{ name: string }> };
        }
      ).facts.users.map((u) => u.name);
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
    await call("admin", "POST", "/api/v1/hosts/{id}/host-key/accept", {
      concrete: hostPath(web.id, "/host-key/accept"),
      body: { fingerprint: fingerprint(OTHER_KEY) },
    });
    await agent.round();
    expect(((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body as Host).status).toBe("ok");
  });

  it("show why a collection failed", async () => {
    agent.hosts.get("10.0.0.5")!.fail = { kind: "auth-failed", message: "Not allowed to log in: Permission denied (publickey)." };
    await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") });
    await agent.round();
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body).toMatchObject({
      status: "auth-failed",
      statusDetail: expect.stringContaining("Permission denied"),
    });
    delete agent.hosts.get("10.0.0.5")!.fail;
    await call("editor", "POST", "/api/v1/hosts/{id}/collect", { concrete: hostPath(web.id, "/collect") });
    await agent.round();
    expect(((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).body as Host).status).toBe("ok");
  });

  it("take results only from their own agent, for accepted keys, in the right shape", async () => {
    const other = await app.enroll("dc-other");
    expect(
      (await call({ secret: "oia_nope" }, "POST", "/api/v1/agent/results", { body: { jobId: "x", hostId: web.id, ok: true, hostKeys: [HOST_KEY] } })).status,
    ).toBe(401);
    expect((await other.post("/api/v1/agent/results", { jobId: "x", hostId: web.id, ok: true, facts: facts("debian-sudo") })).status).toBe(404);
    expect((await agent.post("/api/v1/agent/results", { jobId: "x", hostId: web.id, ok: true, facts: { system: {} } })).status).toBe(422);
    expect((await agent.post("/api/v1/agent/results", { jobId: "x", hostId: web.id, ok: false, error: { kind: "rm -rf", message: "x" } })).status).toBe(422);
    // With two agents, every entry says which one reads it; web-1 is named so it stays.
    file.set("web-1", { ...file.get("web-1")!, agent: "dc-main" });
    expect(setHost({ name: "which", address: "10.9.0.2" })).toEqual(["which: name the agent that reaches it with agent:, as there are 2."]);
    // A jump host must be read by the same agent.
    expect(setHost({ name: "elsewhere", address: "10.9.0.1", agent: "dc-other", jump: "web-1" })).toContain(
      "elsewhere: its jump host web-1 is read by another agent; a jump host must be read by the same agent.",
    );
    file.delete("which");
    file.delete("elsewhere");
    // Facts for a host whose key is not accepted are not stored.
    setHost({ name: "pending", address: "10.9.0.3", agent: "dc-other" });
    const pending = await named("pending");
    expect((await other.post("/api/v1/agent/results", { jobId: "x", hostId: pending.id, ok: true, facts: facts("debian-sudo") })).status).toBe(409);
    dropHost("pending");
    expect((await call("admin", "DELETE", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${other.id}` })).status).toBe(204);
  });

  it("read containers only when switched on, without environment values", async () => {
    agent.hosts.set("10.0.0.8", { key: HOST_KEY, facts: facts("debian-unprivileged-containers") });
    setHost({ name: "docker-1", address: "10.0.0.8", containers: true, auth: "key", keyFile: "docker-1.key" });
    const h = await named("docker-1");
    await agent.round();
    await call("admin", "POST", "/api/v1/hosts/{id}/host-key/accept", {
      concrete: hostPath(h.id, "/host-key/accept"),
      body: { fingerprint: fingerprint(HOST_KEY) },
    });
    const jobs = (await agent.round()) as unknown as Array<{ target: { containers: boolean; auth: string } }>;
    expect(jobs[0]!.target).toMatchObject({ containers: true, auth: "key" });
    const { containers } = (await call("viewer", "GET", "/api/v1/containers")).body as {
      containers: Array<{ name: string; envNames: string[]; host: { name: string } }>;
    };
    expect(containers.find((c) => c.name === "fx-api")).toMatchObject({ host: { name: "docker-1" }, envNames: ["DATABASE_PASSWORD", "LOG_LEVEL", "PATH"] });
  });

  it("reach hosts through a jump host of the same agent", async () => {
    agent.hosts.set("10.1.0.9", { key: HOST_KEY, facts: facts("alpine-unprivileged") });
    expect(setHost({ name: "db-internal", address: "10.1.0.9", jump: "web-1" })).toEqual([]);
    const inner = await named("db-internal");
    const jobs = (await agent.round()) as unknown as Array<{ jump: { address: string; hostKeys: string[] } | null }>;
    expect(jobs[0]!.jump).toMatchObject({ address: "10.0.0.5", hostKeys: [OTHER_KEY] });
    expect(() => parseHosts(JSON.stringify({ hosts: [...file.values(), { name: "deeper", address: "10.2.0.1", jump: "db-internal" }] }))).toThrow(
      /a jump host must be reachable directly/,
    );
    expect((await call("admin", "DELETE", "/api/v1/hosts/{id}", { concrete: hostPath(web.id) })).status).toBe(409);
    expect((await call("admin", "DELETE", "/api/v1/agents/{id}", { concrete: `/api/v1/agents/${agent.id}` })).status).toBe(409);
    // A new address is a new machine: its key must be checked again.
    setHost({ name: "db-internal", address: "10.1.0.10", jump: "web-1" });
    expect((await named("db-internal")).status).toBe("new");
    dropHost("db-internal");
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath(inner.id) })).status).toBe(404);
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}/facts", { concrete: hostPath(inner.id, "/facts") })).status).toBe(404);
  });

  it("delete a host added here before the file, and take one over by its name", async () => {
    const legacy = (name: string, address: string) =>
      app.db
        .prepare(
          "INSERT INTO hosts (id, name, agent_id, address, port, ssh_user, auth, containers, interval_minutes, tags, created_at) VALUES (?, ?, ?, ?, 22, 'openasy', 'certificate', 0, 5, '{}', ?)",
        )
        .run(`ui-${name}`, name, agent.id, address, new Date().toISOString());
    legacy("old-1", "10.3.0.1");
    expect((await call("admin", "DELETE", "/api/v1/hosts/{id}", { concrete: hostPath("ui-old-1") })).status).toBe(204);
    expect((await call("admin", "DELETE", "/api/v1/hosts/{id}", { concrete: hostPath("ui-old-1") })).status).toBe(404);
    legacy("old-2", "10.3.0.2");
    expect(((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath("ui-old-2") })).body as { source: string }).source).toBe("ui");
    expect(setHost({ name: "old-2", address: "10.3.0.2", agent: "dc-main" })).toEqual([]);
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}", { concrete: hostPath("ui-old-2") })).body).toMatchObject({ source: "file", address: "10.3.0.2" });
    dropHost("old-2");
  });
});

describe("BMCs", () => {
  type Bmc = { id: string; status: string; statusDetail: string | null; pendingCertificate: { fingerprint: string } | null; summary: any; server: any };
  const bmcPath = (id: string, rest = "") => `/api/v1/bmcs/${id}${rest}`;
  // A BMC names its server; the file keeps both lists (ADR 0055).
  const apply = (bmcs: Array<Record<string, unknown>>) => {
    const { hosts, bmcs: list } = parseInventory(JSON.stringify({ hosts: [...file.values()], bmcs }));
    return app.infra.syncFile(hosts, list);
  };
  const entry = { name: "web-1-idrac", address: "10.0.9.5", server: "web-1", passwordFile: "web-1-bmc", tags: { rack: "r1" } };
  let bmc: Bmc;

  it("come from the file, and the password stays with the agent", async () => {
    agent.bmcs.set("10.0.9.5", { certificate: BMC_CERT, facts: bmcFacts("idrac9") });
    expect(apply([entry])).toEqual([]);
    const listed = (await call("viewer", "GET", "/api/v1/bmcs")).body as { bmcs: Array<Bmc & { passwordFile: string }> };
    expect(listed.bmcs).toMatchObject([{ name: "web-1-idrac", status: "new", passwordFile: "web-1-bmc", server: { name: "web-1" } }]);
    bmc = listed.bmcs[0]!;
    // No route adds one.
    expect((await app.admin("/api/v1/bmcs", { method: "POST", body: JSON.stringify(entry) })).status).toBe(404);
    expect((await call("editor", "POST", "/api/v1/bmcs/{id}/collect", { concrete: bmcPath(bmc.id, "/collect") })).status).toBe(409);
  });

  it("wait for their certificate to be checked, and nothing is read before", async () => {
    const jobs = await agent.round();
    const job = jobs.find((j) => j.bmcId === bmc.id) as unknown as { action: string; target: Record<string, unknown> };
    // The agent is told which file holds the password, never the password.
    expect(job).toMatchObject({
      action: "bmc-certificate",
      target: { address: "10.0.9.5", port: 443, user: "openasy", passwordFile: "web-1-bmc", certificates: [] },
    });
    bmc = (await call("viewer", "GET", "/api/v1/bmcs/{id}", { concrete: bmcPath(bmc.id) })).body as Bmc;
    expect(bmc).toMatchObject({ status: "certificate-pending", pendingCertificate: { fingerprint: BMC_CERT.fingerprint, subject: "CN=idrac-db-1" } });
    expect((await agent.round()).filter((j) => j.bmcId)).toEqual([]);
    const wrong = await call("admin", "POST", "/api/v1/bmcs/{id}/certificate/accept", {
      concrete: bmcPath(bmc.id, "/certificate/accept"),
      body: { fingerprint: OTHER_CERT.fingerprint },
    });
    expect(wrong.status).toBe(422);
    expect(
      (
        await call("editor", "POST", "/api/v1/bmcs/{id}/certificate/accept", {
          concrete: bmcPath(bmc.id, "/certificate/accept"),
          body: { fingerprint: BMC_CERT.fingerprint },
        })
      ).status,
    ).toBe(403);
    const accepted = await call("admin", "POST", "/api/v1/bmcs/{id}/certificate/accept", {
      concrete: bmcPath(bmc.id, "/certificate/accept"),
      body: { fingerprint: BMC_CERT.fingerprint.toLowerCase() },
    });
    expect(accepted.body).toMatchObject({ status: "pending", certificates: [{ fingerprint: BMC_CERT.fingerprint }], pendingCertificate: null });
  });

  it("are read: what the machine is, the health of its parts, and who may manage it", async () => {
    const collect = (await agent.round()).find((j) => j.bmcId === bmc.id) as unknown as { action: string; target: { certificates: string[] } };
    expect(collect).toMatchObject({ action: "bmc-collect", target: { certificates: [BMC_CERT.fingerprint] } });
    bmc = (await call("viewer", "GET", "/api/v1/bmcs/{id}", { concrete: bmcPath(bmc.id) })).body as Bmc;
    expect(bmc.status).toBe("ok");
    expect(bmc.summary).toMatchObject({
      vendor: "Dell",
      model: "PowerEdge R650",
      serial: "CNIVC0022B0123",
      health: "Critical",
      bmcFirmware: "6.10.30.00",
      unhealthy: 2,
      accounts: 2,
      administrators: 1,
    });
    expect(bmc.summary.services).toEqual(expect.arrayContaining(["IPMI", "SSH", "KVMIP"]));
    const f = (await call("viewer", "GET", "/api/v1/bmcs/{id}/facts", { concrete: bmcPath(bmc.id, "/facts") })).body as { facts: { events: unknown[] } };
    expect(f.facts.events).toHaveLength(3);
    // The host's page links to its BMC.
    const host = ((await call("viewer", "GET", "/api/v1/hosts")).body as { hosts: Array<{ name: string; bmc: unknown }> }).hosts.find(
      (h) => h.name === "web-1",
    )!;
    // The file names web-1, but web-1 has not said which machine it is on: nothing to compare yet.
    expect(host.bmc).toEqual({ id: bmc.id, name: "web-1-idrac", match: "unverified", health: "Critical", unhealthy: 2, powerState: "On" });
  });

  it("are matched with their host by what both say, and show its reboots next to the BMC's events", async () => {
    // web-1 with the sudo rules says its UUID and its Dell service tag, and that it booted at 16:10 UTC on October 20.
    const web = agent.hosts.get("10.0.0.5")!;
    web.facts = {
      ...web.facts,
      system: { ...web.facts.system, serial: "7XQ2R33", uuid: "4c4c4544-0058-5110-8032-b7c04f523333", bootedAt: "2026-10-20T16:10:00.000Z" },
    };
    const hostId = ((await call("viewer", "GET", "/api/v1/hosts")).body as { hosts: Array<{ id: string; name: string }> }).hosts.find(
      (h) => h.name === "web-1",
    )!.id;
    await app.editor(hostPath(hostId, "/collect"), { method: "POST" });
    await agent.round();
    bmc = (await call("viewer", "GET", "/api/v1/bmcs/{id}", { concrete: bmcPath(bmc.id) })).body as Bmc;
    expect((bmc as unknown as { match: unknown }).match).toEqual({ host: { id: hostId, name: "web-1" }, state: "confirmed", by: "uuid", detail: null });
    const hw = (await call("viewer", "GET", "/api/v1/hosts/{id}/hardware", { concrete: hostPath(hostId, "/hardware") })).body as {
      match: { state: string };
      parts: Array<{ kind: string; name: string; health: string }>;
      reboots: Array<{ at: string; events: Array<{ message: string }> }>;
    };
    expect(hw.match.state).toBe("confirmed");
    expect(hw.parts).toEqual([
      { kind: "power-supply", name: "PS2 Status", health: "Critical" },
      { kind: "drive", name: "Solid State Disk 0:1:1", health: "Warning" },
    ]);
    // The power supply that lost its input, eight minutes before the host came back up.
    expect(hw.reboots[0]).toEqual({
      at: "2026-10-20T16:10:00.000Z",
      events: [expect.objectContaining({ message: "The power input for power supply 2 is lost." })],
    });
    // A host no BMC is matched with has no hardware view.
    const other = await app.viewer(hostPath("nope", "/hardware"));
    expect(other.status).toBe(404);
    expect((await call("viewer", "GET", "/api/v1/hosts/{id}/hardware", { concrete: hostPath("nope", "/hardware") })).status).toBe(404);
  });

  it("keep what changed: firmware, a new administrator, a service turned on, a part that failed", async () => {
    const next = bmcFacts("idrac9");
    next.managers[0]!.firmware = "7.00.00.00";
    next.managers[0]!.protocols = next.managers[0]!.protocols!.map((p) => (p.name === "SNMP" ? { ...p, enabled: true } : p));
    next.accounts!.push({ user: "mallory", role: "Administrator", enabled: true, locked: false });
    next.chassis[0]!.fans[0]!.health = "Critical";
    // A reading that moves is not a change.
    next.chassis[0]!.temperatures[0]!.celsius = 71;
    agent.bmcs.set("10.0.9.5", { certificate: BMC_CERT, facts: next });
    expect((await call("editor", "POST", "/api/v1/bmcs/{id}/collect", { concrete: bmcPath(bmc.id, "/collect") })).status).toBe(202);
    await agent.round();
    const { changes } = (await call("viewer", "GET", "/api/v1/bmcs/{id}/changes", { concrete: bmcPath(bmc.id, "/changes") })).body as {
      changes: Array<{ category: string; item: string; change: string; before: string | null; after: string | null; target: { kind: string } }>;
    };
    expect(changes.map((c) => `${c.category} ${c.item} ${c.change}`).sort()).toEqual([
      "bmc-account mallory added",
      "bmc-service SNMP changed",
      "firmware BMC iDRAC.Embedded.1 changed",
      "health fan System.Embedded.1/System Board Fan1A changed",
    ]);
    expect(changes[0]!.target.kind).toBe("bmc");
    const all = (await call("viewer", "GET", "/api/v1/changes", { concrete: "/api/v1/changes?kind=bmc" })).body as {
      changes: Array<{ target: { name: string } }>;
    };
    expect(all.changes.every((c) => c.target.name === "web-1-idrac")).toBe(true);
  });

  it("stop when the BMC presents another certificate, until an admin accepts it", async () => {
    agent.bmcs.set("10.0.9.5", { certificate: OTHER_CERT, facts: bmcFacts("idrac9") });
    await call("editor", "POST", "/api/v1/bmcs/{id}/collect", { concrete: bmcPath(bmc.id, "/collect") });
    await agent.round();
    bmc = (await call("viewer", "GET", "/api/v1/bmcs/{id}", { concrete: bmcPath(bmc.id) })).body as Bmc;
    expect(bmc).toMatchObject({ status: "certificate-changed", pendingCertificate: { fingerprint: OTHER_CERT.fingerprint } });
    expect((await call("editor", "POST", "/api/v1/bmcs/{id}/collect", { concrete: bmcPath(bmc.id, "/collect") })).status).toBe(409);
    expect((await call("admin", "POST", "/api/v1/bmcs/{id}/certificate", { concrete: bmcPath(bmc.id, "/certificate") })).body).toMatchObject({ id: bmc.id });
    // A certificate the file names is trusted without an admin, and none other can be accepted here.
    apply([{ ...entry, certificate: OTHER_CERT.fingerprint.toLowerCase() }]);
    bmc = (await call("viewer", "GET", "/api/v1/bmcs/{id}", { concrete: bmcPath(bmc.id) })).body as Bmc;
    expect(bmc).toMatchObject({ status: "new", certificates: [] });
    await agent.round();
    expect((await call("viewer", "GET", "/api/v1/bmcs/{id}", { concrete: bmcPath(bmc.id) })).body).toMatchObject({
      certificates: [{ fingerprint: OTHER_CERT.fingerprint }],
      fileCertificate: OTHER_CERT.fingerprint,
    });
    const refused = await call("admin", "POST", "/api/v1/bmcs/{id}/certificate/accept", {
      concrete: bmcPath(bmc.id, "/certificate/accept"),
      body: { fingerprint: BMC_CERT.fingerprint },
    });
    expect(refused.status).toBe(409);
  });

  it("say why they cannot be read, and leave with the file", async () => {
    agent.bmcs.set("10.0.9.5", { certificate: OTHER_CERT, facts: bmcFacts("idrac9"), fail: { kind: "auth-failed", message: "the BMC refused openasy" } });
    await call("editor", "POST", "/api/v1/bmcs/{id}/collect", { concrete: bmcPath(bmc.id, "/collect") });
    await agent.round();
    expect((await call("viewer", "GET", "/api/v1/bmcs/{id}", { concrete: bmcPath(bmc.id) })).body).toMatchObject({
      status: "auth-failed",
      statusDetail: "the BMC refused openasy",
    });
    // Facts for a BMC whose certificate is not pinned are refused, even from its agent.
    apply([{ ...entry, address: "10.0.9.50" }]);
    const res = await agent.post("/api/v1/agent/results", { jobId: "x", bmcId: bmc.id, ok: true, facts: bmcFacts("idrac9") });
    expect(res.status).toBe(409);
    expect((await call("viewer", "GET", "/api/v1/bmcs/{id}/facts", { concrete: bmcPath(bmc.id, "/facts?at=2000-01-01T00:00:00Z") })).status).toBe(404);
    apply([]);
    expect((await call("viewer", "GET", "/api/v1/bmcs/{id}", { concrete: bmcPath(bmc.id) })).status).toBe(404);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE target_kind = 'bmc'").get()).toEqual({ n: 0 });
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
    expect((await call("viewer", "GET", "/api/v1/clusters/{id}", { concrete: `/api/v1/clusters/${c.id}` })).body).toMatchObject({
      status: "ok",
      summary: { nodes: 1 },
    });
    expect(JSON.stringify(app.db.prepare("SELECT * FROM clusters").all())).not.toContain(token);
    const f = (await call("viewer", "GET", "/api/v1/clusters/{id}/facts", { concrete: `/api/v1/clusters/${c.id}/facts` })).body as {
      workloads: Array<{ name: string }>;
    };
    expect(f.workloads.map((w) => w.name)).toContain("web");
    app.clusters.facts.workloads = app.clusters.facts.workloads.map((w) => (w.name === "web" ? { ...w, images: ["nginx:1.28-alpine"] } : w));
    expect((await call("editor", "POST", "/api/v1/clusters/{id}/collect", { concrete: `/api/v1/clusters/${c.id}/collect` })).status).toBe(202);
    await app.infra.tick();
    const { changes } = (await call("viewer", "GET", "/api/v1/clusters/{id}/changes", { concrete: `/api/v1/clusters/${c.id}/changes` })).body as {
      changes: Array<{ item: string }>;
    };
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
    const summary = (await call("viewer", "GET", "/api/v1/summary")).body as { changeDays: Array<Record<string, number | string>> };
    expect(summary).toMatchObject({ agents: { online: 1 }, hosts: { ok: 2 } });
    // Every change the tests above made is from today, and each is counted once by its kind.
    expect(summary.changeDays).toHaveLength(14);
    const counted = summary.changeDays.reduce((n, d) => n + Number(d.added) + Number(d.removed) + Number(d.changed), 0);
    expect(counted).toBe((app.db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n);
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

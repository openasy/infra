import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { missingHosts, parseHosts, watchHosts } from "./hosts.ts";
import { fingerprint } from "./infra.ts";
import { facts, HOST_KEY, OTHER_KEY, startApp } from "./test-app.ts";

const FIXTURE = readFileSync(new URL("./testdata/hosts.yaml", import.meta.url), "utf8");
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const json = async (res: Response) => (await res.json()) as any;

describe("the hosts file", () => {
  it("reads each server with the defaults filled in", () => {
    const list = parseHosts(FIXTURE);
    expect(list.map((h) => `${h.name} ${h.address}:${h.port} ${h.user} ${h.jump ?? "-"} ${h.agent}`)).toEqual([
      "bastion 10.0.0.2:22 openasy - dc1",
      "web-1 10.0.0.5:22 openasy bastion dc1",
      "db-1 10.0.0.6:2222 reader - dc1",
    ]);
    expect(list[1]).toMatchObject({ auth: "certificate", keyFile: null, containers: true, hostKey: fingerprint(HOST_KEY), tags: { env: "prod" } });
    expect(list[2]).toMatchObject({ auth: "key", keyFile: "db-1.key" });
    expect(parseHosts("")).toEqual([]);
  });

  it("says which entry and field to fix, and refuses values ssh could read as options", () => {
    const one = (entry: string) => () => parseHosts(`hosts:\n  - ${entry}`);
    expect(() => parseHosts("hosts: [")).toThrow(/Not valid YAML/);
    expect(() => parseHosts("endpoints: []")).toThrow(/one list, hosts:/);
    expect(one("{ address: 10.0.0.1 }")).toThrow(/hosts\[0\]\.name is required/);
    expect(one("{ name: a, address: -oProxyCommand=sh }")).toThrow(/address is required/);
    expect(one("{ name: a, address: 10.0.0.1, user: -oX }")).toThrow(/user is a Unix account/);
    expect(one("{ name: a, address: 10.0.0.1, port: 0 }")).toThrow(/port is 1 to 65535/);
    expect(one("{ name: a, address: 10.0.0.1, hostKey: 'ssh-ed25519 AAAA' }")).toThrow(/fingerprint as ssh-keygen -lf prints it/);
    expect(one("{ name: a, address: 10.0.0.1, interval: 5 }")).toThrow(/unknown interval/);
    for (const file of ["../id_rsa", "keys/id_rsa", ".id_rsa", "/etc/shadow"])
      expect(one(`{ name: a, address: 10.0.0.1, auth: key, keyFile: '${file}' }`)).toThrow(/keyFile is a file name in the agent's key folder/);
    expect(one("{ name: a, address: 10.0.0.1, keyFile: a.key }")).toThrow(/keyFile needs auth: key/);
    expect(one("{ name: a, address: 10.0.0.1, jump: nowhere }")).toThrow(/nowhere is not a host in the file/);
    expect(one("{ name: a, address: 10.0.0.1, jump: a }")).toThrow(/its own jump host/);
    expect(() => parseHosts("hosts:\n  - { name: a, address: x }\n  - { name: b, address: y, jump: a }\n  - { name: c, address: z, jump: b }")).toThrow(
      /must be reachable directly/,
    );
    expect(() => parseHosts("hosts:\n  - { name: a, address: x }\n  - { name: A, address: y }")).toThrow(/A is in the file twice/);
  });

  it("says which servers a product has nothing for, by name, full name or address", () => {
    const list = parseHosts(FIXTURE);
    expect(missingHosts(list, []).map((h) => h.name)).toEqual(["bastion", "web-1", "db-1"]);
    expect(missingHosts(list, ["WEB-1.example.com", "10.0.0.6", " "]).map((h) => h.name)).toEqual(["bastion"]);
    expect(missingHosts(list, ["10.0.0.2.example"]).map((h) => h.name)).toEqual(["bastion", "web-1", "db-1"]);
  });

  it("is read again when it changes, a bad version leaves the last good one, and warnings are tried again", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hosts-")), "hosts.yaml");
    writeFileSync(path, FIXTURE);
    let agentEnrolled = false;
    const applied: number[] = [];
    const w = watchHosts(path, (list) => (applied.push(list.length), agentEnrolled ? [] : ["web-1: no agent is named dc1"]));
    try {
      expect(w.state).toMatchObject({ entries: 3, error: null, warnings: ["web-1: no agent is named dc1"] });
      agentEnrolled = true;
      w.read(); // the same file, applied again because the last time had warnings
      expect(w.state.warnings).toEqual([]);
      w.read(); // the same file and no warnings: nothing to do
      expect(applied).toEqual([3, 3]);
      writeFileSync(path, "hosts: [");
      utimesSync(path, new Date(), new Date(Date.now() + 1000));
      w.read();
      expect(w.state).toMatchObject({ entries: 3, error: expect.stringMatching(/Not valid YAML/) });
    } finally {
      w.stop();
    }
  });
});

describe("hosts from the file", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let agent: Awaited<ReturnType<Awaited<ReturnType<typeof startApp>>["enroll"]>>;
  beforeAll(async () => {
    app = await startApp({ version });
  });
  afterAll(() => app.close());

  const hosts = async () => (await json(await app.admin("/api/v1/hosts"))).hosts as Array<Record<string, any>>;
  const host = async (name: string) => (await hosts()).find((h) => h.name === name)!;

  it("wait for their agent, by name", async () => {
    expect(app.infra.syncFile(parseHosts(FIXTURE))).toEqual([
      "bastion: no agent is named dc1; it is added once one is.",
      "web-1: no agent is named dc1; it is added once one is.",
      "db-1: no agent is named dc1; it is added once one is.",
    ]);
    expect(await hosts()).toEqual([]);
    agent = await app.enroll("dc1");
    expect(app.infra.syncFile(parseHosts(FIXTURE))).toEqual([]);
    expect((await hosts()).map((h) => `${h.name} ${h.source} ${h.agent.name} ${h.jumpHost?.name ?? "-"} ${h.fileHostKey ?? "-"}`)).toEqual([
      "bastion file dc1 - -",
      "db-1 file dc1 - -",
      `web-1 file dc1 bastion ${fingerprint(HOST_KEY)}`,
    ]);
  });

  it("trust the key the file names, and only that one", async () => {
    agent.hosts.set("10.0.0.2", { key: OTHER_KEY, facts: facts("debian-sudo") });
    agent.hosts.set("10.0.0.5", { key: HOST_KEY, facts: facts("debian-sudo") });
    agent.hosts.set("10.0.0.6", { key: OTHER_KEY, facts: facts("debian-sudo") });
    const jobs = (await agent.round()) as Array<{ target: Record<string, unknown> }>;
    // The key file is named to the agent, which reads it from its own folder; the other hosts use certificates.
    expect(jobs.map((j) => `${j.target.address} ${j.target.auth} ${j.target.keyFile ?? "-"}`).sort()).toEqual([
      "10.0.0.2 certificate -",
      "10.0.0.6 key db-1.key",
    ]);
    // No hostKey: an admin checks it, as for a host added here.
    expect(await host("bastion")).toMatchObject({ status: "host-key-pending", hostKeys: [] });
    const bastion = await host("bastion");
    expect(
      (await app.admin(`/api/v1/hosts/${bastion.id}/host-key/accept`, { method: "POST", body: JSON.stringify({ fingerprint: fingerprint(OTHER_KEY) }) }))
        .status,
    ).toBe(200);
    expect(await host("web-1")).toMatchObject({ status: "new" }); // reached through bastion, so asked once bastion is trusted
    await agent.round();
    // The file's key: trusted without an admin.
    expect(await host("web-1")).toMatchObject({ status: "pending", hostKeys: [{ fingerprint: fingerprint(HOST_KEY) }], pendingHostKeys: [] });
    // Another key than the file's: not trusted, and not acceptable here.
    app.infra.syncFile(parseHosts(FIXTURE.replace("port: 2222", `port: 2222\n    hostKey: ${fingerprint(HOST_KEY)}`)));
    await agent.round();
    const db1 = await host("db-1");
    expect(db1).toMatchObject({ status: "host-key-pending", statusDetail: expect.stringMatching(/not SHA256:.* from the hosts file/) });
    const refused = await app.admin(`/api/v1/hosts/${db1.id}/host-key/accept`, {
      method: "POST",
      body: JSON.stringify({ fingerprint: fingerprint(OTHER_KEY) }),
    });
    expect(refused.status).toBe(409);
    expect((await json(refused)).detail).toMatch(/hosts file/);
  });

  it("trust the first key when the file says first, and wait for an admin when it changes", async () => {
    app.infra.syncFile(parseHosts(FIXTURE.replace("port: 2222", "port: 2222\n    hostKey: first")));
    await agent.round();
    // db-1 presents OTHER_KEY: the first key it shows is trusted without an admin.
    expect(await host("db-1")).toMatchObject({ status: "pending", hostKeys: [{ fingerprint: fingerprint(OTHER_KEY) }], fileHostKey: null });
    agent.hosts.set("10.0.0.6", { key: HOST_KEY, facts: facts("debian-sudo") });
    const db1 = await host("db-1");
    await app.admin(`/api/v1/hosts/${db1.id}/host-key`, { method: "POST" });
    await agent.round();
    // Another key later is not trusted by itself; an admin may accept it, since the file names none.
    expect(await host("db-1")).toMatchObject({ status: "host-key-changed", pendingHostKeys: [{ fingerprint: fingerprint(HOST_KEY) }] });
    const accepted = await app.admin(`/api/v1/hosts/${db1.id}/host-key/accept`, {
      method: "POST",
      body: JSON.stringify({ fingerprint: fingerprint(HOST_KEY) }),
    });
    expect(accepted.status).toBe(200);
    expect(parseHosts("hosts:\n  - { name: a, address: 10.0.0.1, hostKey: first }")[0]).toMatchObject({ hostKey: "first" });
  });

  it("are changed in the file only", async () => {
    const web = await host("web-1");
    expect((await app.admin(`/api/v1/hosts/${web.id}`, { method: "PATCH", body: JSON.stringify({ port: 2200 }) })).status).toBe(404);
    expect((await app.admin(`/api/v1/hosts/${web.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await app.admin(`/api/v1/hosts/${web.id}/host-key`, { method: "POST" })).status).toBe(200);
  });

  it("follow the file: a new address is checked again, a removed host goes, and one added here before is taken over", async () => {
    app.db
      .prepare(
        "INSERT INTO hosts (id, name, agent_id, address, port, ssh_user, auth, containers, interval_minutes, tags, created_at) VALUES ('ui-mail', 'mail-1', ?, '10.0.0.9', 22, 'openasy', 'certificate', 0, 5, '{}', ?)",
      )
      .run(agent.id, new Date().toISOString());
    const warnings = app.infra.syncFile(
      parseHosts(
        "hosts:\n  - { name: web-1, address: 10.0.0.15, agent: dc1, hostKey: 'SHA256:PDOhaQiW49e9hQXf81r2bgjWlUS0+xzcwzCeUeVWhZo' }\n  - { name: mail-1, address: 10.0.0.9, agent: dc1 }\n",
      ),
    );
    expect(warnings).toEqual([]);
    expect((await hosts()).map((h) => `${h.name} ${h.source}`)).toEqual(["mail-1 file", "web-1 file"]);
    expect(await host("mail-1")).toMatchObject({ id: "ui-mail" });
    expect(await host("web-1")).toMatchObject({ address: "10.0.0.15", jumpHost: null, status: "new", hostKeys: [] });
  });

  it("need their jump host read by the same agent", async () => {
    await app.enroll("dc2");
    const warnings = app.infra.syncFile(
      parseHosts(
        "hosts:\n  - { name: gate, address: 10.1.0.1, agent: dc2 }\n  - { name: app-1, address: 10.1.0.2, agent: dc1, jump: gate }\n  - { name: app-2, address: 10.1.0.3, jump: gate }\n",
      ),
    );
    expect(warnings).toEqual([
      "app-2: name the agent that reaches it with agent:, as there are 2.",
      "app-1: its jump host gate is read by another agent; a jump host must be read by the same agent.",
    ]);
    expect((await hosts()).filter((h) => h.source === "file").map((h) => h.name)).toEqual(["gate"]);
  });
});

describe("the summary", () => {
  it("says where the file stands, or null without one", async () => {
    const without = await startApp({ version });
    const state = { path: "/config/hosts.yaml", appliedAt: null, entries: 0, error: "Not valid YAML: x", warnings: [] };
    const withFile = await startApp({ version, hostsFile: () => state });
    try {
      expect((await json(await without.admin("/api/v1/summary"))).hostsFile).toBeNull();
      expect((await json(await withFile.admin("/api/v1/summary"))).hostsFile).toEqual(state);
    } finally {
      await without.close();
      await withFile.close();
    }
  });
});

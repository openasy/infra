import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diff, hostItems } from "./changes.ts";
import { checkFacts } from "./facts.ts";
import { fingerprint } from "./infra.ts";
import { createKeyring } from "./kek.ts";
import { clusterItems, RBAC, type ClusterFacts } from "./k8s.ts";
import { facts, fixture } from "./test-app.ts";

describe("facts from an agent", () => {
  it("are checked before they are stored", () => {
    expect(checkFacts(facts("debian-sudo")).system.hostname).toBe("web-1");
    expect(() => checkFacts({ ...facts("debian-sudo"), packages: "all" })).toThrow(/packages/);
    expect(() => checkFacts({ system: {} })).toThrow();
    expect(() => checkFacts(null)).toThrow();
  });
});

describe("changes", () => {
  it("finds added, removed and changed items, and nothing for values that move", () => {
    const a = facts("debian-sudo");
    const b = structuredClone(a);
    b.system.load = [9, 9, 9];
    b.memory.availableKb = 1;
    b.processes = b.processes.map((p) => ({ ...p, cpu: p.cpu + 50, pid: p.pid + 1 }));
    expect(diff(hostItems(a), hostItems(b))).toEqual([]);

    const bash = a.packages.find((p) => p.name === "bash")!;
    b.packages = b.packages.map((p) => (p.name === "bash" ? { ...p, version: "5.3-9" } : p)).filter((p) => p.name !== "cron");
    b.users.push({ name: "deploy", uid: 1002, gid: 1002, home: "/home/deploy", shell: "/bin/bash", login: true, password: "set" });
    b.ports!.push({ proto: "tcp", address: "0.0.0.0", port: 8081, process: "nc", pid: 4242 });
    const changes = diff(hostItems(a), hostItems(b));
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "package", key: `dpkg:bash:${bash.arch}`, kind: "changed", before: bash.version, after: "5.3-9" }),
        expect.objectContaining({ category: "package", kind: "removed", key: expect.stringMatching(/^dpkg:cron:/) }),
        expect.objectContaining({ category: "user", key: "deploy", kind: "added" }),
        expect.objectContaining({ category: "port", key: "tcp/0.0.0.0:8081", kind: "added", after: "nc" }),
      ]),
    );
    expect(changes).toHaveLength(4);
  });

  it("shows a reboot, not every uptime", () => {
    const a = facts("debian-sudo");
    const later = { ...a, system: { ...a.system, uptimeSec: a.system.uptimeSec + 300 } };
    expect(diff(hostItems(a), hostItems(later))).toEqual([]);
    const rebooted = { ...a, system: { ...a.system, bootedAt: new Date(Date.parse(a.system.bootedAt) + 86_400_000).toISOString() } };
    expect(diff(hostItems(a), hostItems(rebooted))).toEqual([expect.objectContaining({ category: "system", key: "booted", kind: "changed" })]);
  });

  it("tracks workloads, not pods, in clusters", () => {
    const a = JSON.parse(fixture("kind-cluster.json")) as ClusterFacts;
    const b = structuredClone(a);
    b.pods = b.pods.map((p) => ({ ...p, name: `${p.name}-x`, restarts: p.restarts + 3 }));
    expect(diff(clusterItems(a), clusterItems(b))).toEqual([]);
    b.workloads = b.workloads.map((w) => (w.name === "web" ? { ...w, images: ["nginx:1.28-alpine"] } : w));
    expect(diff(clusterItems(a), clusterItems(b))).toEqual([expect.objectContaining({ category: "container", key: "Deployment default/web", kind: "changed" })]);
  });
});

describe("secrets and keys", () => {
  it("seals each secret with its own data key", () => {
    const k = createKeyring(randomBytes(32));
    const a = k.seal("ca private key");
    const b = k.seal("ca private key");
    expect(a).not.toBe(b);
    expect(k.open(a).toString()).toBe("ca private key");
    expect(() => createKeyring(randomBytes(32)).open(a)).toThrow();
    expect(() => k.open(a.slice(0, -4) + "AAAA")).toThrow();
  });

  it("prints fingerprints as OpenSSH does", () => {
    const dir = mkdtempSync(join(tmpdir(), "fp-"));
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "k")]);
    const pub = readFileSync(join(dir, "k.pub"), "utf8");
    expect(fingerprint(pub)).toBe(execFileSync("ssh-keygen", ["-lf", join(dir, "k.pub")], { encoding: "utf8" }).split(" ")[1]);
  });


  it("gives the cluster role no Secrets, ConfigMaps or write verbs", () => {
    const rules = RBAC.split("rules:")[1]!.split("---")[0]!;
    expect(rules).not.toMatch(/secrets|configmaps|create|update|patch|delete|\*/);
  });
});

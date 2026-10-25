import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import type { Facts } from "./facts.ts";
import { facts } from "./test-app.ts";
import { createVulnsLink, hostSbom } from "./vulns.ts";

const purls = (sbom: ReturnType<typeof hostSbom>) => sbom.components.map((c) => ("purl" in c ? c.purl : null)).filter(Boolean);

describe("a host's packages as CycloneDX", () => {
  it("names the distribution and the source package, as Grype needs to match them", () => {
    const sbom = hostSbom("web-1", facts("debian-sudo"), "1.0.0");
    expect(sbom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.6", metadata: { component: { type: "device", name: "web-1" } } });
    expect(sbom.components[0]).toMatchObject({ type: "operating-system", name: "debian", version: "13" });
    const p = purls(sbom);
    expect(p).toContain("pkg:deb/debian/bsdutils@1:2.41.5-0%2Bdeb13u1?arch=arm64&distro=debian-13&upstream=util-linux%402.41.5-0%2Bdeb13u1");
    // A binary rebuild names its source's version; a package that is its own source says nothing more.
    expect(p).toContain("pkg:deb/debian/bash@5.2.37-2%2Bb10?arch=arm64&distro=debian-13&upstream=bash%405.2.37-2");
    expect(p.find((x) => x!.startsWith("pkg:deb/debian/adduser@"))).not.toContain("upstream");
    expect(sbom.components).toHaveLength(facts("debian-sudo").packages.length + 1);
  });

  it("writes rpm's epoch and src.rpm, and apk's origin", () => {
    const base = facts("debian-sudo");
    const rocky: Facts = {
      ...base,
      system: { ...base.system, os: { id: "rocky", name: "Rocky Linux 9.3", version: "9.3" } },
      packages: [{ manager: "rpm", name: "openssl-libs", version: "3.0.7-24.el9", arch: "aarch64", epoch: 1, source: "openssl-3.0.7-24.el9.src.rpm" }],
    };
    expect(purls(hostSbom("db-1", rocky, "1.0.0"))).toEqual([
      "pkg:rpm/rocky/openssl-libs@3.0.7-24.el9?arch=aarch64&distro=rocky-9.3&epoch=1&upstream=openssl-3.0.7-24.el9.src.rpm",
    ]);
    const alpine = facts("alpine-unprivileged");
    expect(purls(hostSbom("edge", alpine, "1.0.0"))).toContain(
      `pkg:apk/alpine/alpine-baselayout-data@3.7.0-r0?arch=aarch64&distro=alpine-${alpine.system.os.version}&upstream=alpine-baselayout`,
    );
  });

  it("reads facts from an older agent, which sends no source", () => {
    const old = facts("debian-sudo");
    old.packages = old.packages.map(({ manager, name, version, arch }) => ({ manager, name, version, arch }));
    expect(purls(hostSbom("web-1", old, "1.0.0")).every((p) => !p!.includes("upstream"))).toBe(true);
  });
});

function setup(answer: (n: number) => Response) {
  const db = openDb(":memory:");
  db.exec("INSERT INTO agents (id, name, created_at) VALUES ('a', 'agent', 'now')");
  const add = (id: string, name: string, f: Facts) =>
    db
      .prepare("INSERT INTO hosts (id, name, agent_id, address, auth, latest_facts, created_at) VALUES (?, ?, 'a', '10.0.0.1', 'certificate', ?, 'now')")
      .run(id, name, gzipSync(JSON.stringify(f)));
  const sent: Array<{ url: string; authorization: string; body: ReturnType<typeof hostSbom> }> = [];
  let clock = Date.parse("2026-10-25T10:00:00Z");
  const logs: string[] = [];
  const link = createVulnsLink({
    db,
    url: "http://vulns:8080/",
    token: "ingest-token",
    version: "1.0.0",
    log: (_l, msg) => logs.push(msg),
    now: () => clock,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, authorization: (init.headers as Record<string, string>).authorization!, body: JSON.parse(init.body as string) });
      return answer(sent.length);
    }) as typeof fetch,
  });
  return { db, link, add, sent, logs, tick: (ms: number) => (clock += ms) };
}

const ok = () => new Response(JSON.stringify({ id: "asset-1", kind: "host", name: "web-1" }), { status: 202 });

describe("sending packages to Vulnerabilities", () => {
  it("sends a host when its packages change, and once a day when they do not", async () => {
    const { link, add, sent, tick } = setup(ok);
    const f = facts("debian-sudo");
    add("h1", "web-1", f);
    link.collected("h1", f);
    await link.deliver();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("http://vulns:8080/api/v1/sboms?kind=host&name=web-1");
    expect(sent[0]!.authorization).toBe("Bearer ingest-token");
    expect(link.state("h1")).toEqual({ sentAt: "2026-10-25T10:00:00.000Z", error: null, assetId: "asset-1" });

    // Collected again with the same packages: nothing to send until a day has passed.
    link.collected("h1", { ...f, collectedAt: "2026-10-25T10:05:00Z", system: { ...f.system, uptimeSec: 999 } });
    await link.deliver();
    expect(sent).toHaveLength(1);
    tick(24 * 3_600_000);
    link.collected("h1", f);
    await link.deliver();
    expect(sent).toHaveLength(2);

    link.collected("h1", { ...f, packages: f.packages.slice(1) });
    await link.deliver();
    expect(sent).toHaveLength(3);
  });

  it("keeps why a send failed, waits before trying again, and says what to fix", async () => {
    const { link, add, sent, logs, tick } = setup((n) => (n === 1 ? new Response(JSON.stringify({ detail: "no" }), { status: 401 }) : ok()));
    const f = facts("alpine-unprivileged");
    add("h1", "edge", f);
    link.collected("h1", f);
    await link.deliver();
    expect(link.state("h1")).toEqual({
      sentAt: null,
      error: "Vulnerabilities refused the token: set INFRA_VULNS_TOKEN to its VULNS_INGEST_TOKEN.",
      assetId: null,
    });
    expect(logs).toContain("packages not sent to Vulnerabilities; trying again in a few minutes");
    await link.deliver();
    expect(sent).toHaveLength(1);
    tick(5 * 60_000);
    await link.deliver();
    expect(sent).toHaveLength(2);
    expect(link.state("h1")).toMatchObject({ error: null, assetId: "asset-1" });
  });

  it("forgets a host that is removed", async () => {
    const { db, link, add } = setup(ok);
    const f = facts("debian-sudo");
    add("h1", "web-1", f);
    link.collected("h1", f);
    db.exec("DELETE FROM hosts");
    await link.deliver();
    expect(link.state("h1")).toBeNull();
  });
});

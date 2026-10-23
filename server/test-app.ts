// Starts the app on a random port for tests, with a stand-in for infra-agent that speaks the real protocol over
// HTTP and answers from facts infra-agent parsed on real hosts (server/fixtures). e2e/run.sh uses the real agent.
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { openDb } from "./db.ts";
import type { Facts } from "./facts.ts";
import { createInfra } from "./infra.ts";
import { createKeyring } from "./kek.ts";
import type { ClusterFacts } from "./k8s.ts";

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
export const facts = (name: string) => JSON.parse(fixture(`${name}.json`)) as Facts;
export const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFmXq7hWQvK1eF4s3n0q6X8b9mZ2nqJ8V7cJq3s1kR2x";
export const OTHER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC9w3m0yQ1L7r2hY8kP4oX6n5aB1cD2eF3gH4iJ5kL6m";
export const CA_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl OpenAsy Infrastructure CA";
export const PASSWORD = "correct horse battery staple";

/** What each fake host answers; tests change it to make something happen on the host. */
export interface FakeHost {
  key: string;
  facts: Facts;
  fail?: { kind: string; message: string };
}

export const REPORT = (version: string) => ({
  version,
  caPublicKey: CA_KEY,
  keyPublicKey: HOST_KEY.replace("Fm", "Hm"),
  setup: {
    sshdConfig: "TrustedUserCAKeys /etc/ssh/openasy_ca.pub\n",
    sudoers: "Cmnd_Alias OPENASY_READ = /usr/bin/ss -H -tulnp\n",
    hostSetup: "useradd openasy\n",
    authorizedKey: "restrict ssh-ed25519 AAAA",
  },
  running: 0,
});

export async function startApp(opts: Partial<AppOptions> & { version: string }) {
  const db = openDb(":memory:");
  const clusters = { facts: JSON.parse(fixture("kind-cluster.json")) as ClusterFacts, fail: undefined as Error | undefined };
  const infra = createInfra(db, createKeyring(randomBytes(32)), {
    version: opts.version,
    async collectCluster() {
      if (clusters.fail) throw clusters.fail;
      return structuredClone(clusters.facts);
    },
  });
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "infra", productName: "OpenAsy Infrastructure", origin: base });
  handler = createApp({ db, infra, auth, ...opts });

  // The owner, signed in with a second factor, and an API token for each role.
  const jar = new Map<string, string>();
  const browser = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        origin: base,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  };
  const setup = new URL(auth.setupLink()!).searchParams.get("setup");
  await browser("/api/v1/auth/setup", { body: { token: setup, name: "Olivia", email: "owner@example.com", password: PASSWORD } });
  const { secret } = (await (await browser("/api/v1/auth/me/totp", { body: {} })).json()) as { secret: string };
  await browser("/api/v1/auth/me/totp/confirm", { body: { code: totp(secret) } });
  const token = async (role: string) => ((await (await browser("/api/v1/auth/tokens", { body: { name: role, role } })).json()) as { token: string }).token;
  const tokens = { admin: await token("admin"), editor: await token("editor"), viewer: await token("viewer") };
  const as =
    (role: keyof typeof tokens) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${tokens[role]}`, "content-type": "application/json", ...init.headers } });

  /** A stand-in infra-agent: enrols with the token, then each round asks for jobs and answers them. */
  const fakeAgent = (agentSecret: string) => {
    const hosts = new Map<string, FakeHost>();
    const post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: { authorization: `Bearer ${agentSecret}`, "content-type": "application/json", "content-encoding": "gzip" },
        body: gzipSync(JSON.stringify(body)),
      });
    return {
      hosts,
      async round() {
        const { jobs } = (await (await post("/api/v1/agent/work", REPORT(opts.version))).json()) as {
          jobs: Array<{ id: string; hostId: string; action: string; target: { address: string; hostKeys: string[] } }>;
        };
        for (const j of jobs) {
          const h = hosts.get(j.target.address);
          const base = { jobId: j.id, hostId: j.hostId };
          if (!h)
            await post("/api/v1/agent/results", {
              ...base,
              ok: false,
              error: { kind: "unreachable", message: `ssh: connect to host ${j.target.address} port 22: Connection refused` },
            });
          else if (j.action === "host-key") await post("/api/v1/agent/results", { ...base, ok: true, hostKeys: [h.key] });
          else if (h.fail) await post("/api/v1/agent/results", { ...base, ok: false, error: h.fail });
          else if (!j.target.hostKeys.includes(h.key))
            await post("/api/v1/agent/results", { ...base, ok: false, error: { kind: "host-key-changed", message: "changed" }, hostKeys: [h.key] });
          else await post("/api/v1/agent/results", { ...base, ok: true, facts: h.facts });
        }
        return jobs;
      },
      post,
    };
  };
  const enroll = async (name: string) => {
    const created = (await (await as("admin")("/api/v1/agents", { method: "POST", body: JSON.stringify({ name }) })).json()) as {
      agent: { id: string };
      enrollToken: string;
    };
    const r = (await (
      await fetch(`${base}/api/v1/agent/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: created.enrollToken, ...REPORT(opts.version) }),
      })
    ).json()) as { secret: string };
    return { id: created.agent.id, ...fakeAgent(r.secret) };
  };

  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, infra, clusters, base, tokens, enroll, admin: as("admin"), editor: as("editor"), viewer: as("viewer"), close };
}

function totp(secret: string) {
  const bits = [...secret].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

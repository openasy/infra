// End-to-end (ADR 0029): the infra and infra-agent images against real sshd hosts, a jump host, a fixed-key host,
// Docker and a kind cluster. Nothing is faked. Run it with e2e/run.sh, which builds the images; KIND_CLUSTER names an existing kind
// cluster to read (skipped when unset).
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = process.env.INFRA_IMAGE ?? "infra:dev";
const AGENT_IMAGE = process.env.AGENT_IMAGE ?? "infra-agent:dev";
const TARGET = process.env.TARGET_IMAGE ?? "openasy-infra-target:dev";
const BASE = "http://localhost:18095";
const PASSWORD = "correct horse battery staple";
const sh = (cmd: string, args: string[], opts: { input?: string } = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", input: opts.input, stdio: ["pipe", "pipe", "pipe"] }).trim();
const docker = (...args: string[]) => sh("docker", args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond: unknown, what: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};

function cleanup() {
  const quiet = (args: string[]) => {
    try {
      execFileSync("docker", args, { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  };
  for (const c of ["e2e-infra", "e2e-agent", "e2e-web", "e2e-jump", "e2e-db", "e2e-key"]) quiet(["rm", "-f", c]);
  for (const n of ["e2e-infra-pub", "e2e-infra-int"]) quiet(["network", "rm", n]);
}

function totp(secret: string) {
  const bits = [...secret].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

cleanup();
try {
  docker("network", "create", "e2e-infra-pub");
  docker("network", "create", "--internal", "e2e-infra-int");
  const dir = mkdtempSync(join(tmpdir(), "e2e-infra-"));
  writeFileSync(join(dir, "kek"), randomBytes(32).toString("hex"));
  writeFileSync(join(dir, "agent-kek"), randomBytes(32).toString("hex"));
  // The hosts come from the install's hosts file only (ADR 0052): a folder the product reads, as compose mounts it.
  const inventory = join(dir, "inventory");
  mkdirSync(inventory);
  chmodSync(inventory, 0o755);
  const hostsFile = join(inventory, "hosts.yaml");
  const writeHosts = (hosts: Array<Record<string, unknown>>) => (writeFileSync(hostsFile, JSON.stringify({ hosts })), chmodSync(hostsFile, 0o644));
  writeHosts([]);

  // Like compose: read-only root, tmpfs for the per-connection keys, the KEK as a mounted file.
  docker(
    "run",
    "-d",
    "--name",
    "e2e-infra",
    "--network",
    "e2e-infra-pub",
    "-p",
    "127.0.0.1:18095:8080",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${join(dir, "kek")}:/run/secrets/openasy-kek:ro`,
    "-v",
    `${inventory}:/config/inventory:ro`,
    "-e",
    "OPENASY_HOSTS=/config/inventory/hosts.yaml",
    "-e",
    "INFRA_PUBLIC_URL=http://localhost:18095",
    IMAGE,
  );
  if (process.env.KIND_CLUSTER) docker("network", "connect", "kind", "e2e-infra");
  for (let i = 0; i < 60; i++) {
    if (
      await fetch(`${BASE}/readyz`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await sleep(500);
  }
  await sleep(1000);

  // The owner from the one-time link in the log, with an authenticator app, then an admin API token.
  const link = /"url":"([^"]+)"/.exec(
    docker("logs", "e2e-infra")
      .split("\n")
      .find((l) => l.includes("no owner yet")) ?? "",
  )?.[1];
  ok(link, "the first start prints a one-time owner link");
  const jar = new Map<string, string>();
  const browser = async (path: string, body?: unknown) => {
    const res = await fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) jar.set(c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1, c.indexOf(";")));
    return res;
  };
  await browser("/api/v1/auth/setup", { token: new URL(link!).searchParams.get("setup"), name: "E2E", email: "e2e@example.com", password: PASSWORD });
  const { secret } = (await (await browser("/api/v1/auth/me/totp", {})).json()) as { secret: string };
  await browser("/api/v1/auth/me/totp/confirm", { code: totp(secret) });
  const { token } = (await (await browser("/api/v1/auth/tokens", { name: "e2e", role: "admin" })).json()) as { token: string };
  const api = async <T = any>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<{ status: number; body: T }> => {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as T };
  };

  // The agent: added in Infrastructure, started with its one-time token, like compose and Settings, Agents say.
  const created = (await api<{ agent: { id: string }; enrollToken: string }>("/api/v1/agents", { name: "e2e" })).body;
  docker(
    "run",
    "-d",
    "--name",
    "e2e-agent",
    "--network",
    "e2e-infra-pub",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${join(dir, "agent-kek")}:/run/secrets/openasy-agent-kek:ro`,
    "-e",
    "INFRA_URL=http://e2e-infra:8080",
    "-e",
    `INFRA_ENROLL_TOKEN=${created.enrollToken}`,
    "-e",
    "POLL_SECONDS=2",
    AGENT_IMAGE,
  );
  let agentStatus = "";
  for (let i = 0; i < 30 && agentStatus !== "online"; i++) {
    await sleep(1000);
    agentStatus = (await api<{ status: string }>(`/api/v1/agents/${created.agent.id}`)).body.status;
  }
  ok(agentStatus === "online", `the agent enrolled with its one-time token and asks for work (${agentStatus})`);

  // Hosts, prepared the way Setup says for this agent.
  const setup = (await api<{ caPublicKey: string; sudoers: string; authorizedKey: string }>(`/api/v1/agents/${created.agent.id}/setup`)).body;
  ok(setup.caPublicKey?.startsWith("ssh-ed25519 "), "Setup shows the agent's CA");
  const target = (name: string, net: string, env: string[], extra: string[] = []) =>
    docker("run", "-d", "--name", name, "--hostname", name.replace("e2e-", ""), "--network", net, ...env.flatMap((e) => ["-e", e]), ...extra, TARGET);
  target(
    "e2e-web",
    "e2e-infra-pub",
    [`OPENASY_CA=${setup.caPublicKey}`, `OPENASY_SUDOERS=${setup.sudoers}`, "OPENASY_DOCKER=1"],
    ["-v", "/var/run/docker.sock:/var/run/docker.sock"],
  );
  target("e2e-jump", "e2e-infra-pub", [`OPENASY_CA=${setup.caPublicKey}`, "OPENASY_JUMP=1"]);
  docker("network", "connect", "e2e-infra-int", "e2e-jump");
  target("e2e-db", "e2e-infra-int", [`OPENASY_CA=${setup.caPublicKey}`]);
  target("e2e-key", "e2e-infra-pub", ["OPENASY_CA=", `OPENASY_KEY=${setup.authorizedKey}`]);
  await sleep(2500);

  const keyOf = (c: string) => docker("exec", c, "ssh-keygen", "-lf", "/etc/ssh/ssh_host_ed25519_key.pub").split(" ")[1];
  // Every host in the file at once; Infrastructure reads it within a minute of a change.
  const entries: Array<Record<string, unknown>> = [
    { name: "web", address: "e2e-web", containers: true },
    { name: "jump", address: "e2e-jump" },
    { name: "db", address: "e2e-db", jump: "jump" },
    { name: "key", address: "e2e-key", auth: "key" },
  ];
  writeHosts(entries);
  type Listed = { id: string; name: string; user: string; source: string; pendingHostKeys: Array<{ fingerprint: string }> };
  const listed = async (name: string, until: (h: Listed) => boolean = () => true) => {
    for (let i = 0; i < 90; i++) {
      const h = (await api<{ hosts: Listed[] }>("/api/v1/hosts")).body.hosts.find((x) => x.name === name);
      if (h && until(h)) return h;
      await sleep(1000);
    }
    return undefined;
  };
  const accept = async (name: string, container: string) => {
    // The agent asks the host for its key on its next round; a host behind a jump host once that one is trusted.
    const h = await listed(name, (x) => x.pendingHostKeys.length > 0);
    ok(
      h?.source === "file" && h.pendingHostKeys[0]?.fingerprint === keyOf(container),
      `${name}: from the file, and the pending key is the one ssh-keygen prints on the host`,
    );
    await api(`/api/v1/hosts/${h?.id}/host-key/accept`, { fingerprint: h?.pendingHostKeys[0]?.fingerprint });
    return h?.id ?? "";
  };
  const web = await accept("web", "e2e-web");
  const jump = await accept("jump", "e2e-jump");
  const db = await accept("db", "e2e-db");
  const key = await accept("key", "e2e-key");

  const waitFor = async (id: string, status: string, since?: string) => {
    for (let i = 0; i < 40; i++) {
      // A collection sets lastAttemptAt when it starts; lastSuccessAt says it finished.
      const h = (await api<{ status: string; statusDetail: string | null; lastAttemptAt: string | null; lastSuccessAt: string | null }>(`/api/v1/hosts/${id}`))
        .body;
      const at = status === "ok" ? h.lastSuccessAt : h.lastAttemptAt;
      if (h.status === status && (!since || (at ?? "") > since)) return h;
      await sleep(1000);
    }
    return (await api<{ status: string; statusDetail: string | null }>(`/api/v1/hosts/${id}`)).body;
  };
  for (const [name, id] of [
    ["web", web],
    ["jump", jump],
    ["db through the jump host", db],
    ["key", key],
  ] as const) {
    const h = await waitFor(id, "ok");
    ok(h.status === "ok", `${name} collected (${h.status}${h.statusDetail ? `: ${h.statusDetail}` : ""})`);
  }

  const facts = async (id: string) => (await api<{ facts: any }>(`/api/v1/hosts/${id}/facts`)).body.facts;
  const wf = await facts(web);
  ok(wf.system.hostname === "web" && wf.account.user === "openasy" && wf.account.sudo === "rules", "web: read as openasy with the read-only sudo rules only");
  ok(
    wf.authorizedKeys?.some((k: { user: string }) => k.user === "dana"),
    "web: the sudo rules read SSH keys that may log in",
  );
  ok(
    wf.ports?.some((p: { port: number; process: string }) => p.port === 8088 && p.process === "python3"),
    "web: listening port 8088 belongs to python3",
  );
  ok(
    wf.containers?.some((c: { name: string }) => c.name === "e2e-web"),
    "web: containers through the Docker socket",
  );
  ok(!JSON.stringify(wf).includes(setup.sudoers.slice(40, 80)), "web: container environment values are not collected");
  const df = await facts(db);
  ok(
    df.system.hostname === "db" && df.authorizedKeys === null && df.unreadable.includes("SSH keys that may log in"),
    "db: reached through the jump host, and says what it cannot read without sudo rules",
  );
  ok((await facts(key)).system.hostname === "key", "key: read with the fixed key");

  // Something changes on the host.
  const before = new Date().toISOString();
  docker("exec", "e2e-web", "useradd", "--create-home", "--shell", "/bin/bash", "mallory");
  docker("exec", "-d", "e2e-web", "python3", "-m", "http.server", "4444");
  await sleep(500);
  await api(`/api/v1/hosts/${web}/collect`, {});
  await waitFor(web, "ok", before);
  const changes = (await api<{ changes: Array<{ category: string; item: string; change: string }> }>(`/api/v1/hosts/${web}/changes`)).body.changes;
  ok(
    changes.some((c) => c.category === "user" && c.item === "mallory" && c.change === "added"),
    "web: the new account mallory is a change",
  );
  ok(
    changes.some((c) => c.category === "port" && c.item.endsWith(":4444") && c.change === "added"),
    "web: the new listening port 4444 is a change",
  );

  // The host is replaced: a new host key stops collection until an admin accepts it.
  docker("rm", "-f", "e2e-key");
  target("e2e-key", "e2e-infra-pub", ["OPENASY_CA=", `OPENASY_KEY=${setup.authorizedKey}`]);
  docker("exec", "e2e-key", "sh", "-c", "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && kill -HUP 1");
  await sleep(1500);
  const changedAt = new Date().toISOString();
  await api(`/api/v1/hosts/${key}/collect`, {});
  const k = await waitFor(key, "host-key-changed", changedAt);
  ok(k.status === "host-key-changed", "key: a new host key stops collection");
  ok((await api(`/api/v1/hosts/${key}/collect`, {})).status === 409, "key: no collection until the new key is accepted");

  // The sudo rules allow exactly the read-only commands and nothing else.
  const attack = sh("docker", ["exec", "-i", "e2e-web", "sh", "-c", "cat > /tmp/a.sh && sh /tmp/a.sh"], {
    input: (await import("node:fs")).readFileSync(new URL("./sudoers-test.sh", import.meta.url), "utf8"),
  });
  const refusedSection = attack.split("== must be refused")[1] ?? "";
  ok(refusedSection.includes("refused") && !refusedSection.includes("ALLOWED"), "web: every escape from the sudo rules is refused");
  ok(
    !attack
      .split("== must be refused")[0]!
      .split("\n")
      .some((l) => l.startsWith("refused") && !l.includes("iptables-save")),
    "web: every read-only command is allowed",
  );

  // What a compromised Infrastructure can do: tell the agent to log in as root. The certificate is for openasy only.
  writeHosts(entries.map((e) => (e.name === "web" ? { ...e, user: "root" } : e)));
  await listed("web", (h) => h.user === "root");
  const asRoot = new Date().toISOString();
  await api(`/api/v1/hosts/${web}/collect`, {});
  const r = await waitFor(web, "auth-failed", asRoot);
  ok(r.status === "auth-failed", "web: told to log in as root, the agent's certificate is refused");
  writeHosts(entries);
  await listed("web", (h) => h.user === "openasy");

  // Nothing of a connection stays behind, and no SSH private key is anywhere but sealed on the agent.
  ok(docker("exec", "e2e-agent", "sh", "-c", "ls -A /tmp | wc -l") === "0", "agent: no SSH keys left in /tmp after collections");
  ok(docker("exec", "e2e-agent", "sh", "-c", "grep -c 'PRIVATE KEY' /data/agent.state || true") === "0", "agent: its CA and keys are sealed on its volume");
  ok(
    docker("exec", "e2e-infra", "sh", "-c", "cat /data/infra.db* | tr -d '\\0' | grep -a -c 'PRIVATE KEY' || true") === "0",
    "infra: holds no SSH private key at all",
  );

  // Kubernetes through its API.
  if (process.env.KIND_CLUSTER) {
    const kc = (...a: string[]) => sh("kubectl", ["--context", `kind-${process.env.KIND_CLUSTER}`, ...a]);
    const rbac = (await api<{ kubernetesRbac: string }>("/api/v1/setup")).body.kubernetesRbac;
    sh("kubectl", ["--context", `kind-${process.env.KIND_CLUSTER}`, "apply", "-f", "-"], { input: rbac });
    sh("kubectl", ["--context", `kind-${process.env.KIND_CLUSTER}`, "apply", "-f", "-"], {
      input:
        "apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: e2e-web, namespace: default}\nspec:\n  selector: {matchLabels: {app: e2e-web}}\n  template:\n    metadata: {labels: {app: e2e-web}}\n    spec: {containers: [{name: web, image: nginx:1.27-alpine}]}\n",
    });
    for (let i = 0; i < 30 && !kc("-n", "openasy", "get", "secret", "openasy-infra-token", "-o", "jsonpath={.data.token}"); i++) await sleep(1000);
    const tok = Buffer.from(kc("-n", "openasy", "get", "secret", "openasy-infra-token", "-o", "jsonpath={.data.token}"), "base64").toString();
    const ca = Buffer.from(kc("config", "view", "--raw", "--minify", "-o", "jsonpath={.clusters[0].cluster.certificate-authority-data}"), "base64").toString();
    const c = await api<{ id: string }>("/api/v1/clusters", {
      name: "kind",
      server: `https://${process.env.KIND_CLUSTER}-control-plane:6443`,
      caCert: ca,
      token: tok,
    });
    ok(c.status === 201, "kind: cluster added");
    let cs = "";
    for (let i = 0; i < 40 && cs !== "ok"; i++) {
      await sleep(1000);
      cs = (await api<{ status: string }>(`/api/v1/clusters/${c.body.id}`)).body.status;
    }
    ok(cs === "ok", `kind: collected (${cs})`);
    const cf = (await api<{ workloads: Array<{ name: string }>; nodes: unknown[] }>(`/api/v1/clusters/${c.body.id}/facts`)).body;
    ok(cf.workloads.some((w) => w.name === "e2e-web") && cf.nodes.length > 0, "kind: nodes and the e2e-web deployment are read");
    ok(
      sh("curl", [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-k",
        "-H",
        `Authorization: Bearer ${tok}`,
        `${kc("config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}")}/api/v1/secrets`,
      ]) === "403",
      "kind: the token cannot read Secrets",
    );
  }
} catch (err) {
  console.log("FAIL", err);
  failed++;
  for (const c of ["e2e-infra", "e2e-agent"]) {
    try {
      console.log(`--- ${c}\n${execFileSync("docker", ["logs", "--tail", "30", c], { encoding: "utf8" })}`);
    } catch {
      // Not started.
    }
  }
} finally {
  if (!process.env.KEEP) cleanup();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

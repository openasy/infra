// Hosts, agents and clusters, their collections, and what changed. Everything the API offers goes through here.
// Infrastructure holds no SSH key and sends no commands: infra-agent asks for jobs ("collect this host"), runs its
// own script and sends back what it found (ADR 0018, 0031).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { diff, hostItems, itemsHash, type Change, type Item } from "./changes.ts";
import { checkFacts, type Facts } from "./facts.ts";
import { clusterItems, collectCluster, K8sError, RBAC, type ClusterFacts } from "./k8s.ts";
import type { HostEntry } from "./hosts.ts";
import type { Keyring } from "./kek.ts";
import { log } from "./log.ts";

export type ProblemCode =
  "invalid-body" | "not-found" | "conflict" | "not-configured" | "invalid-json" | "invalid-token" | "version-mismatch" | "internal-error";

export class InfraError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

type Kind = "host" | "cluster";

interface AgentRow {
  id: string;
  name: string;
  enroll_token_hash: string | null;
  enroll_expires_at: string | null;
  secret_hash: string | null;
  version: string | null;
  ca_public_key: string | null;
  key_public_key: string | null;
  setup: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface HostRow {
  id: string;
  name: string;
  agent_id: string;
  address: string;
  port: number;
  ssh_user: string;
  auth: "certificate" | "key";
  jump_host_id: string | null;
  containers: number;
  interval_minutes: number;
  tags: string;
  host_keys: string;
  pending_host_keys: string;
  status: string;
  status_detail: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  collect_requested: number;
  key_requested: number;
  lease_until: string | null;
  latest_facts: Uint8Array | null;
  created_at: string;
  source: "ui" | "file";
  file_host_key: string | null;
  key_file: string | null;
}

interface ClusterRow {
  id: string;
  name: string;
  server: string;
  ca_cert: string | null;
  token_sealed: string;
  interval_minutes: number;
  tags: string;
  status: string;
  status_detail: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  collect_requested: number;
  latest_facts: Uint8Array | null;
  created_at: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
const HOST_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;
const JOB_LEASE_MS = 10 * 60_000;
const ENROLL_TTL_MS = 7 * 86_400_000;
/** An agent that has not asked for work for this long is shown as offline. */
const AGENT_OFFLINE_MS = 2 * 60_000;

const pack = (v: unknown) => gzipSync(JSON.stringify(v));
const unpack = <T>(b: Uint8Array) => JSON.parse(gunzipSync(b).toString("utf8")) as T;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** SHA256:... as OpenSSH prints it. */
export function fingerprint(keyLine: string): string {
  const blob = keyLine.trim().split(/\s+/)[1] ?? "";
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

export function createInfra(
  db: DatabaseSync,
  keyring: Keyring,
  opts: { version: string; now?: () => number; collectCluster?: typeof collectCluster; concurrency?: number },
) {
  const now = opts.now ?? Date.now;
  const iso = (ms = now()) => new Date(ms).toISOString();
  const k8s = opts.collectCluster ?? collectCluster;
  const running = new Set<string>();

  // ---- Agents -----------------------------------------------------------------------------------------------------

  const agentRow = (id: string) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  const requireAgent = (id: string) => {
    const a = agentRow(id);
    if (!a) throw new InfraError(404, "not-found", "No such agent.");
    return a;
  };

  function toAgent(a: AgentRow) {
    const online = !!a.last_seen_at && Date.parse(a.last_seen_at) + AGENT_OFFLINE_MS > now();
    return {
      id: a.id,
      name: a.name,
      status: !a.secret_hash ? "waiting-to-enrol" : online ? (a.version === opts.version ? "online" : "version-mismatch") : "offline",
      version: a.version,
      caFingerprint: a.ca_public_key ? fingerprint(a.ca_public_key) : null,
      lastSeenAt: a.last_seen_at,
      lastError: a.last_error,
      hosts: (db.prepare("SELECT COUNT(*) AS n FROM hosts WHERE agent_id = ?").get(a.id) as { n: number }).n,
      createdAt: a.created_at,
    };
  }

  function newEnrollToken(id: string) {
    const token = `oie_${randomBytes(24).toString("base64url")}`;
    db.prepare("UPDATE agents SET enroll_token_hash = ?, enroll_expires_at = ? WHERE id = ?").run(sha256(token), iso(now() + ENROLL_TTL_MS), id);
    return { enrollToken: token, enrollExpiresAt: iso(now() + ENROLL_TTL_MS) };
  }

  /** A new agent and its one-time enrolment token, shown once. */
  function createAgent(b: Record<string, unknown>) {
    if (typeof b.name !== "string" || !NAME.test(b.name))
      throw new InfraError(422, "invalid-body", "name is letters, digits, dots, dashes and underscores, up to 63.");
    if (db.prepare("SELECT 1 FROM agents WHERE name = ?").get(b.name)) throw new InfraError(409, "conflict", `An agent named ${b.name} exists.`);
    const id = randomUUID();
    db.prepare("INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)").run(id, b.name, iso());
    return { agent: toAgent(requireAgent(id)), ...newEnrollToken(id) };
  }

  /** A new enrolment token, for an agent that lost its volume. Its old secret stops working. */
  function reEnroll(id: string) {
    requireAgent(id);
    db.prepare("UPDATE agents SET secret_hash = NULL, ca_public_key = NULL WHERE id = ?").run(id);
    return { agent: toAgent(requireAgent(id)), ...newEnrollToken(id) };
  }

  function deleteAgent(id: string) {
    requireAgent(id);
    if (db.prepare("SELECT 1 FROM hosts WHERE agent_id = ?").get(id))
      throw new InfraError(409, "conflict", "Hosts are read by this agent. Move or remove them first.");
    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  /** What the agent reported for admins to put on hosts: its CA, the sshd drop-in, the sudoers file. */
  function agentSetup(id: string) {
    const a = requireAgent(id);
    if (!a.setup || !a.ca_public_key) throw new InfraError(409, "conflict", "The agent has not enrolled yet. Start it with its enrolment token.");
    return {
      agent: toAgent(a),
      caPublicKey: a.ca_public_key,
      caFingerprint: fingerprint(a.ca_public_key),
      keyPublicKey: a.key_public_key,
      ...(JSON.parse(a.setup) as Record<string, string>),
    };
  }

  function checkReport(b: Record<string, unknown>) {
    const bad = (m: string) => new InfraError(422, "invalid-body", m);
    const isKey = (v: unknown) => typeof v === "string" && HOST_KEY.test(v.trim().split(/\s+/).slice(0, 2).join(" "));
    if (typeof b.version !== "string" || b.version.length > 32) throw bad("version is required.");
    if (!isKey(b.caPublicKey)) throw bad("caPublicKey is an OpenSSH public key.");
    if (!isKey(b.keyPublicKey)) throw bad("keyPublicKey is an OpenSSH public key.");
    const s = b.setup as Record<string, unknown> | undefined;
    if (!s || ["sshdConfig", "sudoers", "hostSetup", "authorizedKey"].some((k) => typeof s[k] !== "string" || (s[k] as string).length > 64_000))
      throw bad("setup holds sshdConfig, sudoers, hostSetup and authorizedKey.");
    return {
      version: b.version,
      caPublicKey: (b.caPublicKey as string).trim(),
      keyPublicKey: (b.keyPublicKey as string).trim(),
      setup: JSON.stringify({ sshdConfig: s.sshdConfig, sudoers: s.sudoers, hostSetup: s.hostSetup, authorizedKey: s.authorizedKey }),
    };
  }

  function enroll(b: Record<string, unknown>) {
    const token = typeof b.token === "string" ? b.token : "";
    const a = db.prepare("SELECT * FROM agents WHERE enroll_token_hash = ?").get(sha256(token)) as AgentRow | undefined;
    if (!a || !a.enroll_expires_at || a.enroll_expires_at <= iso())
      throw new InfraError(401, "invalid-token", "The enrolment token is unknown, used or expired. Create a new one under Settings, Agents.");
    const r = checkReport(b);
    const secret = `oia_${randomBytes(32).toString("base64url")}`;
    db.prepare(
      "UPDATE agents SET enroll_token_hash = NULL, enroll_expires_at = NULL, secret_hash = ?, version = ?, ca_public_key = ?, key_public_key = ?, setup = ?, last_seen_at = ?, last_error = NULL WHERE id = ?",
    ).run(sha256(secret), r.version, r.caPublicKey, r.keyPublicKey, r.setup, iso(), a.id);
    log("info", "agent enrolled", { agent: a.name, version: r.version, ca: fingerprint(r.caPublicKey) });
    return { agentId: a.id, secret };
  }

  /** The agent behind a bearer secret, or 401. */
  function agentBySecret(header: string | undefined): AgentRow {
    const secret = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const a = secret ? (db.prepare("SELECT * FROM agents WHERE secret_hash = ?").get(sha256(secret)) as AgentRow | undefined) : undefined;
    if (!a) throw new InfraError(401, "invalid-token", "Unknown agent secret. Enrol the agent again under Settings, Agents.");
    return a;
  }

  const hostRow = (id: string) => db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as HostRow | undefined;
  const requireHost = (id: string) => {
    const h = hostRow(id);
    if (!h) throw new InfraError(404, "not-found", "No such host.");
    return h;
  };
  const endpointOf = (h: HostRow) => ({ address: h.address, port: h.port, user: h.ssh_user, hostKeys: JSON.parse(h.host_keys) as string[] });
  const keyPinned = (h: HostRow) => JSON.parse(h.host_keys).length > 0 && h.status !== "host-key-changed" && h.status !== "host-key-pending";

  /** Jobs for one agent: hosts whose key it should fetch, and hosts that are due. Each is leased for 10 minutes. */
  function work(a: AgentRow, b: Record<string, unknown>) {
    const r = checkReport(b);
    // ADR 0019: an agent always has the same version as its product.
    if (r.version !== opts.version) {
      db.prepare("UPDATE agents SET version = ?, last_seen_at = ?, last_error = ? WHERE id = ?").run(
        r.version,
        iso(),
        `infra-agent ${r.version} does not match infra ${opts.version}`,
        a.id,
      );
      throw new InfraError(409, "version-mismatch", `infra-agent ${r.version} does not match infra ${opts.version}; install infra-agent ${opts.version}`);
    }
    // A changed CA means every host must trust the new one; refuse until an admin enrols the agent again.
    if (a.ca_public_key && a.ca_public_key !== r.caPublicKey)
      throw new InfraError(409, "conflict", "This agent's CA changed since it enrolled. Enrol it again under Settings, Agents.");
    db.prepare("UPDATE agents SET version = ?, key_public_key = ?, setup = ?, last_seen_at = ?, last_error = NULL WHERE id = ?").run(
      r.version,
      r.keyPublicKey,
      r.setup,
      iso(),
      a.id,
    );

    const t = now();
    const free = (h: HostRow) => !h.lease_until || Date.parse(h.lease_until) <= t;
    const hosts = (db.prepare("SELECT * FROM hosts WHERE agent_id = ?").all(a.id) as unknown as HostRow[]).filter(free);
    const keyJobs = hosts.filter((h) => h.key_requested === 1);
    const due = hosts.filter(
      (h) =>
        h.key_requested === 0 &&
        keyPinned(h) &&
        (h.collect_requested === 1 || !h.last_attempt_at || Date.parse(h.last_attempt_at) + h.interval_minutes * 60_000 <= t),
    );
    const jobs = [...keyJobs.map((h) => ({ h, action: "host-key" as const })), ...due.map((h) => ({ h, action: "collect" as const }))].slice(0, 64);
    const leaseKey = db.prepare("UPDATE hosts SET lease_until = ? WHERE id = ?");
    const leaseCollect = db.prepare("UPDATE hosts SET lease_until = ?, last_attempt_at = ?, collect_requested = 0 WHERE id = ?");
    return {
      jobs: jobs.flatMap(({ h, action }) => {
        const jump = h.jump_host_id ? hostRow(h.jump_host_id) : undefined;
        if (jump && !JSON.parse(jump.host_keys).length) return [];
        if (action === "collect") leaseCollect.run(iso(t + JOB_LEASE_MS), iso(t), h.id);
        else leaseKey.run(iso(t + JOB_LEASE_MS), h.id);
        return [
          {
            id: randomUUID(),
            hostId: h.id,
            action,
            target: { ...endpointOf(h), auth: h.auth, ...(h.auth === "key" && h.key_file && { keyFile: h.key_file }), containers: h.containers === 1 },
            jump: jump ? endpointOf(jump) : null,
          },
        ];
      }),
    };
  }

  const FAILURES = new Set(["unreachable", "auth-failed", "host-key-changed", "host-key-unknown", "timeout", "error", "invalid-job"]);

  /** What the agent found for one job. */
  function result(a: AgentRow, b: Record<string, unknown>) {
    const h = typeof b.hostId === "string" ? hostRow(b.hostId) : undefined;
    // Only the agent that reads a host may report on it.
    if (!h || h.agent_id !== a.id) throw new InfraError(404, "not-found", "No such host for this agent.");
    db.prepare("UPDATE hosts SET lease_until = NULL WHERE id = ?").run(h.id);
    const keys = b.hostKeys;
    const keyList =
      Array.isArray(keys) && keys.length > 0 && keys.length <= 8 && keys.every((k) => typeof k === "string" && HOST_KEY.test(k))
        ? (keys as string[])
        : undefined;
    if (b.ok === true && keyList && b.facts === undefined) {
      // The hosts file vouches for a key with its fingerprint (ADR 0052): that key is pinned without an admin.
      const vouched = h.file_host_key && h.file_host_key !== "first" ? keyList.find((k) => fingerprint(k) === h.file_host_key) : undefined;
      // hostKey: first trusts the keys the host presents the first time, and none other after (ssh's accept-new).
      const firstSeen = h.file_host_key === "first" && (JSON.parse(h.host_keys) as string[]).length === 0;
      if (firstSeen) {
        db.prepare(
          "UPDATE hosts SET key_requested = 0, host_keys = ?, pending_host_keys = '[]', status = 'pending', status_detail = NULL, collect_requested = 1 WHERE id = ?",
        ).run(JSON.stringify(keyList), h.id);
        log("info", "host key trusted on first use, as the hosts file says", { host: h.name, fingerprints: keyList.map(fingerprint) });
        return { status: "accepted" };
      }
      if (vouched) {
        db.prepare(
          "UPDATE hosts SET key_requested = 0, host_keys = ?, pending_host_keys = '[]', status = 'pending', status_detail = NULL, collect_requested = 1 WHERE id = ?",
        ).run(JSON.stringify([vouched]), h.id);
        log("info", "host key trusted from the hosts file", { host: h.name, fingerprint: h.file_host_key });
        return { status: "accepted" };
      }
      // The key the host presents: pinned only after an admin compares it.
      const pinned = JSON.parse(h.host_keys) as string[];
      const same = pinned.length > 0 && keyList.every((k) => pinned.includes(k));
      db.prepare("UPDATE hosts SET key_requested = 0, pending_host_keys = ?, status = ?, status_detail = ? WHERE id = ?").run(
        JSON.stringify(same ? [] : keyList),
        same ? (h.status === "host-key-changed" ? "pending" : h.status) : pinned.length ? "host-key-changed" : "host-key-pending",
        same
          ? h.status_detail
          : h.file_host_key && h.file_host_key !== "first"
            ? `The host presents a key that is not ${h.file_host_key} from the hosts file. Check the host, then fix hostKey in the file.`
            : pinned.length
              ? "The host presents a different key. Check it on the host, then accept it."
              : "Check the fingerprint on the host, then accept it.",
        h.id,
      );
      return { status: "accepted" };
    }
    if (b.ok === true && b.facts !== undefined) {
      if (!keyPinned(h)) throw new InfraError(409, "conflict", "The host key is not accepted; facts are not stored.");
      let facts: Facts;
      try {
        facts = checkFacts(b.facts);
      } catch (err) {
        throw new InfraError(422, "invalid-body", (err as Error).message);
      }
      // Our clock, not the host's: a host with a wrong clock must not reorder the timeline.
      const at = iso();
      const changes = record("host", h.id, facts, hostItems(facts), at);
      db.prepare("UPDATE hosts SET status = 'ok', status_detail = NULL, last_success_at = ?, latest_facts = ? WHERE id = ?").run(at, pack(facts), h.id);
      if (changes.length) log("info", "host changed", { host: h.name, changes: changes.length });
      return { status: "accepted" };
    }
    const e = b.error as { kind?: unknown; message?: unknown } | undefined;
    if (b.ok !== false || !e || typeof e.kind !== "string" || !FAILURES.has(e.kind) || typeof e.message !== "string")
      throw new InfraError(422, "invalid-body", "Expected facts, hostKeys, or an error with kind and message.");
    const message = e.message.slice(0, 1000);
    if (e.kind === "host-key-changed") {
      db.prepare("UPDATE hosts SET status = 'host-key-changed', status_detail = ?, pending_host_keys = ? WHERE id = ?").run(
        "The host key changed. Check the host, then accept the new key.",
        JSON.stringify(keyList ?? []),
        h.id,
      );
    } else {
      db.prepare("UPDATE hosts SET status = ?, status_detail = ? WHERE id = ?").run(e.kind === "host-key-unknown" ? "unreachable" : e.kind, message, h.id);
    }
    log("warn", "host collection failed", { host: h.name, kind: e.kind, error: message });
    return { status: "accepted" };
  }

  // ---- Hosts ------------------------------------------------------------------------------------------------------

  function hostSummary(f: Facts | null) {
    if (!f) return null;
    const disk = f.filesystems
      .filter((x) => x.sizeKb > 0)
      .reduce<{ mount: string; pct: number } | null>((max, x) => {
        const pct = Math.round((x.usedKb / x.sizeKb) * 100);
        return !max || pct > max.pct ? { mount: x.mount, pct } : max;
      }, null);
    return {
      hostname: f.system.hostname,
      os: f.system.os.name,
      kernel: f.system.kernel,
      arch: f.system.arch,
      virtualization: f.system.virtualization,
      uptimeSec: f.system.uptimeSec,
      load: f.system.load,
      cpuThreads: f.cpu.threads,
      memoryTotalKb: f.memory.totalKb,
      memoryAvailableKb: f.memory.availableKb,
      fullestDisk: disk,
      packages: f.packages.length,
      listeningPorts: f.ports?.length ?? null,
      processes: f.processes.length,
      containers: f.containers?.length ?? null,
      unreadable: f.unreadable,
    };
  }

  function toHost(h: HostRow) {
    const jump = h.jump_host_id ? hostRow(h.jump_host_id) : undefined;
    const agent = agentRow(h.agent_id)!;
    return {
      id: h.id,
      name: h.name,
      agent: { id: agent.id, name: agent.name },
      address: h.address,
      port: h.port,
      user: h.ssh_user,
      auth: h.auth,
      jumpHost: jump ? { id: jump.id, name: jump.name } : null,
      source: h.source,
      // A fingerprint the file trusts; first is not one, and its key is accepted like any other once it changes.
      fileHostKey: h.file_host_key === "first" ? null : h.file_host_key,
      containers: h.containers === 1,
      intervalMinutes: h.interval_minutes,
      tags: JSON.parse(h.tags) as Record<string, string>,
      hostKeys: (JSON.parse(h.host_keys) as string[]).map((k) => ({ type: k.split(" ")[0]!, fingerprint: fingerprint(k) })),
      pendingHostKeys: (JSON.parse(h.pending_host_keys) as string[]).map((k) => ({ type: k.split(" ")[0]!, fingerprint: fingerprint(k) })),
      status: h.status,
      statusDetail: h.status_detail,
      lastAttemptAt: h.last_attempt_at,
      lastSuccessAt: h.last_success_at,
      createdAt: h.created_at,
      summary: hostSummary(h.latest_facts ? unpack<Facts>(h.latest_facts) : null),
    };
  }

  const fromFile = (h: HostRow, what: string) => {
    if (h.source === "file") throw new InfraError(409, "conflict", `This host comes from the hosts file (OPENASY_HOSTS). ${what}`);
    return h;
  };

  function requestHostKey(id: string) {
    requireHost(id);
    db.prepare("UPDATE hosts SET key_requested = 1, lease_until = NULL WHERE id = ?").run(id);
    return toHost(requireHost(id));
  }

  function acceptHostKey(id: string, fp: unknown) {
    const h = requireHost(id);
    if (h.file_host_key && h.file_host_key !== "first") fromFile(h, "Its key is the one hostKey names there; change hostKey to trust another.");
    const key = (JSON.parse(h.pending_host_keys) as string[]).find((k) => fingerprint(k) === fp);
    if (typeof fp !== "string" || !key) throw new InfraError(422, "invalid-body", "fingerprint must be one of the pending host keys, as SHA256:...");
    db.prepare(
      "UPDATE hosts SET host_keys = ?, pending_host_keys = '[]', status = 'pending', status_detail = NULL, collect_requested = 1, lease_until = NULL WHERE id = ?",
    ).run(JSON.stringify([key]), id);
    return toHost(requireHost(id));
  }

  function deleteHost(id: string) {
    fromFile(requireHost(id), "Remove it there.");
    removeHost(id);
  }

  function removeHost(id: string) {
    if (db.prepare("SELECT 1 FROM hosts WHERE jump_host_id = ?").get(id))
      throw new InfraError(409, "conflict", "Other hosts are reached through this one. Change their jump host first.");
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM snapshots WHERE target_kind = 'host' AND target_id = ?").run(id);
      db.prepare("DELETE FROM changes WHERE target_kind = 'host' AND target_id = ?").run(id);
      db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Makes the hosts match the hosts file (ADR 0052): adds, changes and removes them. A host added here before, with
   * the name of an entry, becomes the file's and keeps its history. An entry that cannot be added yet, such as one whose agent is not enrolled, is a warning, and a host it
   * made before is kept rather than removed with its history. A new address, port or agent, or another hostKey than
   * the pinned key, is a new trust decision, as in the UI. Returns what to fix.
   */
  function syncFile(entries: HostEntry[]): string[] {
    const warnings: string[] = [];
    const agents = db.prepare("SELECT id, name FROM agents").all() as Array<{ id: string; name: string }>;
    const agentOf = (e: HostEntry) => {
      if (e.agent) {
        const a = agents.find((x) => x.name === e.agent);
        if (!a) warnings.push(`${e.name}: no agent is named ${e.agent}; it is added once one is.`);
        return a?.id;
      }
      if (agents.length === 1) return agents[0]!.id;
      warnings.push(
        agents.length
          ? `${e.name}: name the agent that reaches it with agent:, as there are ${agents.length}.`
          : `${e.name}: it is added once an agent is, under Settings, Agents.`,
      );
      return undefined;
    };
    const planned = new Map<string, { e: HostEntry; agentId: string }>();
    for (const e of entries) {
      const agentId = agentOf(e);
      if (!agentId) continue;
      planned.set(e.name, { e, agentId });
    }
    // A jump host must be added too, and read by the same agent; the parser already made sure it is reached directly.
    for (const [name, p] of planned) {
      if (!p.e.jump) continue;
      const j = planned.get(p.e.jump);
      if (!j) warnings.push(`${name}: its jump host ${p.e.jump} is not added, so neither is it.`);
      else if (j.agentId !== p.agentId)
        warnings.push(`${name}: its jump host ${p.e.jump} is read by another agent; a jump host must be read by the same agent.`);
      else continue;
      planned.delete(name);
    }

    const ids = new Map<string, string>();
    for (const [name, { e, agentId }] of planned) {
      const h = db.prepare("SELECT * FROM hosts WHERE name = ?").get(name) as HostRow | undefined;
      if (!h) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO hosts (id, name, agent_id, address, port, ssh_user, auth, key_file, containers, interval_minutes, tags, created_at, source, file_host_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 5, ?, ?, 'file', ?)",
        ).run(id, name, agentId, e.address, e.port, e.user, e.auth, e.keyFile, e.containers ? 1 : 0, JSON.stringify(e.tags), iso(), e.hostKey);
        ids.set(name, id);
        continue;
      }
      ids.set(name, h.id);
      if (h.source === "ui") db.prepare("UPDATE hosts SET source = 'file' WHERE id = ?").run(h.id);
      const pinned = JSON.parse(h.host_keys) as string[];
      const moved = e.address !== h.address || e.port !== h.port || agentId !== h.agent_id;
      const vouchesOther =
        !!e.hostKey && e.hostKey !== "first" && e.hostKey !== h.file_host_key && pinned.length > 0 && !pinned.some((k) => fingerprint(k) === e.hostKey);
      db.prepare(
        "UPDATE hosts SET agent_id = ?, address = ?, port = ?, ssh_user = ?, auth = ?, key_file = ?, containers = ?, tags = ?, file_host_key = ? WHERE id = ?",
      ).run(agentId, e.address, e.port, e.user, e.auth, e.keyFile, e.containers ? 1 : 0, JSON.stringify(e.tags), e.hostKey, h.id);
      if (moved || vouchesOther)
        db.prepare(
          "UPDATE hosts SET host_keys = '[]', pending_host_keys = '[]', status = 'new', status_detail = NULL, key_requested = 1, lease_until = NULL WHERE id = ?",
        ).run(h.id);
      // A hostKey given now for a host whose key is not pinned yet: ask for the key again, to trust it if it matches.
      else if (e.hostKey && e.hostKey !== h.file_host_key && !pinned.length)
        db.prepare("UPDATE hosts SET key_requested = 1, lease_until = NULL WHERE id = ?").run(h.id);
    }
    for (const [name, { e }] of planned) db.prepare("UPDATE hosts SET jump_host_id = ? WHERE id = ?").run(e.jump ? ids.get(e.jump)! : null, ids.get(name)!);

    // Hosts that left the file go, those reached through another first; one a host added here still goes through stays.
    const named = new Set(entries.map((e) => e.name));
    const gone = (db.prepare("SELECT * FROM hosts WHERE source = 'file'").all() as unknown as HostRow[]).filter((h) => !named.has(h.name));
    for (const h of gone.sort((a, b) => Number(!a.jump_host_id) - Number(!b.jump_host_id))) {
      const through = db.prepare("SELECT name FROM hosts WHERE jump_host_id = ?").all(h.id) as Array<{ name: string }>;
      if (through.length) warnings.push(`${h.name} left the file but stays: ${through.map((x) => x.name).join(", ")} is reached through it.`);
      else removeHost(h.id);
    }
    return warnings;
  }

  // ---- Snapshots and changes --------------------------------------------------------------------------------------

  /** Stores the collection when it differs from the last stored one, and what changed. */
  function record(kind: Kind, id: string, facts: unknown, items: Item[], at: string): Change[] {
    const hash = itemsHash(items);
    const last = db.prepare("SELECT items_hash, facts FROM snapshots WHERE target_kind = ? AND target_id = ? ORDER BY id DESC LIMIT 1").get(kind, id) as
      { items_hash: string; facts: Uint8Array } | undefined;
    if (last?.items_hash === hash) return [];
    const changes = last ? diff(kind === "host" ? hostItems(unpack<Facts>(last.facts)) : clusterItems(unpack<ClusterFacts>(last.facts)), items) : [];
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO snapshots (target_kind, target_id, collected_at, items_hash, facts) VALUES (?, ?, ?, ?, ?)").run(kind, id, at, hash, pack(facts));
      const ins = db.prepare("INSERT INTO changes (target_kind, target_id, at, category, item, kind, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const c of changes) ins.run(kind, id, at, c.category, c.key, c.kind, c.before, c.after);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return changes;
  }

  // ---- Clusters ---------------------------------------------------------------------------------------------------

  const clusterRow = (id: string) => db.prepare("SELECT * FROM clusters WHERE id = ?").get(id) as ClusterRow | undefined;
  const requireCluster = (id: string) => {
    const c = clusterRow(id);
    if (!c) throw new InfraError(404, "not-found", "No such cluster.");
    return c;
  };

  function toCluster(c: ClusterRow) {
    const f = c.latest_facts ? unpack<ClusterFacts>(c.latest_facts) : null;
    return {
      id: c.id,
      name: c.name,
      server: c.server,
      intervalMinutes: c.interval_minutes,
      tags: JSON.parse(c.tags) as Record<string, string>,
      status: c.status,
      statusDetail: c.status_detail,
      lastAttemptAt: c.last_attempt_at,
      lastSuccessAt: c.last_success_at,
      createdAt: c.created_at,
      summary: f && {
        version: f.version.gitVersion,
        nodes: f.nodes.length,
        nodesReady: f.nodes.filter((n) => n.ready).length,
        namespaces: f.namespaces.length,
        workloads: f.workloads.length,
        pods: f.pods.length,
        podsNotRunning: f.pods.filter((p) => p.phase !== "Running" && p.phase !== "Succeeded").length,
        restarts: f.pods.reduce((n, p) => n + p.restarts, 0),
        warnings: f.events.length,
      },
    };
  }

  function clusterInput(b: Record<string, unknown>, partial: boolean) {
    const bad = (m: string) => new InfraError(422, "invalid-body", m);
    const out: Partial<{ name: string; server: string; caCert: string | null; token: string; intervalMinutes: number; tags: Record<string, string> }> = {};
    if (b.name !== undefined || !partial) {
      if (typeof b.name !== "string" || !NAME.test(b.name)) throw bad("name is letters, digits, dots, dashes and underscores, up to 63.");
      out.name = b.name;
    }
    if (b.server !== undefined || !partial) {
      let u: URL | undefined;
      try {
        u = new URL(String(b.server));
      } catch {
        u = undefined;
      }
      if (!u || u.protocol !== "https:") throw bad("server is the API server's https:// URL.");
      out.server = u.origin;
    }
    if (b.caCert !== undefined) {
      if (b.caCert !== null && (typeof b.caCert !== "string" || !b.caCert.includes("BEGIN CERTIFICATE") || b.caCert.length > 16_384))
        throw bad("caCert is the cluster CA in PEM, or null to use the system's.");
      out.caCert = b.caCert;
    }
    if (b.token !== undefined || !partial) {
      if (typeof b.token !== "string" || b.token.length < 20 || b.token.length > 8192 || /\s/.test(b.token)) throw bad("token is the service account token.");
      out.token = b.token;
    }
    if (b.intervalMinutes !== undefined) {
      if (typeof b.intervalMinutes !== "number" || !Number.isInteger(b.intervalMinutes) || b.intervalMinutes < 1 || b.intervalMinutes > 1440)
        throw bad("intervalMinutes is 1 to 1440.");
      out.intervalMinutes = b.intervalMinutes;
    }
    if (b.tags !== undefined) {
      const t = b.tags;
      if (!t || typeof t !== "object" || Array.isArray(t) || Object.entries(t).some(([k, v]) => !TAG.test(k) || typeof v !== "string"))
        throw bad("tags is an object of name: value strings.");
      out.tags = t as Record<string, string>;
    }
    return out;
  }

  function createCluster(b: Record<string, unknown>) {
    const v = clusterInput(b, false);
    if (db.prepare("SELECT 1 FROM clusters WHERE name = ?").get(v.name!)) throw new InfraError(409, "conflict", `A cluster named ${v.name} exists.`);
    const id = randomUUID();
    db.prepare(
      "INSERT INTO clusters (id, name, server, ca_cert, token_sealed, interval_minutes, tags, collect_requested, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
    ).run(id, v.name!, v.server!, v.caCert ?? null, keyring.seal(v.token!), v.intervalMinutes ?? 5, JSON.stringify(v.tags ?? {}), iso());
    return toCluster(requireCluster(id));
  }

  function updateCluster(id: string, b: Record<string, unknown>) {
    const c = requireCluster(id);
    const v = clusterInput(b, true);
    if (v.name && v.name !== c.name && db.prepare("SELECT 1 FROM clusters WHERE name = ?").get(v.name))
      throw new InfraError(409, "conflict", `A cluster named ${v.name} exists.`);
    db.prepare(
      "UPDATE clusters SET name = ?, server = ?, ca_cert = ?, token_sealed = ?, interval_minutes = ?, tags = ?, collect_requested = 1 WHERE id = ?",
    ).run(
      v.name ?? c.name,
      v.server ?? c.server,
      v.caCert === undefined ? c.ca_cert : v.caCert,
      v.token ? keyring.seal(v.token) : c.token_sealed,
      v.intervalMinutes ?? c.interval_minutes,
      JSON.stringify(v.tags ?? JSON.parse(c.tags)),
      id,
    );
    return toCluster(requireCluster(id));
  }

  function deleteCluster(id: string) {
    requireCluster(id);
    db.prepare("DELETE FROM snapshots WHERE target_kind = 'cluster' AND target_id = ?").run(id);
    db.prepare("DELETE FROM changes WHERE target_kind = 'cluster' AND target_id = ?").run(id);
    db.prepare("DELETE FROM clusters WHERE id = ?").run(id);
  }

  async function collectClusterNow(id: string) {
    const c = requireCluster(id);
    const at = iso();
    db.prepare("UPDATE clusters SET last_attempt_at = ?, collect_requested = 0 WHERE id = ?").run(at, id);
    try {
      const facts = await k8s({ server: c.server, caCert: c.ca_cert, token: keyring.open(c.token_sealed).toString("utf8") });
      record("cluster", id, facts, clusterItems(facts), at);
      db.prepare("UPDATE clusters SET status = 'ok', status_detail = NULL, last_success_at = ?, latest_facts = ? WHERE id = ?").run(iso(), pack(facts), id);
    } catch (err) {
      const kind = err instanceof K8sError ? err.kind : "error";
      db.prepare("UPDATE clusters SET status = ?, status_detail = ? WHERE id = ?").run(kind, err instanceof Error ? err.message : String(err), id);
      log("warn", "cluster collection failed", { cluster: c.name, kind, error: String(err) });
    }
  }

  /** Collects the clusters that are due. Hosts are collected by their agents. */
  async function tick() {
    const t = now();
    const rows = (db.prepare("SELECT id, interval_minutes, last_attempt_at, collect_requested FROM clusters").all() as unknown as ClusterRow[]).filter(
      (r) => r.collect_requested === 1 || !r.last_attempt_at || Date.parse(r.last_attempt_at) + r.interval_minutes * 60_000 <= t,
    );
    const queue = rows.filter((r) => !running.has(r.id));
    await Promise.all(
      Array.from({ length: Math.min(opts.concurrency ?? 4, queue.length) }, async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          running.add(r.id);
          try {
            await collectClusterNow(r.id);
          } finally {
            running.delete(r.id);
          }
        }
      }),
    );
  }

  function requestCollect(kind: Kind, id: string) {
    if (kind === "host") {
      const h = requireHost(id);
      if (!keyPinned(h)) throw new InfraError(409, "conflict", "Accept the host key first.");
      db.prepare("UPDATE hosts SET collect_requested = 1, lease_until = NULL WHERE id = ?").run(id);
    } else {
      requireCluster(id);
      db.prepare("UPDATE clusters SET collect_requested = 1 WHERE id = ?").run(id);
    }
  }

  // ---- Reading ----------------------------------------------------------------------------------------------------

  function hostFacts(id: string, at?: string): { facts: Facts; collectedAt: string } | null {
    const h = requireHost(id);
    if (at) {
      const row = db
        .prepare(
          "SELECT facts, collected_at FROM snapshots WHERE target_kind = 'host' AND target_id = ? AND collected_at <= ? ORDER BY collected_at DESC, id DESC LIMIT 1",
        )
        .get(id, at) as { facts: Uint8Array; collected_at: string } | undefined;
      return row ? { facts: unpack<Facts>(row.facts), collectedAt: row.collected_at } : null;
    }
    if (!h.latest_facts) return null;
    return { facts: unpack<Facts>(h.latest_facts), collectedAt: h.last_success_at ?? "" };
  }

  function clusterFacts(id: string) {
    const c = requireCluster(id);
    return c.latest_facts ? unpack<ClusterFacts>(c.latest_facts) : null;
  }

  function changes(filter: { kind?: Kind; id?: string; category?: string; since?: string; cursor?: number; limit: number }) {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.kind) (where.push("target_kind = ?"), args.push(filter.kind));
    if (filter.id) (where.push("target_id = ?"), args.push(filter.id));
    if (filter.category) (where.push("category = ?"), args.push(filter.category));
    if (filter.since) (where.push("at >= ?"), args.push(filter.since));
    if (filter.cursor) (where.push("id < ?"), args.push(filter.cursor));
    const rows = db
      .prepare(`SELECT * FROM changes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, filter.limit + 1) as Array<{
      id: number;
      target_kind: Kind;
      target_id: string;
      at: string;
      category: string;
      item: string;
      kind: Change["kind"];
      before: string | null;
      after: string | null;
    }>;
    const names = new Map<string, string>();
    const nameOf = (k: Kind, id: string) => {
      const key = `${k}:${id}`;
      if (!names.has(key))
        names.set(
          key,
          (db.prepare(`SELECT name FROM ${k === "host" ? "hosts" : "clusters"} WHERE id = ?`).get(id) as { name: string } | undefined)?.name ?? id,
        );
      return names.get(key)!;
    };
    const page = rows.slice(0, filter.limit);
    return {
      changes: page.map((r) => ({
        id: r.id,
        target: { kind: r.target_kind, id: r.target_id, name: nameOf(r.target_kind, r.target_id) },
        at: r.at,
        category: r.category,
        item: r.item,
        change: r.kind,
        before: r.before,
        after: r.after,
      })),
      ...(rows.length > filter.limit && { nextCursor: String(page.at(-1)!.id) }),
    };
  }

  function containers() {
    const rows = db.prepare("SELECT id, name, latest_facts FROM hosts WHERE latest_facts IS NOT NULL ORDER BY name").all() as Array<{
      id: string;
      name: string;
      latest_facts: Uint8Array;
    }>;
    return rows.flatMap((r) => (unpack<Facts>(r.latest_facts).containers ?? []).map((c) => ({ host: { id: r.id, name: r.name }, ...c })));
  }

  function summary() {
    const count = (rows: Array<{ status: string; n: number }>) => Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
    const agents = (db.prepare("SELECT * FROM agents").all() as unknown as AgentRow[]).map(toAgent);
    return {
      agents: Object.fromEntries([...new Set(agents.map((a) => a.status))].map((s) => [s, agents.filter((a) => a.status === s).length])) as Record<
        string,
        number
      >,
      hosts: count(db.prepare("SELECT status, COUNT(*) AS n FROM hosts GROUP BY status").all() as Array<{ status: string; n: number }>),
      clusters: count(db.prepare("SELECT status, COUNT(*) AS n FROM clusters GROUP BY status").all() as Array<{ status: string; n: number }>),
      containers: containers().length,
      changesLastDay: (db.prepare("SELECT COUNT(*) AS n FROM changes WHERE at >= ?").get(iso(now() - 86_400_000)) as { n: number }).n,
      changeDays: changeDays(),
    };
  }

  /** Changes on each of the last 14 days (UTC), by kind, oldest first. */
  function changeDays() {
    const DAY = 86_400_000;
    const today = Math.floor(now() / DAY) * DAY;
    const days = Array.from({ length: 14 }, (_, i) => ({ day: iso(today - (13 - i) * DAY).slice(0, 10), added: 0, removed: 0, changed: 0 }));
    const at = new Map(days.map((d) => [d.day, d]));
    for (const r of db.prepare("SELECT substr(at, 1, 10) AS d, kind, COUNT(*) AS n FROM changes WHERE at >= ? GROUP BY d, kind").all(days[0]!.day) as Array<{
      d: string;
      kind: "added" | "removed" | "changed";
      n: number;
    }>) {
      const d = at.get(r.d);
      if (d) d[r.kind] = r.n;
    }
    return days;
  }

  /** Deletes changes and snapshots older than the retention, keeping the newest snapshot of every target. */
  function purge(days: number) {
    const before = iso(now() - days * 86_400_000);
    db.prepare("DELETE FROM changes WHERE at < ?").run(before);
    db.prepare("DELETE FROM snapshots WHERE collected_at < ? AND id NOT IN (SELECT MAX(id) FROM snapshots GROUP BY target_kind, target_id)").run(before);
  }

  return {
    listAgents: () => (db.prepare("SELECT * FROM agents ORDER BY name").all() as unknown as AgentRow[]).map(toAgent),
    agent: (id: string) => toAgent(requireAgent(id)),
    createAgent,
    reEnroll,
    deleteAgent,
    agentSetup,
    enroll,
    agentBySecret,
    work,
    result,
    kubernetesRbac: () => RBAC,
    listHosts: () => (db.prepare("SELECT * FROM hosts ORDER BY name").all() as unknown as HostRow[]).map(toHost),
    host: (id: string) => toHost(requireHost(id)),
    deleteHost,
    syncFile,
    requestHostKey,
    acceptHostKey,
    hostFacts,
    listClusters: () => (db.prepare("SELECT * FROM clusters ORDER BY name").all() as unknown as ClusterRow[]).map(toCluster),
    cluster: (id: string) => toCluster(requireCluster(id)),
    createCluster,
    updateCluster,
    deleteCluster,
    clusterFacts,
    requestCollect,
    tick,
    changes,
    containers,
    summary,
    purge,
  };
}

export type Infra = ReturnType<typeof createInfra>;

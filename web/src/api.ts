// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json and server/facts.ts.
import type { BmcFacts, Container, Facts } from "../../server/facts.ts";
import type { ClusterFacts } from "../../server/k8s.ts";
import type { ProductLink } from "../../server/products.ts";

export type { BmcFacts, Container, Facts, ClusterFacts, ProductLink };

export interface HostKey {
  type: string;
  fingerprint: string;
}

export interface HostSummary {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  virtualization: string | null;
  uptimeSec: number;
  load: number[];
  cpuThreads: number;
  memoryTotalKb: number;
  memoryAvailableKb: number;
  fullestDisk: { mount: string; pct: number } | null;
  packages: number;
  listeningPorts: number | null;
  processes: number;
  containers: number | null;
  unreadable: string[];
}

export interface Agent {
  id: string;
  name: string;
  status: "waiting-to-enrol" | "online" | "offline" | "version-mismatch";
  version: string | null;
  caFingerprint: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  hosts: number;
  bmcs: number;
  createdAt: string;
}

export interface NewAgent {
  agent: Agent;
  enrollToken: string;
  enrollExpiresAt: string;
}

export interface AgentSetup {
  agent: Agent;
  caPublicKey: string;
  caFingerprint: string;
  keyPublicKey: string | null;
  sshdConfig: string;
  sudoers: string;
  hostSetup: string;
  authorizedKey: string;
}

export interface Host {
  id: string;
  name: string;
  agent: { id: string; name: string };
  address: string;
  port: number;
  user: string;
  auth: "certificate" | "key";
  jumpHost: { id: string; name: string } | null;
  /** file: from the hosts file (OPENASY_HOSTS); changed there, not here. */
  source: "ui" | "file";
  /** The fingerprint the hosts file trusts for this host. */
  fileHostKey: string | null;
  containers: boolean;
  intervalMinutes: number;
  tags: Record<string, string>;
  hostKeys: HostKey[];
  pendingHostKeys: HostKey[];
  status: string;
  statusDetail: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  summary: HostSummary | null;
  /** When its packages last reached Vulnerabilities; null when Infrastructure does not send them. */
  vulnerabilities: { sentAt: string | null; error: string | null; assetId: string | null } | null;
  /** Its management controller, when a BMC in the hosts file names this host as its server. */
  bmc: {
    id: string;
    name: string;
    match: MatchState;
    health: string | null;
    unhealthy: number | null;
    powerState: string | null;
  } | null;
}

/** A server's management controller, read over Redfish (ADR 0055). */
/** Whether a host and a BMC say they are one machine (ADR 0055). */
export type MatchState = "confirmed" | "mismatch" | "unverified" | "found";
export interface Match {
  host: { id: string; name: string } | null;
  state: MatchState;
  by: "uuid" | "serial" | null;
  detail: string | null;
}

/** The host as its BMC sees it. */
export interface HostHardware {
  bmc: Bmc;
  match: Match;
  parts: Array<{ kind: string; name: string; health: string | null }>;
  reboots: Array<{ at: string; events: BmcFacts["events"] }>;
}

export interface Bmc {
  id: string;
  name: string;
  agent: { id: string; name: string };
  address: string;
  port: number;
  user: string;
  passwordFile: string;
  server: { name: string; id: string | null } | null;
  match: Match | null;
  fileCertificate: string | null;
  intervalMinutes: number;
  tags: Record<string, string>;
  certificates: Array<{ fingerprint: string }>;
  pendingCertificate: { fingerprint: string; subject: string; issuer: string; validTo: string } | null;
  status: string;
  statusDetail: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  summary: {
    vendor: string | null;
    model: string | null;
    serial: string | null;
    sku: string | null;
    powerState: string | null;
    health: string | null;
    biosVersion: string | null;
    bmcFirmware: string | null;
    unhealthy: number;
    services: string[];
    accounts: number | null;
    administrators: number | null;
    unreadable: string[];
  } | null;
}

export interface Cluster {
  id: string;
  name: string;
  server: string;
  intervalMinutes: number;
  tags: Record<string, string>;
  status: string;
  statusDetail: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  summary: {
    version: string;
    nodes: number;
    nodesReady: number;
    namespaces: number;
    workloads: number;
    pods: number;
    podsNotRunning: number;
    restarts: number;
    warnings: number;
  } | null;
}

export interface Change {
  id: number;
  target: { kind: "host" | "cluster" | "bmc"; id: string; name: string };
  at: string;
  category: string;
  item: string;
  change: "added" | "removed" | "changed";
  before: string | null;
  after: string | null;
}

export interface Setup {
  kubernetesRbac: string;
}

export interface Summary {
  agents: Record<string, number>;
  hosts: Record<string, number>;
  clusters: Record<string, number>;
  bmcs: Record<string, number>;
  containers: number;
  changesLastDay: number;
  hostsFile: HostsFile | null;
  /** Changes on each of the last 14 days (UTC), by kind, oldest first. */
  changeDays: Array<{ day: string; added: number; removed: number; changed: number }>;
}

/** The hosts file (ADR 0052): a file that cannot be applied leaves the hosts from its last good version. */
export interface HostsFile {
  path: string;
  appliedAt: string | null;
  entries: number;
  error: string | null;
  warnings: string[];
}

export class Unauthorized extends Error {}
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

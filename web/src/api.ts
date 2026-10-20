// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json and server/facts.ts.
import type { Container, Facts } from "../../server/facts.ts";
import type { ClusterFacts } from "../../server/k8s.ts";

export type { Container, Facts, ClusterFacts };

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
  summary: { version: string; nodes: number; nodesReady: number; namespaces: number; workloads: number; pods: number; podsNotRunning: number; restarts: number; warnings: number } | null;
}

export interface Change {
  id: number;
  target: { kind: "host" | "cluster"; id: string; name: string };
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
  containers: number;
  changesLastDay: number;
}

export class Unauthorized extends Error {}
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

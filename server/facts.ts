// What infra-agent reads from a host. The agent parses and masks it (infra-agent agent/facts.ts, the same shapes);
// Infrastructure receives it, checks its shape and stores it (ADR 0031).

export interface Port {
  proto: "tcp" | "udp";
  address: string;
  port: number;
  process: string | null;
  pid: number | null;
}
export interface Proc {
  pid: number;
  ppid: number;
  user: string;
  cpu: number;
  rssKb: number;
  ageSec: number;
  name: string;
  command: string;
}
export interface Service {
  name: string;
  load: string;
  active: string;
  sub: string;
  enabled: string | null;
}
export interface User {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  login: boolean;
  password: "set" | "locked" | "none" | null;
}
export interface Container {
  engine: "docker" | "podman";
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  health: string | null;
  createdAt: string;
  startedAt: string | null;
  restarts: number;
  restartPolicy: string | null;
  command: string;
  ports: string[];
  mounts: Array<{ source: string; destination: string; mode: string; readOnly: boolean }>;
  networks: string[];
  labels: Record<string, string>;
  envNames: string[];
  memoryLimitBytes: number | null;
  cpuLimit: number | null;
  privileged: boolean;
  user: string;
}

export interface Facts {
  collectedAt: string;
  account: { user: string; uid: number; sudo: "all" | "rules" };
  system: {
    hostname: string;
    machineId: string | null;
    os: { id: string; name: string; version: string | null };
    kernel: string;
    arch: string;
    bootedAt: string;
    uptimeSec: number;
    load: [number, number, number];
    virtualization: string | null;
    hardware: Record<string, string>;
    serial: string | null;
  };
  cpu: { model: string | null; threads: number; cores: number | null };
  memory: { totalKb: number; availableKb: number; swapTotalKb: number; swapFreeKb: number };
  disks: Array<{ name: string; type: string; sizeBytes: number; model: string | null; rotational: boolean | null }>;
  filesystems: Array<{ device: string; mount: string; type: string; sizeKb: number; usedKb: number; options: string }>;
  interfaces: Array<{ name: string; state: string; mac: string | null; mtu: number | null; addresses: string[] }>;
  routes: Array<{ destination: string; gateway: string | null; device: string | null }>;
  dns: { nameservers: string[]; search: string[] };
  ports: Port[] | null;
  processes: Proc[];
  services: Service[] | null;
  timers: Array<{ unit: string; activates: string; next: string | null }> | null;
  cron: Array<{ source: string; entry: string }>;
  crontabUsers: string[] | null;
  users: User[];
  groups: Array<{ name: string; gid: number; members: string[] }>;
  sudo: string[] | null;
  authorizedKeys: Array<{ file: string; user: string; bits: number; fingerprint: string; comment: string; type: string }> | null;
  sshd: Record<string, string> | null;
  modules: string[];
  sysctl: Record<string, string>;
  firewall: { tool: "nftables" | "iptables"; rules: string } | null;
  packages: Array<{ manager: "dpkg" | "rpm" | "apk"; name: string; version: string; arch: string | null }>;
  containers: Container[] | null;
  /** What could not be read without the sudo rules (or the container switch): shown as "not readable". */
  unreadable: string[];
}

/** Checks that what an agent sent looks like facts before anything is stored. The agent is not trusted blindly. */
export function checkFacts(v: unknown): Facts {
  const f = v as Partial<Facts> | null;
  const arrays = ["filesystems", "interfaces", "routes", "processes", "cron", "users", "groups", "modules", "packages", "unreadable", "disks"] as const;
  if (!f || typeof f !== "object") throw new Error("facts must be an object");
  if (typeof f.collectedAt !== "string" || Number.isNaN(Date.parse(f.collectedAt))) throw new Error("facts.collectedAt must be a date");
  if (!f.system || typeof f.system !== "object" || typeof f.system.hostname !== "string" || !f.system.os || typeof f.system.uptimeSec !== "number")
    throw new Error("facts.system is incomplete");
  if (!f.cpu || !f.memory || !f.account || !f.dns || typeof f.sysctl !== "object") throw new Error("facts is incomplete");
  for (const a of arrays) if (!Array.isArray(f[a])) throw new Error(`facts.${a} must be a list`);
  for (const a of ["ports", "services", "timers", "crontabUsers", "sudo", "authorizedKeys", "containers"] as const)
    if (f[a] !== null && !Array.isArray(f[a])) throw new Error(`facts.${a} must be a list or null`);
  return f as Facts;
}

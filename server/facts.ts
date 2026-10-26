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
    /** The SMBIOS UUID, with the sudo rules; an older agent sends none. */
    uuid?: string | null;
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
  /** source is the package it was built from (deb source, src.rpm, apk origin); epoch is rpm's. An older agent sends neither. */
  packages: Array<{
    manager: "dpkg" | "rpm" | "apk";
    name: string;
    version: string;
    arch: string | null;
    source?: string | null;
    sourceVersion?: string | null;
    epoch?: number | null;
  }>;
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

/** What infra-agent reads from a BMC over Redfish (infra-agent agent/bmc.ts, the same shape; ADR 0055). */
export interface BmcFacts {
  collectedAt: string;
  service: { vendor: string | null; product: string | null; redfishVersion: string; uuid: string | null };
  systems: Array<{
    id: string;
    manufacturer: string | null;
    model: string | null;
    serial: string | null;
    sku: string | null;
    biosVersion: string | null;
    powerState: string | null;
    health: string | null;
    hostName: string | null;
    uuid: string | null;
    processors: { count: number | null; model: string | null };
    memoryGiB: number | null;
  }>;
  chassis: Array<{
    id: string;
    name: string | null;
    model: string | null;
    serial: string | null;
    health: string | null;
    powerWatts: number | null;
    powerSupplies: Array<{
      name: string;
      model: string | null;
      serial: string | null;
      firmware: string | null;
      capacityWatts: number | null;
      health: string | null;
    }>;
    fans: Array<{ name: string; reading: number | null; units: string | null; health: string | null }>;
    temperatures: Array<{ name: string; celsius: number | null; criticalCelsius: number | null; health: string | null }>;
  }>;
  managers: Array<{
    id: string;
    model: string | null;
    type: string | null;
    firmware: string | null;
    health: string | null;
    protocols: Array<{ name: string; enabled: boolean; port: number | null }> | null;
  }>;
  firmware: Array<{ id: string; name: string | null; version: string | null; updateable: boolean | null }>;
  storage: Array<{
    system: string;
    id: string;
    controllers: Array<{ name: string; model: string | null; firmware: string | null; health: string | null }>;
    drives: Array<{
      id: string;
      name: string | null;
      model: string | null;
      serial: string | null;
      capacityBytes: number | null;
      media: string | null;
      protocol: string | null;
      health: string | null;
      lifeLeftPercent: number | null;
    }>;
  }>;
  accounts: Array<{ user: string; role: string | null; enabled: boolean | null; locked: boolean | null }> | null;
  events: Array<{ log: string; id: string | null; at: string | null; severity: string | null; message: string | null }>;
  unreadable: string[];
}

/** Checks that what an agent sent looks like a BMC's facts before anything is stored. */
export function checkBmcFacts(v: unknown): BmcFacts {
  const f = v as Partial<BmcFacts> | null;
  if (!f || typeof f !== "object") throw new Error("facts must be an object");
  if (typeof f.collectedAt !== "string" || Number.isNaN(Date.parse(f.collectedAt))) throw new Error("facts.collectedAt must be a date");
  if (!f.service || typeof f.service !== "object" || typeof f.service.redfishVersion !== "string") throw new Error("facts.service is incomplete");
  for (const a of ["systems", "chassis", "managers", "firmware", "storage", "events", "unreadable"] as const)
    if (!Array.isArray(f[a])) throw new Error(`facts.${a} must be a list`);
  if (f.accounts !== null && !Array.isArray(f.accounts)) throw new Error("facts.accounts must be a list or null");
  const named = (list: unknown[], key: string) => list.every((x) => x && typeof x === "object" && typeof (x as Record<string, unknown>)[key] === "string");
  if (!named(f.systems!, "id") || !named(f.chassis!, "id") || !named(f.managers!, "id") || !named(f.firmware!, "id") || !named(f.storage!, "id"))
    throw new Error("facts: every system, chassis, manager, firmware and storage entry has an id");
  if (f.accounts && !named(f.accounts, "user")) throw new Error("facts.accounts: every account has a user");
  for (const c of f.chassis!) {
    if (!Array.isArray(c.powerSupplies) || !Array.isArray(c.fans) || !Array.isArray(c.temperatures))
      throw new Error("facts.chassis: powerSupplies, fans and temperatures are lists");
  }
  for (const s of f.storage!) if (!Array.isArray(s.controllers) || !Array.isArray(s.drives)) throw new Error("facts.storage: controllers and drives are lists");
  return f as BmcFacts;
}

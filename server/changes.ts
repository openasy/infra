// What changed between two collections. Facts become items (category, key, value); the timeline is the items that
// were added, removed or changed. Values that move all the time (CPU, memory in use, PIDs, uptime) are not items,
// so the timeline shows decisions and events, not noise.
import { createHash } from "node:crypto";
import type { BmcFacts, Facts } from "./facts.ts";

export type Category =
  | "system"
  | "package"
  | "port"
  | "service"
  | "timer"
  | "cron"
  | "user"
  | "group"
  | "sudo"
  | "ssh-key"
  | "sshd"
  | "kernel-module"
  | "sysctl"
  | "firewall"
  | "filesystem"
  | "interface"
  | "route"
  | "process"
  | "container"
  // A BMC's (ADR 0055).
  | "hardware"
  | "firmware"
  | "power"
  | "health"
  | "drive"
  | "bmc-account"
  | "bmc-service";

export interface Item {
  category: Category;
  key: string;
  value: string;
}

export interface Change {
  category: Category;
  key: string;
  kind: "added" | "removed" | "changed";
  before: string | null;
  after: string | null;
}

/** Long-running processes only: a process younger than this is too short-lived to be a change worth showing. */
const PROCESS_MIN_AGE_SEC = 600;

export function hostItems(f: Facts): Item[] {
  const out: Item[] = [];
  const add = (category: Category, key: string, value: unknown) =>
    out.push({ category, key, value: typeof value === "string" ? value : JSON.stringify(value) });

  add("system", "os", f.system.os.name);
  add("system", "kernel", f.system.kernel);
  add("system", "hostname", f.system.hostname);
  add("system", "cpu", `${f.cpu.threads} × ${f.cpu.model ?? "?"}`);
  add("system", "memory", `${Math.round(f.memory.totalKb / 1024)} MiB`);
  // A reboot shows as a change of boot time; rounded so clock drift between collections is not one.
  add("system", "booted", new Date(Math.round(Date.parse(f.system.bootedAt) / 300_000) * 300_000).toISOString());
  if (f.system.serial) add("system", "serial", f.system.serial);
  if (f.account.sudo === "all") add("system", "collector sudo", "unrestricted");

  for (const p of f.packages) add("package", `${p.manager}:${p.name}${p.arch ? `:${p.arch}` : ""}`, p.version);
  for (const p of f.ports ?? []) add("port", `${p.proto}/${p.address}:${p.port}`, p.process ?? "");
  for (const s of f.services ?? []) add("service", s.name, `${s.active}/${s.sub}${s.enabled ? `, ${s.enabled}` : ""}`);
  for (const t of f.timers ?? []) add("timer", t.unit, t.activates);
  for (const c of f.cron) add("cron", `${c.source}: ${c.entry}`, "present");
  for (const u of f.crontabUsers ?? []) add("cron", `crontab of ${u}`, "present");
  for (const u of f.users) add("user", u.name, { uid: u.uid, gid: u.gid, home: u.home, shell: u.shell, ...(u.password && { password: u.password }) });
  for (const g of f.groups) add("group", g.name, g.members.join(",") || "-");
  for (const s of f.sudo ?? []) add("sudo", s, "present");
  for (const k of f.authorizedKeys ?? []) add("ssh-key", `${k.user} ${k.fingerprint}`, `${k.type} ${k.comment}`);
  for (const [k, v] of Object.entries(f.sshd ?? {})) add("sshd", k, v);
  for (const m of f.modules) add("kernel-module", m, "loaded");
  for (const [k, v] of Object.entries(f.sysctl)) add("sysctl", k, v);
  if (f.firewall) add("firewall", f.firewall.tool, f.firewall.rules);
  for (const fs of f.filesystems) add("filesystem", fs.mount, `${fs.device} ${fs.type} ${Math.round(fs.sizeKb / 1024)} MiB`);
  for (const i of f.interfaces) add("interface", i.name, `${i.addresses.join(" ") || "-"}${i.mac ? ` ${i.mac}` : ""}`);
  for (const r of f.routes) add("route", `${r.destination} via ${r.gateway ?? "-"} dev ${r.device ?? "-"}`, "present");
  // Kernel threads have no command line of their own ([kworker/0:1]); they are not processes people start.
  const procs = new Set(f.processes.filter((p) => p.ageSec >= PROCESS_MIN_AGE_SEC && !/^\[.*\]$/.test(p.command)).map((p) => `${p.user} ${p.command}`));
  for (const p of procs) add("process", p, "running");
  for (const c of f.containers ?? [])
    add("container", `${c.engine}:${c.name}`, {
      image: c.image,
      imageId: c.imageId.slice(0, 19),
      state: c.state,
      restarts: c.restarts,
      ports: c.ports,
      privileged: c.privileged,
    });
  return out;
}

/**
 * A BMC's items: what the machine is, its firmware, the health of its parts, who may manage it and which services the
 * BMC opens. Readings (temperatures, fan speeds, watts) and the event log move all the time and are not items; a part
 * that turns Warning or Critical is.
 */
export function bmcItems(f: BmcFacts): Item[] {
  const out: Item[] = [];
  const add = (category: Category, key: string, value: unknown) => {
    if (value === null || value === undefined) return;
    out.push({ category, key, value: typeof value === "string" ? value : JSON.stringify(value) });
  };
  for (const s of f.systems) {
    add("hardware", `system ${s.id}`, {
      manufacturer: s.manufacturer,
      model: s.model,
      serial: s.serial,
      sku: s.sku,
      cpu: `${s.processors.count ?? "?"} × ${s.processors.model ?? "?"}`,
      memoryGiB: s.memoryGiB,
    });
    add("firmware", `BIOS of ${s.id}`, s.biosVersion);
    add("power", s.id, s.powerState);
    add("health", `system ${s.id}`, s.health);
  }
  for (const c of f.chassis) {
    add("health", `chassis ${c.id}`, c.health);
    for (const p of c.powerSupplies) {
      add("hardware", `power supply ${c.id}/${p.name}`, { model: p.model, serial: p.serial, capacityWatts: p.capacityWatts });
      add("health", `power supply ${c.id}/${p.name}`, p.health);
    }
    for (const x of c.fans) add("health", `fan ${c.id}/${x.name}`, x.health);
    for (const x of c.temperatures) add("health", `temperature ${c.id}/${x.name}`, x.health);
  }
  for (const m of f.managers) {
    add("firmware", `BMC ${m.id}`, m.firmware);
    add("health", `BMC ${m.id}`, m.health);
    for (const p of m.protocols ?? []) add("bmc-service", p.name, p.enabled ? `enabled${p.port !== null ? `, port ${p.port}` : ""}` : "disabled");
  }
  // By name, which stays the same across an update; two of the same name are told apart by their order.
  const names = new Map<string, number>();
  for (const x of f.firmware) {
    const name = x.name ?? x.id;
    const n = (names.get(name) ?? 0) + 1;
    names.set(name, n);
    add("firmware", n > 1 ? `${name} #${n}` : name, x.version ?? "?");
  }
  for (const st of f.storage) {
    for (const c of st.controllers) add("health", `controller ${st.id}/${c.name}`, c.health);
    for (const d of st.drives) {
      add("drive", `${st.id}/${d.id}`, { model: d.model, serial: d.serial, capacityBytes: d.capacityBytes, media: d.media });
      add("health", `drive ${d.name ?? d.id}`, d.health);
    }
  }
  for (const a of f.accounts ?? []) add("bmc-account", a.user, { role: a.role, enabled: a.enabled, locked: a.locked });
  return out;
}

export function diff(before: Item[], after: Item[]): Change[] {
  const k = (i: Item) => `${i.category}\u0000${i.key}`;
  const old = new Map(before.map((i) => [k(i), i]));
  const now = new Map(after.map((i) => [k(i), i]));
  const out: Change[] = [];
  for (const [key, i] of now) {
    const o = old.get(key);
    if (!o) out.push({ category: i.category, key: i.key, kind: "added", before: null, after: i.value });
    else if (o.value !== i.value) out.push({ category: i.category, key: i.key, kind: "changed", before: o.value, after: i.value });
  }
  for (const [key, o] of old) if (!now.has(key)) out.push({ category: o.category, key: o.key, kind: "removed", before: o.value, after: null });
  return out;
}

/** A stable fingerprint of the items, to skip storing a snapshot when nothing changed. */
export function itemsHash(items: Item[]): string {
  const lines = items.map((i) => `${i.category}\u0000${i.key}\u0000${i.value}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

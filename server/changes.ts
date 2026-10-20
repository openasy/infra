// What changed between two collections. Facts become items (category, key, value); the timeline is the items that
// were added, removed or changed. Values that move all the time (CPU, memory in use, PIDs, uptime) are not items,
// so the timeline shows decisions and events, not noise.
import { createHash } from "node:crypto";
import type { Facts } from "./facts.ts";

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
  | "container";

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
  const add = (category: Category, key: string, value: unknown) => out.push({ category, key, value: typeof value === "string" ? value : JSON.stringify(value) });

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
    add("container", `${c.engine}:${c.name}`, { image: c.image, imageId: c.imageId.slice(0, 19), state: c.state, restarts: c.restarts, ports: c.ports, privileged: c.privileged });
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

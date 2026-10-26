// A host and its BMC, read apart, put together (ADR 0055). The operating system and the BMC each say which machine
// they are on: the SMBIOS UUID and the serial number or service tag. Agreeing, they confirm the hosts file's server:;
// disagreeing, they say it names the wrong machine; and a BMC the file gives no server is matched by them. A reboot
// the host reports is then shown next to what the BMC logged around it.
import type { BmcFacts, Facts } from "./facts.ts";

/** What a host says about the machine it runs on. */
export interface HostHardware {
  serial: string | null;
  uuid: string | null;
}

/** What a BMC says about its machine, and how it is, kept small for lists. */
export interface BmcHardware {
  serials: string[];
  uuids: string[];
  health: string | null;
  unhealthy: number;
  powerState: string | null;
}

export type MatchState = "confirmed" | "mismatch" | "unverified" | "found";

export interface Match {
  host: { id: string; name: string } | null;
  /** confirmed: the file's server is this machine; mismatch: it is not; unverified: nothing to compare yet; found: matched without server:. */
  state: MatchState;
  by: "uuid" | "serial" | null;
  detail: string | null;
}

// What boards say when nobody filled the field in.
const PLACEHOLDER = /^(|0+|not specified|not available|none|default string|to be filled by o\.?e\.?m\.?|system serial number|serial number|0123456789|n\/a)$/i;
const serialOf = (v: string | null | undefined) => {
  const s = v?.trim().toUpperCase() ?? "";
  return PLACEHOLDER.test(s) ? null : s;
};
const uuidOf = (v: string | null | undefined) => {
  const u = v?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u) && !/^(0|-)+$|^(f|-)+$/.test(u) ? u : null;
};

export function hostHardware(f: Facts): HostHardware {
  return { serial: serialOf(f.system.serial), uuid: uuidOf(f.system.uuid) };
}

export function bmcHardware(f: BmcFacts): BmcHardware {
  const parts = [...f.chassis.flatMap((c) => [...c.powerSupplies, ...c.fans, ...c.temperatures]), ...f.storage.flatMap((s) => [...s.controllers, ...s.drives])];
  const system = f.systems[0];
  return {
    // Dell's DMI serial is the service tag, which Redfish calls SKU; HPE and Lenovo use the serial in both.
    serials: [...new Set([...f.systems.flatMap((s) => [s.serial, s.sku]), ...f.chassis.map((c) => c.serial)].map(serialOf).filter((s): s is string => !!s))],
    uuids: [...new Set(f.systems.map((s) => uuidOf(s.uuid)).filter((u): u is string => !!u))],
    health: system?.health ?? f.chassis[0]?.health ?? null,
    unhealthy: parts.filter((p) => p.health === "Warning" || p.health === "Critical").length,
    powerState: system?.powerState ?? null,
  };
}

const agree = (h: HostHardware, b: BmcHardware): "uuid" | "serial" | null =>
  h.uuid && b.uuids.includes(h.uuid) ? "uuid" : h.serial && b.serials.includes(h.serial) ? "serial" : null;

/**
 * Each BMC's host. A UUID that differs is a mismatch even when a serial agrees, since boards share serials more often
 * than UUIDs; a mismatch also says which host the BMC does match, when one does.
 */
export function matchBmcs(
  bmcs: Array<{ id: string; server: string | null; hardware: BmcHardware | null }>,
  hosts: Array<{ id: string; name: string; hardware: HostHardware | null }>,
): Map<string, Match> {
  const out = new Map<string, Match>();
  for (const b of bmcs) {
    const named = b.server ? hosts.find((h) => h.name === b.server) : undefined;
    const elsewhere = b.hardware ? hosts.find((h) => h !== named && h.hardware && agree(h.hardware, b.hardware!)) : undefined;
    if (!named) {
      if (elsewhere)
        out.set(b.id, { host: { id: elsewhere.id, name: elsewhere.name }, state: "found", by: agree(elsewhere.hardware!, b.hardware!), detail: null });
      continue;
    }
    const host = { id: named.id, name: named.name };
    const h = named.hardware;
    if (!h || !b.hardware) {
      out.set(b.id, { host, state: "unverified", by: null, detail: null });
      continue;
    }
    const uuidDiffers = !!h.uuid && b.hardware.uuids.length > 0 && !b.hardware.uuids.includes(h.uuid);
    const serialDiffers = !!h.serial && b.hardware.serials.length > 0 && !b.hardware.serials.includes(h.serial);
    const by = agree(h, b.hardware);
    if (by && !uuidDiffers) {
      out.set(b.id, { host, state: "confirmed", by, detail: null });
      continue;
    }
    if (!uuidDiffers && !serialDiffers) {
      out.set(b.id, { host, state: "unverified", by: null, detail: null });
      continue;
    }
    const said = uuidDiffers
      ? `${named.name} has UUID ${h.uuid}; the BMC reports ${b.hardware.uuids.join(", ")}.`
      : `${named.name} has serial ${h.serial}; the BMC reports ${b.hardware.serials.join(", ")}.`;
    out.set(b.id, { host, state: "mismatch", by: null, detail: elsewhere ? `${said} It matches ${elsewhere.name}.` : said });
  }
  return out;
}

export interface Reboot {
  /** When the host booted, as it reported it (to five minutes for earlier boots). */
  at: string;
  /** What the BMC logged from 30 minutes before to 5 minutes after: a lost power supply, a watchdog, a reset. */
  events: BmcFacts["events"];
}

const BEFORE_MS = 30 * 60_000;
const AFTER_MS = 5 * 60_000;

/** The host's boots, newest first, each with the BMC's events around it. The exact boot time comes first in `boots`. */
export function reboots(boots: string[], events: BmcFacts["events"], limit = 10): Reboot[] {
  const seen = new Set<number>();
  const times = boots
    .map((b) => Date.parse(b))
    .filter((t) => Number.isFinite(t))
    .filter((t) => {
      // A boot time rounded to five minutes and the exact one are the same boot.
      const key = Math.round(t / 300_000);
      if (seen.has(key) || seen.has(key - 1) || seen.has(key + 1)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b - a)
    .slice(0, limit);
  return times.map((t) => ({
    at: new Date(t).toISOString(),
    events: events.filter((e) => {
      const at = Date.parse(e.at ?? "");
      return Number.isFinite(at) && at >= t - BEFORE_MS && at <= t + AFTER_MS;
    }),
  }));
}

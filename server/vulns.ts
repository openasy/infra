// Sends the packages of every host Infrastructure reads to OpenAsy Vulnerabilities as a CycloneDX SBOM, so those hosts
// need no vulns-agent (ADR 0031, 0052). Vulnerabilities takes it with its ingest token, under the host's name in the
// hosts file, and matches it again whenever its vulnerability data changes. An SBOM is sent when the packages change,
// and once a day to say the host is still there. One that cannot be sent is tried again every few minutes.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import type { Facts } from "./facts.ts";

/** A host whose packages have not changed is sent again after this long, so Vulnerabilities never sees it as gone. */
const RESEND_MS = 24 * 3_600_000;
/** After a failure, the next try waits this long. */
const RETRY_MS = 5 * 60_000;

const TYPE = { dpkg: "deb", rpm: "rpm", apk: "apk" } as const;

/** A purl qualifier value, percent-encoded as the purl spec says; keys sorted, empty values left out. */
function purl(type: string, namespace: string, name: string, version: string, q: Record<string, string | null | undefined>) {
  const enc = (v: string) => encodeURIComponent(v).replace(/%3A/g, ":");
  const qs = Object.entries(q)
    .filter((e): e is [string, string] => !!e[1])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${enc(v)}`)
    .join("&");
  return `pkg:${type}/${enc(namespace)}/${enc(name)}@${enc(version)}${qs ? `?${qs}` : ""}`;
}

/**
 * The host's OS packages as CycloneDX 1.6, with what Grype needs to match them as a scan on the host would: the
 * distribution in each purl, and the source package (deb source, src.rpm, apk origin) as `upstream`.
 */
export function hostSbom(name: string, f: Facts, version: string) {
  const os = f.system.os;
  const distro = os.id && os.version ? `${os.id}-${os.version}` : undefined;
  const components = f.packages.map((p) => {
    const upstream =
      p.manager === "dpkg"
        ? p.source && (p.source !== p.name || (p.sourceVersion && p.sourceVersion !== p.version))
          ? p.sourceVersion && p.sourceVersion !== p.version
            ? `${p.source}@${p.sourceVersion}`
            : p.source
          : null
        : (p.source ?? null);
    const ref = purl(TYPE[p.manager], os.id || "unknown", p.name, p.version, {
      arch: p.arch,
      distro,
      epoch: p.manager === "rpm" && p.epoch ? String(p.epoch) : null,
      upstream,
    });
    return { type: "library", "bom-ref": ref, name: p.name, version: p.version, purl: ref };
  });
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: f.collectedAt,
      tools: { components: [{ type: "application", name: "OpenAsy Infrastructure", version }] },
      component: { type: "device", "bom-ref": `host:${name}`, name },
    },
    components: [
      { type: "operating-system", "bom-ref": `os:${os.id}`, name: os.id, ...(os.version && { version: os.version }), description: os.name },
      ...components,
    ],
  };
}

/** What is sent changes only when the OS or a package does. */
const hashOf = (f: Facts) =>
  createHash("sha256")
    .update(JSON.stringify([f.system.os, f.packages.map((p) => [p.manager, p.name, p.version, p.arch, p.source, p.sourceVersion, p.epoch])]))
    .digest("hex");

export interface VulnsLinkOptions {
  db: DatabaseSync;
  /** Where Infrastructure calls Vulnerabilities, such as http://vulns:8080 in the same compose network. */
  url: string;
  /** Vulnerabilities' VULNS_INGEST_TOKEN, or an API token of it with the editor role. */
  token: string;
  version: string;
  log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  /** For tests: the HTTP client. */
  fetch?: typeof fetch;
}

interface SendRow {
  host_id: string;
  hash: string | null;
  due: number;
  sent_at: string | null;
  attempt_at: string | null;
  error: string | null;
  asset_id: string | null;
}

export function createVulnsLink(o: VulnsLinkOptions) {
  const http = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const base = o.url.replace(/\/$/, "");
  let delivering: Promise<void> | undefined;

  /** Notes a collection: due when the packages changed or the last SBOM is a day old. */
  function collected(hostId: string, f: Facts) {
    const hash = hashOf(f);
    const r = o.db.prepare("SELECT * FROM vulns_sends WHERE host_id = ?").get(hostId) as SendRow | undefined;
    const stale = !r?.sent_at || now() - Date.parse(r.sent_at) >= RESEND_MS;
    if (r && r.hash === hash && !stale) return;
    o.db
      .prepare(
        `INSERT INTO vulns_sends (host_id, hash, due) VALUES (?, ?, 1)
         ON CONFLICT (host_id) DO UPDATE SET hash = excluded.hash, due = 1`,
      )
      .run(hostId, hash);
  }

  async function send(r: SendRow & { name: string; latest_facts: Uint8Array | null }) {
    // The host's last collection, as it is now: a host collected again since it was due sends its newest packages.
    if (!r.latest_facts) return o.db.prepare("UPDATE vulns_sends SET due = 0 WHERE host_id = ?").run(r.host_id);
    const f = JSON.parse(gunzipSync(r.latest_facts).toString("utf8")) as Facts;
    const at = new Date(now()).toISOString();
    try {
      const res = await http(`${base}/api/v1/sboms?kind=host&name=${encodeURIComponent(r.name)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json", "user-agent": `openasy-infra/${o.version}` },
        body: JSON.stringify(hostSbom(r.name, f, o.version)),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const detail = ((await res.json().catch(() => ({}))) as { detail?: unknown }).detail;
        throw new Error(
          res.status === 401
            ? "Vulnerabilities refused the token: set INFRA_VULNS_TOKEN to its VULNS_INGEST_TOKEN."
            : res.status === 403
              ? "The token may not send SBOMs: it needs the editor role in Vulnerabilities."
              : `Vulnerabilities answered ${res.status}${typeof detail === "string" ? `: ${detail}` : "."}`,
        );
      }
      const asset = (await res.json().catch(() => ({}))) as { id?: unknown };
      o.db
        .prepare("UPDATE vulns_sends SET due = 0, sent_at = ?, attempt_at = ?, error = NULL, asset_id = COALESCE(?, asset_id) WHERE host_id = ?")
        .run(at, at, typeof asset.id === "string" ? asset.id : null, r.host_id);
    } catch (err) {
      const message = (err as Error).name === "TimeoutError" ? "Vulnerabilities did not answer in 30 seconds." : (err as Error).message.slice(0, 500);
      o.db.prepare("UPDATE vulns_sends SET attempt_at = ?, error = ? WHERE host_id = ?").run(at, message, r.host_id);
      o.log("warn", "packages not sent to Vulnerabilities; trying again in a few minutes", { host: r.name, error: message });
    }
  }

  return {
    collected,

    /** Sends what is due, one host after another. A call while one runs waits for that one. */
    deliver(): Promise<void> {
      delivering ??= (async () => {
        const rows = o.db
          .prepare(
            "SELECT s.*, h.name, h.latest_facts FROM vulns_sends s JOIN hosts h ON h.id = s.host_id WHERE s.due = 1 ORDER BY s.attempt_at IS NOT NULL, s.attempt_at",
          )
          .all() as unknown as Array<SendRow & { name: string; latest_facts: Uint8Array | null }>;
        for (const r of rows) if (!r.error || !r.attempt_at || now() - Date.parse(r.attempt_at) >= RETRY_MS) await send(r);
      })().finally(() => (delivering = undefined));
      return delivering;
    },

    /** For the host's page: when its packages last reached Vulnerabilities, and why not if they did not. */
    state(hostId: string) {
      const r = o.db.prepare("SELECT * FROM vulns_sends WHERE host_id = ?").get(hostId) as SendRow | undefined;
      return r ? { sentAt: r.sent_at, error: r.error, assetId: r.asset_id } : null;
    },
  };
}

export type VulnsLink = ReturnType<typeof createVulnsLink>;

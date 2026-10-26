// What the search window (Cmd+K) finds in Infrastructure: hosts by name or address, BMCs by name, address or serial,
// clusters by name, and containers by name or image. They are read whole and filtered here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Box, Cpu, Network, Server } from "lucide-react";
import type { Bmc, Cluster, Container, Host } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const [hosts, bmcs, clusters, containers] = await Promise.all([
      call<{ hosts: Host[] }>("/api/v1/hosts", { signal }),
      call<{ bmcs: Bmc[] }>("/api/v1/bmcs", { signal }),
      call<{ clusters: Cluster[] }>("/api/v1/clusters", { signal }),
      call<{ containers: Array<Container & { host: { id: string; name: string } }> }>("/api/v1/containers", { signal }),
    ]);
    const has = (...texts: Array<string | null | undefined>) => texts.some((x) => x?.toLowerCase().includes(q));
    return [
      ...hosts.hosts
        .filter((h) => has(h.name, h.address))
        .slice(0, 6)
        .map((h): SearchResult => ({
          id: `host:${h.id}`,
          label: h.name,
          detail: `${h.address} · ${h.summary?.os ?? h.status}`,
          kind: t("search.host"),
          icon: Server,
          mono: true,
          href: `/hosts/${encodeURIComponent(h.id)}`,
        })),
      ...bmcs.bmcs
        .filter((b) => has(b.name, b.address, b.summary?.serial, b.summary?.sku))
        .slice(0, 6)
        .map((b): SearchResult => ({
          id: `bmc:${b.id}`,
          label: b.name,
          detail: `${b.address} · ${[b.summary?.vendor, b.summary?.model].filter(Boolean).join(" ") || b.status}`,
          kind: t("search.bmc"),
          icon: Cpu,
          mono: true,
          href: `/bmcs/${encodeURIComponent(b.id)}`,
        })),
      ...clusters.clusters
        .filter((c) => has(c.name, c.server))
        .slice(0, 6)
        .map((c): SearchResult => ({
          id: `cluster:${c.id}`,
          label: c.name,
          detail: c.server,
          kind: t("search.cluster"),
          icon: Network,
          mono: true,
          href: `/clusters/${encodeURIComponent(c.id)}`,
        })),
      ...containers.containers
        .filter((c) => has(c.name, c.image))
        .slice(0, 6)
        .map((c): SearchResult => ({
          id: `container:${c.host.id}:${c.id}`,
          label: c.name,
          detail: `${c.image} · ${c.host.name}`,
          kind: t("search.container"),
          icon: Box,
          mono: true,
          href: `/hosts/${encodeURIComponent(c.host.id)}`,
        })),
    ];
  };
}

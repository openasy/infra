// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  hosts: Record<string, number>;
  clusters: Record<string, number>;
  bmcs: Record<string, number>;
  containers: number;
  changesLastDay: number;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="infra",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_infra_hosts Hosts by the status of their last collection.",
    "# TYPE openasy_infra_hosts gauge",
    ...Object.entries(g.hosts).map(([s, n]) => `openasy_infra_hosts{status="${s}"} ${n}`),
    "# HELP openasy_infra_clusters Kubernetes clusters by the status of their last collection.",
    "# TYPE openasy_infra_clusters gauge",
    ...Object.entries(g.clusters).map(([s, n]) => `openasy_infra_clusters{status="${s}"} ${n}`),
    "# HELP openasy_infra_bmcs BMCs by the status of their last collection.",
    "# TYPE openasy_infra_bmcs gauge",
    ...Object.entries(g.bmcs).map(([s, n]) => `openasy_infra_bmcs{status="${s}"} ${n}`),
    "# HELP openasy_infra_containers Containers found on hosts.",
    "# TYPE openasy_infra_containers gauge",
    `openasy_infra_containers ${g.containers}`,
    "# HELP openasy_infra_changes_last_day Changes recorded in the last 24 hours.",
    "# TYPE openasy_infra_changes_last_day gauge",
    `openasy_infra_changes_last_day ${g.changesLastDay}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}

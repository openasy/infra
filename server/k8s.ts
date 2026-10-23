// Kubernetes through its API with a read-only token (ADR 0031): nothing runs in the cluster. The ClusterRole below
// lists exactly what is read. It has no Secrets and no ConfigMaps: RBAC cannot limit a list to names, so a role
// that may list ConfigMaps can read their contents.
import { request } from "node:https";
import type { Change, Item } from "./changes.ts";

export const RBAC = `# Read-only access for OpenAsy Infrastructure (ADR 0031). No Secrets, no ConfigMaps, nothing it can change.
apiVersion: v1
kind: Namespace
metadata:
  name: openasy
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: openasy-infra
  namespace: openasy
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: openasy-infra-read
rules:
  - apiGroups: [""]
    resources: [nodes, namespaces, pods, services, persistentvolumeclaims, persistentvolumes, events]
    verbs: [get, list]
  - apiGroups: [apps]
    resources: [deployments, statefulsets, daemonsets, replicasets]
    verbs: [get, list]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [get, list]
  - apiGroups: [networking.k8s.io]
    resources: [ingresses]
    verbs: [get, list]
  - apiGroups: [storage.k8s.io]
    resources: [storageclasses]
    verbs: [get, list]
  - apiGroups: [rbac.authorization.k8s.io]
    resources: [clusterrolebindings]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: openasy-infra-read
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: openasy-infra-read
subjects:
  - kind: ServiceAccount
    name: openasy-infra
    namespace: openasy
---
# A token for the account. Paste it into Infrastructure with the API server URL and the cluster CA.
apiVersion: v1
kind: Secret
metadata:
  name: openasy-infra-token
  namespace: openasy
  annotations:
    kubernetes.io/service-account.name: openasy-infra
type: kubernetes.io/service-account-token
`;

export interface ClusterAccess {
  server: string;
  caCert: string | null;
  token: string;
}

export class K8sError extends Error {
  readonly kind: "unreachable" | "auth-failed" | "forbidden" | "error";
  constructor(kind: K8sError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

function get(access: ClusterAccess, path: string): Promise<any> {
  const url = new URL(path, access.server);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "GET", headers: { authorization: `Bearer ${access.token}`, accept: "application/json" }, ca: access.caCert ?? undefined, timeout: 20_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode === 401) return reject(new K8sError("auth-failed", "The token was refused (401)."));
          if (res.statusCode === 403) return reject(new K8sError("forbidden", `Not allowed to read ${url.pathname}: apply the role from Setup.`));
          if (res.statusCode !== 200) return reject(new K8sError("error", `${url.pathname}: ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new K8sError("error", `${url.pathname}: not JSON`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new K8sError("unreachable", "The API server did not answer within 20 seconds.")));
    req.on("error", (err) => reject(err instanceof K8sError ? err : new K8sError("unreachable", err.message)));
    req.end();
  });
}

type Obj = Record<string, any>;
const meta = (o: Obj) => ({
  namespace: o.metadata?.namespace ?? null,
  name: String(o.metadata?.name),
  createdAt: o.metadata?.creationTimestamp ?? null,
  labels: (o.metadata?.labels ?? {}) as Record<string, string>,
});
const owner = (o: Obj) => {
  const r = (o.metadata?.ownerReferences ?? [])[0];
  return r ? `${r.kind}/${r.name}` : null;
};

export interface ClusterFacts {
  collectedAt: string;
  version: { gitVersion: string; platform: string };
  nodes: Array<{
    name: string;
    roles: string[];
    ready: boolean;
    conditions: string[];
    kubelet: string;
    runtime: string;
    os: string;
    kernel: string;
    arch: string;
    internalIp: string | null;
    cpu: string;
    memory: string;
    pods: string;
    unschedulable: boolean;
    taints: string[];
    createdAt: string | null;
    labels: Record<string, string>;
  }>;
  namespaces: Array<{ name: string; phase: string; createdAt: string | null }>;
  workloads: Array<{
    kind: string;
    namespace: string;
    name: string;
    replicas: number | null;
    ready: number | null;
    images: string[];
    createdAt: string | null;
    schedule?: string;
    suspended?: boolean;
  }>;
  pods: Array<{
    namespace: string;
    name: string;
    node: string | null;
    phase: string;
    ready: string;
    restarts: number;
    reason: string | null;
    owner: string | null;
    ip: string | null;
    startedAt: string | null;
    containers: Array<{
      name: string;
      image: string;
      ready: boolean;
      restarts: number;
      state: string;
      reason: string | null;
      requests: Record<string, string>;
      limits: Record<string, string>;
      privileged: boolean;
    }>;
  }>;
  services: Array<{ namespace: string; name: string; type: string; clusterIp: string | null; externalIps: string[]; ports: string[] }>;
  ingresses: Array<{ namespace: string; name: string; hosts: string[]; tls: boolean; className: string | null }>;
  volumes: Array<{
    namespace: string | null;
    name: string;
    kind: "pvc" | "pv";
    status: string;
    capacity: string | null;
    storageClass: string | null;
    claim: string | null;
  }>;
  storageClasses: Array<{ name: string; provisioner: string; default: boolean }>;
  clusterAdmins: string[];
  events: Array<{ at: string | null; namespace: string; object: string; reason: string; message: string; count: number }>;
}

export async function collectCluster(access: ClusterAccess): Promise<ClusterFacts> {
  const list = async (path: string) => ((await get(access, path)).items ?? []) as Obj[];
  const [
    version,
    nodes,
    namespaces,
    pods,
    services,
    pvcs,
    pvs,
    events,
    deployments,
    statefulsets,
    daemonsets,
    jobs,
    cronjobs,
    ingresses,
    storageClasses,
    crbs,
  ] = await Promise.all([
    get(access, "/version"),
    list("/api/v1/nodes"),
    list("/api/v1/namespaces"),
    list("/api/v1/pods"),
    list("/api/v1/services"),
    list("/api/v1/persistentvolumeclaims"),
    list("/api/v1/persistentvolumes"),
    list("/api/v1/events?fieldSelector=type%3DWarning"),
    list("/apis/apps/v1/deployments"),
    list("/apis/apps/v1/statefulsets"),
    list("/apis/apps/v1/daemonsets"),
    list("/apis/batch/v1/jobs"),
    list("/apis/batch/v1/cronjobs"),
    list("/apis/networking.k8s.io/v1/ingresses"),
    list("/apis/storage.k8s.io/v1/storageclasses"),
    list("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings"),
  ]);
  const images = (o: Obj) =>
    ((o.spec?.template?.spec?.containers ?? o.spec?.jobTemplate?.spec?.template?.spec?.containers ?? []) as Obj[]).map((c) => String(c.image));
  return {
    collectedAt: new Date().toISOString(),
    version: { gitVersion: String(version.gitVersion), platform: String(version.platform) },
    nodes: nodes.map((n) => {
      const conditions = (n.status?.conditions ?? []) as Obj[];
      const info = n.status?.nodeInfo ?? {};
      return {
        ...meta(n),
        roles: Object.keys(n.metadata?.labels ?? {})
          .filter((l) => l.startsWith("node-role.kubernetes.io/"))
          .map((l) => l.split("/")[1]!),
        ready: conditions.some((c) => c.type === "Ready" && c.status === "True"),
        conditions: conditions.filter((c) => (c.type === "Ready" ? c.status !== "True" : c.status === "True")).map((c) => String(c.type)),
        kubelet: String(info.kubeletVersion ?? ""),
        runtime: String(info.containerRuntimeVersion ?? ""),
        os: String(info.osImage ?? ""),
        kernel: String(info.kernelVersion ?? ""),
        arch: String(info.architecture ?? ""),
        internalIp: ((n.status?.addresses ?? []) as Obj[]).find((a) => a.type === "InternalIP")?.address ?? null,
        cpu: String(n.status?.capacity?.cpu ?? ""),
        memory: String(n.status?.capacity?.memory ?? ""),
        pods: String(n.status?.capacity?.pods ?? ""),
        unschedulable: n.spec?.unschedulable === true,
        taints: ((n.spec?.taints ?? []) as Obj[]).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`),
      };
    }),
    namespaces: namespaces.map((n) => ({
      name: String(n.metadata.name),
      phase: String(n.status?.phase ?? ""),
      createdAt: n.metadata.creationTimestamp ?? null,
    })),
    workloads: [
      ...deployments.map((d) => ({ kind: "Deployment", ...meta(d), replicas: d.spec?.replicas ?? 0, ready: d.status?.readyReplicas ?? 0, images: images(d) })),
      ...statefulsets.map((d) => ({
        kind: "StatefulSet",
        ...meta(d),
        replicas: d.spec?.replicas ?? 0,
        ready: d.status?.readyReplicas ?? 0,
        images: images(d),
      })),
      ...daemonsets.map((d) => ({
        kind: "DaemonSet",
        ...meta(d),
        replicas: d.status?.desiredNumberScheduled ?? 0,
        ready: d.status?.numberReady ?? 0,
        images: images(d),
      })),
      ...cronjobs.map((d) => ({
        kind: "CronJob",
        ...meta(d),
        replicas: null,
        ready: null,
        images: images(d),
        schedule: String(d.spec?.schedule ?? ""),
        suspended: d.spec?.suspend === true,
      })),
      // Jobs a CronJob started come and go; only stand-alone ones are workloads.
      ...jobs
        .filter((j) => !owner(j))
        .map((d) => ({ kind: "Job", ...meta(d), replicas: d.spec?.completions ?? 1, ready: d.status?.succeeded ?? 0, images: images(d) })),
    ].map(({ labels: _labels, ...w }) => ({ ...w, namespace: String(w.namespace) })),
    pods: pods.map((p) => {
      const statuses = (p.status?.containerStatuses ?? []) as Obj[];
      const specs = (p.spec?.containers ?? []) as Obj[];
      const waiting =
        statuses.find((s) => s.state?.waiting)?.state.waiting.reason ?? statuses.find((s) => s.state?.terminated)?.state.terminated.reason ?? null;
      return {
        namespace: String(p.metadata.namespace),
        name: String(p.metadata.name),
        node: p.spec?.nodeName ?? null,
        phase: String(p.status?.phase ?? ""),
        ready: `${statuses.filter((s) => s.ready).length}/${specs.length}`,
        restarts: statuses.reduce((n, s) => n + Number(s.restartCount ?? 0), 0),
        reason: p.status?.reason ?? waiting,
        owner: owner(p),
        ip: p.status?.podIP ?? null,
        startedAt: p.status?.startTime ?? null,
        containers: specs.map((c) => {
          const s = statuses.find((x) => x.name === c.name) ?? {};
          const state = Object.keys(s.state ?? {})[0] ?? "unknown";
          return {
            name: String(c.name),
            image: String(c.image),
            ready: s.ready === true,
            restarts: Number(s.restartCount ?? 0),
            state,
            reason: s.state?.[state]?.reason ?? null,
            requests: c.resources?.requests ?? {},
            limits: c.resources?.limits ?? {},
            privileged: c.securityContext?.privileged === true,
          };
        }),
      };
    }),
    services: services.map((s) => ({
      namespace: String(s.metadata.namespace),
      name: String(s.metadata.name),
      type: String(s.spec?.type ?? ""),
      clusterIp: s.spec?.clusterIP && s.spec.clusterIP !== "None" ? String(s.spec.clusterIP) : null,
      externalIps: [...(s.spec?.externalIPs ?? []), ...((s.status?.loadBalancer?.ingress ?? []) as Obj[]).map((i) => i.ip ?? i.hostname)].map(String),
      ports: ((s.spec?.ports ?? []) as Obj[]).map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`),
    })),
    ingresses: ingresses.map((i) => ({
      namespace: String(i.metadata.namespace),
      name: String(i.metadata.name),
      hosts: ((i.spec?.rules ?? []) as Obj[]).map((r) => String(r.host ?? "*")),
      tls: (i.spec?.tls ?? []).length > 0,
      className: i.spec?.ingressClassName ?? null,
    })),
    volumes: [
      ...pvcs.map((v) => ({
        namespace: String(v.metadata.namespace),
        name: String(v.metadata.name),
        kind: "pvc" as const,
        status: String(v.status?.phase ?? ""),
        capacity: v.status?.capacity?.storage ?? null,
        storageClass: v.spec?.storageClassName ?? null,
        claim: null,
      })),
      ...pvs.map((v) => ({
        namespace: null,
        name: String(v.metadata.name),
        kind: "pv" as const,
        status: String(v.status?.phase ?? ""),
        capacity: v.spec?.capacity?.storage ?? null,
        storageClass: v.spec?.storageClassName ?? null,
        claim: v.spec?.claimRef ? `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` : null,
      })),
    ],
    storageClasses: storageClasses.map((c) => ({
      name: String(c.metadata.name),
      provisioner: String(c.provisioner),
      default: c.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true",
    })),
    clusterAdmins: crbs
      .filter((b) => b.roleRef?.name === "cluster-admin")
      .flatMap((b) => ((b.subjects ?? []) as Obj[]).map((s) => `${s.kind} ${s.namespace ? `${s.namespace}/` : ""}${s.name} (${b.metadata.name})`))
      .sort(),
    events: events
      .map((e) => ({
        at: e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? null,
        namespace: String(e.metadata?.namespace ?? ""),
        object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
        reason: String(e.reason ?? ""),
        message: String(e.message ?? "").slice(0, 500),
        count: Number(e.count ?? 1),
      }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 200),
  };
}

/** Pods come and go; workloads, nodes, services and who is cluster-admin are what changes mean. */
export function clusterItems(f: ClusterFacts): Item[] {
  const out: Item[] = [];
  const add = (category: Item["category"], key: string, value: unknown) =>
    out.push({ category, key, value: typeof value === "string" ? value : JSON.stringify(value) });
  add("system", "version", f.version.gitVersion);
  for (const n of f.nodes)
    add("system", `node ${n.name}`, {
      kubelet: n.kubelet,
      runtime: n.runtime,
      os: n.os,
      kernel: n.kernel,
      ready: n.ready,
      unschedulable: n.unschedulable,
      taints: n.taints,
    });
  for (const n of f.namespaces) add("group", `namespace ${n.name}`, n.phase);
  for (const w of f.workloads)
    add("container", `${w.kind} ${w.namespace}/${w.name}`, {
      images: w.images,
      replicas: w.replicas,
      ...(w.schedule !== undefined && { schedule: w.schedule, suspended: w.suspended }),
    });
  for (const s of f.services)
    add("port", `service ${s.namespace}/${s.name}`, `${s.type} ${s.ports.join(",")}${s.externalIps.length ? ` ${s.externalIps.join(",")}` : ""}`);
  for (const i of f.ingresses) add("port", `ingress ${i.namespace}/${i.name}`, `${i.hosts.join(",")}${i.tls ? " tls" : ""}`);
  for (const v of f.volumes)
    add("filesystem", `${v.kind} ${v.namespace ? `${v.namespace}/` : ""}${v.name}`, `${v.status} ${v.capacity ?? ""} ${v.storageClass ?? ""}`.trim());
  for (const a of f.clusterAdmins) add("sudo", `cluster-admin ${a}`, "present");
  return out;
}

export type { Change };

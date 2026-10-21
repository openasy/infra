import { Badge, Button, Callout, EmptyState, KpiCard, KpiGrid, navigate, PageHeader, Panel, Tabs, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Play, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Change, Cluster, ClusterFacts } from "./api.ts";
import { ago, ChangeList, List, Status, useData, type Call } from "./shared.tsx";

export function ClustersPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ clusters: Cluster[] }>(call, "/api/v1/clusters");
  const [adding, setAdding] = useState(false);
  const cols: Column<Cluster>[] = [
    { id: "name", header: "Cluster", cell: (c) => <a href={`/clusters/${c.id}`}>{c.name}</a>, sortValue: (c) => c.name },
    { id: "status", header: "Status", width: "150px", cell: (c) => <Status status={c.status} /> },
    { id: "version", header: "Version", width: "110px", mono: true, cell: (c) => c.summary?.version ?? "–" },
    { id: "nodes", header: "Nodes ready", width: "110px", cell: (c) => (c.summary ? `${c.summary.nodesReady}/${c.summary.nodes}` : "–") },
    { id: "pods", header: "Pods", width: "140px", cell: (c) => (c.summary ? `${c.summary.pods}${c.summary.podsNotRunning ? `, ${c.summary.podsNotRunning} not running` : ""}` : "–") },
    { id: "warnings", header: "Warnings", width: "100px", align: "right", cell: (c) => c.summary?.warnings ?? "–" },
    { id: "seen", header: "Collected", width: "110px", cell: (c) => ago(c.lastSuccessAt) },
  ];
  return (
    <>
      <PageHeader
        title="Kubernetes"
        description="Read through the API with a read-only token. Nothing runs in the cluster."
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add cluster
            </Button>
          )
        }
      />
      {adding && <AddCluster call={call} onDone={(c) => (setAdding(false), reload(), c && navigate(`/clusters/${c.id}`))} />}
      {data?.clusters.length === 0 && !adding ? (
        <EmptyState title="No clusters yet">
          Apply the read-only role from <a href="/setup">Setup</a> to a cluster, then add it here with its token.
        </EmptyState>
      ) : (
        <Panel flush>
          <List label="Clusters" rows={data?.clusters} columns={cols} empty="No clusters" getRowId={(c) => c.id} />
        </Panel>
      )}
    </>
  );
}

function AddCluster({ call, onDone }: { call: Call; onDone: (c?: Cluster) => void }) {
  const [name, setName] = useState("");
  const [server, setServer] = useState("");
  const [ca, setCa] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onDone(await call<Cluster>("/api/v1/clusters", { method: "POST", body: JSON.stringify({ name, server, caCert: ca.trim() || null, token: token.trim() }) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel title="Add a cluster" description="kubectl -n openasy get secret openasy-infra-token -o jsonpath='{.data.token}' | base64 -d prints the token. It is stored encrypted and never shown again.">
      <form onSubmit={submit} className="flex flex-col gap-3" style={{ maxWidth: 640 }}>
        {error && (
          <Callout tone="danger" title="Not added">
            {error}
          </Callout>
        )}
        <div className="grid grid-cols-2 gap-2">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-fra" />
          <TextField label="API server" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://10.0.0.10:6443" />
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Cluster CA (PEM), empty to use the system's
          <textarea value={ca} onChange={(e) => setCa(e.target.value)} rows={4} className="infra-code" style={{ whiteSpace: "pre-wrap" }} />
        </label>
        <TextField label="Token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} mono />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={!name || !server || !token}>
            Add cluster
          </Button>
          <Button type="button" variant="ghost" onClick={() => onDone()}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}

type Tab = "nodes" | "workloads" | "pods" | "network" | "volumes" | "events" | "access" | "changes";

export function ClusterPage({ call, id }: { call: Call; id: string }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("nodes");
  const cluster = useData<Cluster>(call, `/api/v1/clusters/${id}`, 10_000);
  const facts = useData<ClusterFacts>(call, cluster.data?.lastSuccessAt ? `/api/v1/clusters/${id}/facts` : null, 30_000);
  const changes = useData<{ changes: Change[] }>(call, tab === "changes" ? `/api/v1/clusters/${id}/changes?limit=500` : null, 30_000);
  const c = cluster.data;
  if (cluster.error && !c) return <EmptyState title="Not found">This cluster no longer exists.</EmptyState>;
  if (!c) return null;
  const f = facts.data;
  const remove = () => window.confirm(`Remove ${c.name} and its history?`) && void call(`/api/v1/clusters/${id}`, { method: "DELETE" }).then(() => navigate("/clusters"));
  return (
    <>
      <PageHeader
        title={c.name}
        breadcrumbs={[{ label: "Kubernetes", href: "/clusters" }, { label: c.name }]}
        description={`${c.server}${f ? ` · ${f.version.gitVersion}` : ""} · collected ${ago(c.lastSuccessAt)}`}
        meta={<Status status={c.status} />}
        actions={
          <>
            {can("editor") && (
              <Button icon={<Play />} onClick={() => void call(`/api/v1/clusters/${id}/collect`, { method: "POST" }).then(() => setTimeout(cluster.reload, 3000))}>
                Collect now
              </Button>
            )}
            {can("admin") && (
              <Button variant="danger" icon={<Trash2 />} onClick={remove}>
                Remove
              </Button>
            )}
          </>
        }
      />
      {c.status !== "ok" && c.statusDetail && (
        <Callout tone="danger" title="The last collection failed">
          {c.statusDetail}
        </Callout>
      )}
      {f && c.summary && (
        <>
          <KpiGrid>
            <KpiCard label="Nodes ready" value={`${c.summary.nodesReady}/${c.summary.nodes}`} tone={c.summary.nodesReady < c.summary.nodes ? "danger" : undefined} />
            <KpiCard label="Workloads" value={c.summary.workloads} footer={`${c.summary.namespaces} namespaces`} />
            <KpiCard label="Pods not running" value={c.summary.podsNotRunning} tone={c.summary.podsNotRunning ? "warning" : undefined} footer={`of ${c.summary.pods}`} />
            <KpiCard label="Container restarts" value={c.summary.restarts} footer={`${c.summary.warnings} warnings`} />
          </KpiGrid>
          <Tabs<Tab>
            label="Cluster details"
            value={tab}
            onChange={setTab}
            items={[
              { value: "nodes", label: "Nodes", count: f.nodes.length },
              { value: "workloads", label: "Workloads", count: f.workloads.length },
              { value: "pods", label: "Pods", count: f.pods.length },
              { value: "network", label: "Services and ingress", count: f.services.length + f.ingresses.length },
              { value: "volumes", label: "Volumes", count: f.volumes.length },
              { value: "events", label: "Warnings", count: f.events.length },
              { value: "access", label: "Cluster admins", count: f.clusterAdmins.length },
              { value: "changes", label: "Changes" },
            ]}
          />
          {tab === "nodes" && (
            <List
              label="Nodes"
              rows={f.nodes}
              getRowId={(n) => n.name}
              empty="No nodes"
              columns={[
                { id: "name", header: "Node", cell: (n) => n.name, sortValue: (n) => n.name },
                { id: "ready", header: "Ready", width: "130px", cell: (n) => <Badge tone={n.ready ? "success" : "danger"}>{n.ready ? "Ready" : n.conditions.join(", ") || "Not ready"}</Badge> },
                { id: "roles", header: "Roles", width: "130px", cell: (n) => n.roles.join(", ") || "worker" },
                { id: "kubelet", header: "Kubelet", width: "100px", mono: true, cell: (n) => n.kubelet },
                { id: "os", header: "System", cell: (n) => `${n.os} · ${n.kernel}` },
                { id: "size", header: "Capacity", width: "150px", cell: (n) => `${n.cpu} CPU · ${n.memory}` },
                { id: "ip", header: "Address", width: "120px", mono: true, cell: (n) => n.internalIp ?? "–" },
                { id: "flags", header: "", width: "120px", cell: (n) => (n.unschedulable ? <Badge tone="warning">cordoned</Badge> : n.taints.length ? <Badge>{`${n.taints.length} taints`}</Badge> : null) },
              ]}
            />
          )}
          {tab === "workloads" && (
            <List
              label="Workloads"
              rows={f.workloads}
              getRowId={(w) => `${w.kind}${w.namespace}${w.name}`}
              empty="No workloads"
              columns={[
                { id: "kind", header: "Kind", width: "110px", cell: (w) => w.kind },
                { id: "name", header: "Name", cell: (w) => `${w.namespace}/${w.name}`, sortValue: (w) => `${w.namespace}/${w.name}` },
                { id: "ready", header: "Ready", width: "90px", cell: (w) => (w.replicas === null ? (w.schedule ?? "–") : <Badge tone={w.ready === w.replicas ? "success" : "warning"}>{`${w.ready}/${w.replicas}`}</Badge>) },
                { id: "images", header: "Images", cell: (w) => <span className="infra-wrap font-mono text-xs">{w.images.join(", ")}</span> },
              ]}
            />
          )}
          {tab === "pods" && (
            <List
              label="Pods"
              rows={f.pods}
              getRowId={(p) => `${p.namespace}/${p.name}`}
              empty="No pods"
              pageSize={100}
              columns={[
                { id: "name", header: "Pod", cell: (p) => `${p.namespace}/${p.name}`, sortValue: (p) => `${p.namespace}/${p.name}` },
                { id: "phase", header: "Phase", width: "160px", cell: (p) => <Badge tone={p.phase === "Running" && !p.reason ? "success" : p.phase === "Succeeded" ? "neutral" : "warning"}>{p.reason ?? p.phase}</Badge>, sortValue: (p) => p.phase },
                { id: "ready", header: "Ready", width: "70px", mono: true, cell: (p) => p.ready },
                { id: "restarts", header: "Restarts", width: "90px", align: "right", mono: true, cell: (p) => p.restarts, sortValue: (p) => p.restarts },
                { id: "node", header: "Node", cell: (p) => p.node ?? "–" },
                { id: "flags", header: "", width: "110px", cell: (p) => (p.containers.some((x) => x.privileged) ? <Badge tone="danger">privileged</Badge> : null) },
              ]}
            />
          )}
          {tab === "network" && (
            <div className="flex flex-col gap-4">
              <List
                label="Services"
                rows={f.services}
                getRowId={(s) => `${s.namespace}/${s.name}`}
                empty="No services"
                columns={[
                  { id: "name", header: "Service", cell: (s) => `${s.namespace}/${s.name}` },
                  { id: "type", header: "Type", width: "120px", cell: (s) => <Badge tone={s.type === "LoadBalancer" || s.type === "NodePort" ? "warning" : "neutral"}>{s.type}</Badge> },
                  { id: "ip", header: "Cluster IP", width: "130px", mono: true, cell: (s) => s.clusterIp ?? "–" },
                  { id: "ext", header: "External", mono: true, cell: (s) => s.externalIps.join(", ") || "–" },
                  { id: "ports", header: "Ports", mono: true, cell: (s) => s.ports.join(", ") },
                ]}
              />
              <List
                label="Ingresses"
                rows={f.ingresses}
                getRowId={(i) => `${i.namespace}/${i.name}`}
                empty="No ingresses"
                columns={[
                  { id: "name", header: "Ingress", cell: (i) => `${i.namespace}/${i.name}` },
                  { id: "hosts", header: "Hosts", mono: true, cell: (i) => i.hosts.join(", ") },
                  { id: "tls", header: "TLS", width: "70px", cell: (i) => (i.tls ? <Badge tone="success">yes</Badge> : <Badge tone="warning">no</Badge>) },
                ]}
              />
            </div>
          )}
          {tab === "volumes" && (
            <List
              label="Volumes"
              rows={f.volumes}
              getRowId={(v) => `${v.kind}${v.namespace}${v.name}`}
              empty="No volumes"
              columns={[
                { id: "kind", header: "Kind", width: "70px", cell: (v) => v.kind.toUpperCase() },
                { id: "name", header: "Name", cell: (v) => `${v.namespace ? `${v.namespace}/` : ""}${v.name}` },
                { id: "status", header: "Status", width: "100px", cell: (v) => v.status },
                { id: "cap", header: "Size", width: "90px", cell: (v) => v.capacity ?? "–" },
                { id: "class", header: "Storage class", cell: (v) => v.storageClass ?? "–" },
              ]}
            />
          )}
          {tab === "events" && (
            <List
              label="Warnings"
              rows={f.events}
              getRowId={(e) => `${e.at}${e.object}${e.reason}`}
              empty="No warnings"
              columns={[
                { id: "at", header: "When", width: "110px", cell: (e) => ago(e.at) },
                { id: "obj", header: "Object", cell: (e) => `${e.namespace}/${e.object}` },
                { id: "reason", header: "Reason", width: "140px", cell: (e) => e.reason },
                { id: "msg", header: "Message", cell: (e) => <span className="infra-wrap text-xs">{e.message}</span> },
                { id: "count", header: "Times", width: "70px", align: "right", cell: (e) => e.count },
              ]}
            />
          )}
          {tab === "access" && (
            <Panel title="Bound to cluster-admin" description="Anyone here can do anything in the cluster.">
              <ul className="infra-list flex flex-col gap-1 font-mono text-xs">
                {f.clusterAdmins.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Panel>
          )}
          {tab === "changes" && <ChangeList changes={changes.data?.changes} />}
        </>
      )}
    </>
  );
}

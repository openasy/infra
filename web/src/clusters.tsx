import { Badge, Button, Callout, Dialog, EmptyState, KpiCard, KpiGrid, navigate, PageHeader, Panel, Tabs, TextField, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Play, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Change, Cluster, ClusterFacts } from "./api.ts";
import { ChangeList, List, Status, useData, type Call } from "./shared.tsx";
import { useT } from "./i18n.ts";

export function ClustersPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const { data, reload } = useData<{ clusters: Cluster[] }>(call, "/api/v1/clusters");
  const [adding, setAdding] = useState(false);
  const cols: Column<Cluster>[] = [
    { id: "name", header: t("clustersPage.cluster"), cell: (c) => <a href={`/clusters/${c.id}`}>{c.name}</a>, sortValue: (c) => c.name },
    { id: "status", header: t("clustersPage.status"), width: "150px", cell: (c) => <Status status={c.status} /> },
    { id: "version", header: t("clustersPage.version"), width: "110px", mono: true, cell: (c) => c.summary?.version ?? "–" },
    { id: "nodes", header: t("clustersPage.nodesReady"), width: "110px", cell: (c) => (c.summary ? `${c.summary.nodesReady}/${c.summary.nodes}` : "–") },
    { id: "pods", header: t("clustersPage.pods"), width: "140px", cell: (c) => (c.summary ? `${c.summary.pods}${c.summary.podsNotRunning ? `, ${c.summary.podsNotRunning} not running` : ""}` : "–") },
    { id: "warnings", header: t("clustersPage.warnings"), width: "100px", align: "right", cell: (c) => c.summary?.warnings ?? "–" },
    { id: "seen", header: t("clustersPage.collected"), width: "110px", cell: (c) => ago(c.lastSuccessAt) },
  ];
  return (
    <>
      <PageHeader
        title={t("clustersPage.kubernetes")}
        description={t("clustersPage.readThroughTheApiWith")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("clustersPage.addCluster")}
            </Button>
          )
        }
      />
      {adding && <AddCluster call={call} onDone={(c) => (setAdding(false), reload(), c && navigate(`/clusters/${c.id}`))} />}
      {data?.clusters.length === 0 ? (
        <EmptyState title={t("clustersPage.noClustersYet")}>
          {t("clustersPage.applyTheReadOnlyRole")}{" "}<a href="/setup">{t("clustersPage.setup")}</a> {t("clustersPage.toAClusterThenAdd")}
        </EmptyState>
      ) : (
        <Panel flush>
          <List label={t("clustersPage.clusters")} rows={data?.clusters} columns={cols} empty={t("clustersPage.noClusters")} getRowId={(c) => c.id} />
        </Panel>
      )}
    </>
  );
}

function AddCluster({ call, onDone }: { call: Call; onDone: (c?: Cluster) => void }) {
  const t = useT();
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
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      size="lg"
      title={t("addCluster.addACluster")}
      description={t("addCluster.kubectlNOpenasyGetSecret")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={() => onDone()}>
            {t("addCluster.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name || !server || !token}>
            {t("addCluster.addCluster")}
          </Button>
        </>
      }
    >
      {error && (
        <Callout tone="danger" title={t("addCluster.notAdded")}>
          {error}
        </Callout>
      )}
      <div className="grid grid-cols-2 gap-2">
        <TextField label={t("addCluster.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-fra" />
        <TextField label={t("addCluster.apiServer")} value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://10.0.0.10:6443" />
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">
        {t("addCluster.clusterCaPemEmptyTo")}
        <textarea value={ca} onChange={(e) => setCa(e.target.value)} rows={4} className="infra-code" style={{ whiteSpace: "pre-wrap" }} />
      </label>
      <TextField label={t("addCluster.token")} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} mono />
    </Dialog>
  );
}

type Tab = "nodes" | "workloads" | "pods" | "network" | "volumes" | "events" | "access" | "changes";

export function ClusterPage({ call, id }: { call: Call; id: string }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("nodes");
  const cluster = useData<Cluster>(call, `/api/v1/clusters/${id}`, 10_000);
  const facts = useData<ClusterFacts>(call, cluster.data?.lastSuccessAt ? `/api/v1/clusters/${id}/facts` : null, 30_000);
  const changes = useData<{ changes: Change[] }>(call, tab === "changes" ? `/api/v1/clusters/${id}/changes?limit=500` : null, 30_000);
  const c = cluster.data;
  if (cluster.error && !c) return <EmptyState title={t("clusterPage.notFound")}>{t("clusterPage.thisClusterNoLongerExists")}</EmptyState>;
  if (!c) return null;
  const f = facts.data;
  const remove = () => window.confirm(t("clusterPage.removeAndItsHistory", { name: c.name })) && void call(`/api/v1/clusters/${id}`, { method: "DELETE" }).then(() => navigate("/clusters"));
  return (
    <>
      <PageHeader
        title={c.name}
        breadcrumbs={[{ label: t("clusterPage.kubernetes"), href: "/clusters" }, { label: c.name }]}
        description={t("clusterPage.collected", { server: c.server, value: f ? ` · ${f.version.gitVersion}` : "", ago: ago(c.lastSuccessAt) })}
        meta={<Status status={c.status} />}
        actions={
          <>
            {can("editor") && (
              <Button icon={<Play />} onClick={() => void call(`/api/v1/clusters/${id}/collect`, { method: "POST" }).then(() => setTimeout(cluster.reload, 3000))}>
                {t("clusterPage.collectNow")}
              </Button>
            )}
            {can("admin") && (
              <Button variant="danger" icon={<Trash2 />} onClick={remove}>
                {t("clusterPage.remove")}
              </Button>
            )}
          </>
        }
      />
      {c.status !== "ok" && c.statusDetail && (
        <Callout tone="danger" title={t("clusterPage.theLastCollectionFailed")}>
          {c.statusDetail}
        </Callout>
      )}
      {f && c.summary && (
        <>
          <KpiGrid>
            <KpiCard label={t("clusterPage.nodesReady")} value={`${c.summary.nodesReady}/${c.summary.nodes}`} tone={c.summary.nodesReady < c.summary.nodes ? "danger" : undefined} />
            <KpiCard label={t("clusterPage.workloads")} value={c.summary.workloads} footer={t("clusterPage.namespaces", { namespaces: c.summary.namespaces })} />
            <KpiCard label={t("clusterPage.podsNotRunning")} value={c.summary.podsNotRunning} tone={c.summary.podsNotRunning ? "warning" : undefined} footer={t("clusterPage.of", { pods: c.summary.pods })} />
            <KpiCard label={t("clusterPage.containerRestarts")} value={c.summary.restarts} footer={t("clusterPage.warnings", { warnings: c.summary.warnings })} />
          </KpiGrid>
          <Tabs<Tab>
            label={t("clusterPage.clusterDetails")}
            value={tab}
            onChange={setTab}
            items={[
              { value: "nodes", label: t("clusterPage.nodes"), count: f.nodes.length },
              { value: "workloads", label: t("clusterPage.workloads"), count: f.workloads.length },
              { value: "pods", label: t("clusterPage.pods"), count: f.pods.length },
              { value: "network", label: t("clusterPage.servicesAndIngress"), count: f.services.length + f.ingresses.length },
              { value: "volumes", label: t("clusterPage.volumes"), count: f.volumes.length },
              { value: "events", label: t("clusterPage.warnings2"), count: f.events.length },
              { value: "access", label: t("clusterPage.clusterAdmins"), count: f.clusterAdmins.length },
              { value: "changes", label: t("clusterPage.changes") },
            ]}
          />
          {tab === "nodes" && (
            <List
              label={t("clusterPage.nodes")}
              rows={f.nodes}
              getRowId={(n) => n.name}
              empty={t("clusterPage.noNodes")}
              columns={[
                { id: "name", header: t("clusterPage.node"), cell: (n) => n.name, sortValue: (n) => n.name },
                { id: "ready", header: t("clusterPage.ready"), width: "130px", cell: (n) => <Badge tone={n.ready ? "success" : "danger"}>{n.ready ? t("clusterPage.ready") : n.conditions.join(", ") || t("clusterPage.notReady")}</Badge> },
                { id: "roles", header: t("clusterPage.roles"), width: "130px", cell: (n) => n.roles.join(", ") || "worker" },
                { id: "kubelet", header: t("clusterPage.kubelet"), width: "100px", mono: true, cell: (n) => n.kubelet },
                { id: "os", header: t("clusterPage.system"), cell: (n) => `${n.os} · ${n.kernel}` },
                { id: "size", header: t("clusterPage.capacity"), width: "150px", cell: (n) => `${n.cpu} CPU · ${n.memory}` },
                { id: "ip", header: t("clusterPage.address"), width: "120px", mono: true, cell: (n) => n.internalIp ?? "–" },
                { id: "flags", header: "", width: "120px", cell: (n) => (n.unschedulable ? <Badge tone="warning">cordoned</Badge> : n.taints.length ? <Badge>{t("clusterPage.taints", { length: n.taints.length })}</Badge> : null) },
              ]}
            />
          )}
          {tab === "workloads" && (
            <List
              label={t("clusterPage.workloads")}
              rows={f.workloads}
              getRowId={(w) => `${w.kind}${w.namespace}${w.name}`}
              empty={t("clusterPage.noWorkloads")}
              columns={[
                { id: "kind", header: t("clusterPage.kind"), width: "110px", cell: (w) => w.kind },
                { id: "name", header: t("clusterPage.name"), cell: (w) => `${w.namespace}/${w.name}`, sortValue: (w) => `${w.namespace}/${w.name}` },
                { id: "ready", header: t("clusterPage.ready"), width: "90px", cell: (w) => (w.replicas === null ? (w.schedule ?? "–") : <Badge tone={w.ready === w.replicas ? "success" : "warning"}>{`${w.ready}/${w.replicas}`}</Badge>) },
                { id: "images", header: t("clusterPage.images"), cell: (w) => <span className="infra-wrap font-mono text-xs">{w.images.join(", ")}</span> },
              ]}
            />
          )}
          {tab === "pods" && (
            <List
              label={t("clusterPage.pods")}
              rows={f.pods}
              getRowId={(p) => `${p.namespace}/${p.name}`}
              empty={t("clusterPage.noPods")}
              pageSize={100}
              columns={[
                { id: "name", header: t("clusterPage.pod"), cell: (p) => `${p.namespace}/${p.name}`, sortValue: (p) => `${p.namespace}/${p.name}` },
                { id: "phase", header: t("clusterPage.phase"), width: "160px", cell: (p) => <Badge tone={p.phase === "Running" && !p.reason ? "success" : p.phase === "Succeeded" ? "neutral" : "warning"}>{p.reason ?? p.phase}</Badge>, sortValue: (p) => p.phase },
                { id: "ready", header: t("clusterPage.ready"), width: "70px", mono: true, cell: (p) => p.ready },
                { id: "restarts", header: t("clusterPage.restarts"), width: "90px", align: "right", mono: true, cell: (p) => p.restarts, sortValue: (p) => p.restarts },
                { id: "node", header: t("clusterPage.node"), cell: (p) => p.node ?? "–" },
                { id: "flags", header: "", width: "110px", cell: (p) => (p.containers.some((x) => x.privileged) ? <Badge tone="danger">privileged</Badge> : null) },
              ]}
            />
          )}
          {tab === "network" && (
            <div className="flex flex-col gap-4">
              <List
                label={t("clusterPage.services")}
                rows={f.services}
                getRowId={(s) => `${s.namespace}/${s.name}`}
                empty={t("clusterPage.noServices")}
                columns={[
                  { id: "name", header: t("clusterPage.service"), cell: (s) => `${s.namespace}/${s.name}` },
                  { id: "type", header: t("clusterPage.type"), width: "120px", cell: (s) => <Badge tone={s.type === "LoadBalancer" || s.type === "NodePort" ? "warning" : "neutral"}>{s.type}</Badge> },
                  { id: "ip", header: t("clusterPage.clusterIp"), width: "130px", mono: true, cell: (s) => s.clusterIp ?? "–" },
                  { id: "ext", header: t("clusterPage.external"), mono: true, cell: (s) => s.externalIps.join(", ") || "–" },
                  { id: "ports", header: t("clusterPage.ports"), mono: true, cell: (s) => s.ports.join(", ") },
                ]}
              />
              <List
                label={t("clusterPage.ingresses")}
                rows={f.ingresses}
                getRowId={(i) => `${i.namespace}/${i.name}`}
                empty={t("clusterPage.noIngresses")}
                columns={[
                  { id: "name", header: t("clusterPage.ingress"), cell: (i) => `${i.namespace}/${i.name}` },
                  { id: "hosts", header: t("clusterPage.hosts"), mono: true, cell: (i) => i.hosts.join(", ") },
                  { id: "tls", header: "TLS", width: "70px", cell: (i) => (i.tls ? <Badge tone="success">yes</Badge> : <Badge tone="warning">no</Badge>) },
                ]}
              />
            </div>
          )}
          {tab === "volumes" && (
            <List
              label={t("clusterPage.volumes")}
              rows={f.volumes}
              getRowId={(v) => `${v.kind}${v.namespace}${v.name}`}
              empty={t("clusterPage.noVolumes")}
              columns={[
                { id: "kind", header: t("clusterPage.kind"), width: "70px", cell: (v) => v.kind.toUpperCase() },
                { id: "name", header: t("clusterPage.name"), cell: (v) => `${v.namespace ? `${v.namespace}/` : ""}${v.name}` },
                { id: "status", header: t("clusterPage.status"), width: "100px", cell: (v) => v.status },
                { id: "cap", header: t("clusterPage.size"), width: "90px", cell: (v) => v.capacity ?? "–" },
                { id: "class", header: t("clusterPage.storageClass"), cell: (v) => v.storageClass ?? "–" },
              ]}
            />
          )}
          {tab === "events" && (
            <List
              label={t("clusterPage.warnings2")}
              rows={f.events}
              getRowId={(e) => `${e.at}${e.object}${e.reason}`}
              empty={t("clusterPage.noWarnings")}
              columns={[
                { id: "at", header: t("clusterPage.when"), width: "110px", cell: (e) => ago(e.at) },
                { id: "obj", header: t("clusterPage.object"), cell: (e) => `${e.namespace}/${e.object}` },
                { id: "reason", header: t("clusterPage.reason"), width: "140px", cell: (e) => e.reason },
                { id: "msg", header: t("clusterPage.message"), cell: (e) => <span className="infra-wrap text-xs">{e.message}</span> },
                { id: "count", header: t("clusterPage.times"), width: "70px", align: "right", cell: (e) => e.count },
              ]}
            />
          )}
          {tab === "access" && (
            <Panel title={t("clusterPage.boundToClusterAdmin")} description={t("clusterPage.anyoneHereCanDoAnything")}>
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

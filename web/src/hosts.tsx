import { Button, Callout, EmptyState, navigate, PageHeader, Panel, SelectField, Switch, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Agent, Host } from "./api.ts";
import { ago, duration, List, Status, Usage, useData, type Call } from "./shared.tsx";

export function HostsPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ hosts: Host[] }>(call, "/api/v1/hosts");
  const agents = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 0);
  const [adding, setAdding] = useState(false);
  const hosts = data?.hosts;
  const columns: Column<Host>[] = [
    { id: "name", header: "Host", cell: (h) => <a href={`/hosts/${h.id}`}>{h.name}</a>, sortValue: (h) => h.name },
    { id: "status", header: "Status", width: "180px", cell: (h) => <Status status={h.status} />, sortValue: (h) => h.status },
    { id: "agent", header: "Agent", width: "130px", cell: (h) => h.agent.name, sortValue: (h) => h.agent.name },
    { id: "os", header: "System", cell: (h) => (h.summary ? `${h.summary.os} · ${h.summary.arch}` : "–") },
    { id: "uptime", header: "Up", width: "70px", cell: (h) => (h.summary ? duration(h.summary.uptimeSec) : "–"), sortValue: (h) => h.summary?.uptimeSec ?? -1 },
    { id: "load", header: "Load", width: "70px", align: "right", mono: true, cell: (h) => (h.summary ? h.summary.load[0]!.toFixed(2) : "–"), sortValue: (h) => h.summary?.load[0] ?? -1 },
    {
      id: "mem",
      header: "Memory",
      width: "120px",
      cell: (h) => (h.summary ? <Usage pct={Math.round((1 - h.summary.memoryAvailableKb / h.summary.memoryTotalKb) * 100)} /> : "–"),
      sortValue: (h) => (h.summary ? 1 - h.summary.memoryAvailableKb / h.summary.memoryTotalKb : -1),
    },
    { id: "disk", header: "Fullest disk", width: "120px", cell: (h) => (h.summary?.fullestDisk ? <Usage pct={h.summary.fullestDisk.pct} /> : "–"), sortValue: (h) => h.summary?.fullestDisk?.pct ?? -1 },
    { id: "seen", header: "Collected", width: "110px", cell: (h) => ago(h.lastSuccessAt), sortValue: (h) => h.lastSuccessAt ?? "" },
  ];
  return (
    <>
      <PageHeader
        title="Hosts"
        description="Read over SSH as the openasy account with a 5-minute certificate. Nothing is installed on them."
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add host
            </Button>
          )
        }
      />
      {agents.data?.agents.length === 0 && (
        <Callout tone="info" title="Add an agent first" action={can("admin") && <Button size="sm" onClick={() => navigate("/agents")}>Agents</Button>}>
          An agent reads the hosts over SSH. Install it once, next to Infrastructure or in the network of the hosts.
        </Callout>
      )}
      {adding && <AddHost call={call} hosts={hosts ?? []} agents={agents.data?.agents ?? []} onDone={(h) => (setAdding(false), reload(), h && navigate(`/hosts/${h.id}`))} />}
      {hosts?.length === 0 && !adding ? (
        <EmptyState title="No hosts yet" action={can("admin") && <Button onClick={() => setAdding(true)}>Add the first host</Button>}>
          Prepare a host with the commands under <a href="/setup">Setup</a>, then add it here.
        </EmptyState>
      ) : (
        <Panel flush>
          <List label="Hosts" rows={hosts} columns={columns} empty="No hosts" getRowId={(h) => h.id} />
        </Panel>
      )}
    </>
  );
}

function AddHost({ call, hosts, agents, onDone }: { call: Call; hosts: Host[]; agents: Agent[]; onDone: (h?: Host) => void }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [auth, setAuth] = useState<"certificate" | "key">("certificate");
  const [jump, setJump] = useState("");
  const [containers, setContainers] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const h = await call<Host>("/api/v1/hosts", { method: "POST", body: JSON.stringify({ name, agentId, address, port: Number(port), auth, containers, jumpHostId: jump || null }) });
      onDone(h);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const jumps = hosts.filter((h) => !h.jumpHost && h.hostKeys.length && h.agent.id === agentId);
  return (
    <Panel title="Add a host" description="The agent asks the host for its key next; you check it before anything is read. Prepare the host first with the commands under Setup for that agent.">
      <form onSubmit={submit} className="flex flex-col gap-3" style={{ maxWidth: 560 }}>
        {error && (
          <Callout tone="danger" title="Not added">
            {error}
          </Callout>
        )}
        <div className="grid grid-cols-2 gap-2">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="web-1" />
          <SelectField label="Read by" value={agentId} onChange={(e) => setAgentId(e.target.value)} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
          <TextField label="Address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="10.0.0.5" />
          <TextField label="SSH port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
          <SelectField
            label="Login"
            value={auth}
            onChange={(e) => setAuth(e.target.value as "certificate" | "key")}
            options={[
              { value: "certificate", label: "Certificate from Infrastructure's CA" },
              { value: "key", label: "Fixed key in authorized_keys" },
            ]}
          />
          <SelectField label="Reach it through" value={jump} onChange={(e) => setJump(e.target.value)} options={[{ value: "", label: "Directly" }, ...jumps.map((h) => ({ value: h.id, label: `${h.name} (jump host)` }))]} />
        </div>
        <Switch checked={containers} onCheckedChange={setContainers} label="Read containers" description="Through Docker or Podman on the host. The openasy account needs the socket, which is equivalent to root on that host." />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={!name || !address || !agentId}>
            Add host
          </Button>
          <Button type="button" variant="ghost" onClick={() => onDone()}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** Shown until an admin checks the key the host presents against the host itself (ADR 0031). */
export function HostKeyCheck({ host, call, onDone }: { host: Host; call: Call; onDone: () => void }) {
  const { can } = useAuth();
  const [error, setError] = useState<string>();
  const changed = host.status === "host-key-changed";
  const accept = (fingerprint: string) =>
    call(`/api/v1/hosts/${host.id}/host-key/accept`, { method: "POST", body: JSON.stringify({ fingerprint }) }).then(onDone, (e: Error) => setError(e.message));
  if (!host.pendingHostKeys.length) {
    return (
      <Callout tone="info" title="No host key yet" action={can("admin") && <Button size="sm" onClick={() => void call(`/api/v1/hosts/${host.id}/host-key`, { method: "POST" }).then(onDone)}>Ask again</Button>}>
        {host.statusDetail ?? `Waiting for ${host.agent.name} to ask the host for its key.`}
      </Callout>
    );
  }
  return (
    <Callout tone={changed ? "danger" : "warning"} title={changed ? "The host key changed" : "Check the host key"}>
      <span className="flex flex-col gap-2">
        <span>
          {changed
            ? "The host presents a different key than the one pinned. If the host was not reinstalled, someone may be in between. Nothing is read until an admin accepts the new key."
            : "Run this on the host and compare the fingerprint before accepting it:"}
        </span>
        <code className="font-mono text-xs">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>
        {host.pendingHostKeys.map((k) => (
          <span key={k.fingerprint} className="flex flex-wrap items-center gap-2">
            <code className="infra-wrap font-mono text-sm">{k.fingerprint}</code> <span className="text-xs text-fg-muted">{k.type}</span>
            {can("admin") && (
              <Button size="sm" icon={<ShieldCheck />} onClick={() => void accept(k.fingerprint)}>
                It matches, accept
              </Button>
            )}
          </span>
        ))}
        {error && <span className="text-danger">{error}</span>}
      </span>
    </Callout>
  );
}

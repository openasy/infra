import { Badge, Button, Callout, Dialog, EmptyState, navigate, PageHeader, Panel, SelectField, Switch, TextField, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Agent, Host, Summary } from "./api.ts";
import { duration, List, Status, Usage, useData, type Call } from "./shared.tsx";
import { useT } from "./i18n.ts";

export function HostsPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const { data, reload } = useData<{ hosts: Host[] }>(call, "/api/v1/hosts");
  const agents = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 0);
  const file = useData<Summary>(call, "/api/v1/summary").data?.hostsFile;
  const [adding, setAdding] = useState(false);
  const hosts = data?.hosts;
  const columns: Column<Host>[] = [
    {
      id: "name",
      header: t("hostsPage.host"),
      cell: (h) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <a href={`/hosts/${h.id}`}>{h.name}</a>
          {h.source === "file" && <Badge tone="neutral">{t("hostsPage.fromFile")}</Badge>}
        </span>
      ),
      sortValue: (h) => h.name,
    },
    { id: "status", header: t("hostsPage.status"), width: "180px", cell: (h) => <Status status={h.status} />, sortValue: (h) => h.status },
    { id: "agent", header: t("hostsPage.agent"), width: "130px", cell: (h) => h.agent.name, sortValue: (h) => h.agent.name },
    { id: "os", header: t("hostsPage.system"), cell: (h) => (h.summary ? `${h.summary.os} · ${h.summary.arch}` : "–") },
    { id: "uptime", header: t("hostsPage.up"), width: "70px", cell: (h) => (h.summary ? duration(h.summary.uptimeSec) : "–"), sortValue: (h) => h.summary?.uptimeSec ?? -1 },
    { id: "load", header: t("hostsPage.load"), width: "70px", align: "right", mono: true, cell: (h) => (h.summary ? h.summary.load[0]!.toFixed(2) : "–"), sortValue: (h) => h.summary?.load[0] ?? -1 },
    {
      id: "mem",
      header: t("hostsPage.memory"),
      width: "120px",
      cell: (h) => (h.summary ? <Usage pct={Math.round((1 - h.summary.memoryAvailableKb / h.summary.memoryTotalKb) * 100)} /> : "–"),
      sortValue: (h) => (h.summary ? 1 - h.summary.memoryAvailableKb / h.summary.memoryTotalKb : -1),
    },
    { id: "disk", header: t("hostsPage.fullestDisk"), width: "120px", cell: (h) => (h.summary?.fullestDisk ? <Usage pct={h.summary.fullestDisk.pct} /> : "–"), sortValue: (h) => h.summary?.fullestDisk?.pct ?? -1 },
    { id: "seen", header: t("hostsPage.collected"), width: "110px", cell: (h) => ago(h.lastSuccessAt), sortValue: (h) => h.lastSuccessAt ?? "" },
  ];
  return (
    <>
      <PageHeader
        title={t("hostsPage.hosts")}
        description={t("hostsPage.readOverSshAsThe")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("hostsPage.addHost")}
            </Button>
          )
        }
      />
      {agents.data?.agents.length === 0 && (
        <Callout tone="info" title={t("hostsPage.addAnAgentFirst")} action={can("admin") && <Button size="sm" onClick={() => navigate("/agents")}>{t("hostsPage.agents")}</Button>}>
          {t("hostsPage.anAgentReadsTheHosts")}
        </Callout>
      )}
      {file?.error && (
        <Callout tone="danger" title={t("hostsPage.theHostsFileIsNot")}>
          {t("hostsPage.theHostsFromItsLast", { error: file.error, path: file.path })}</Callout>
      )}
      {!!file?.warnings.length && (
        <Callout tone="warning" title={t("hostsPage.theHostsFileHasSomething")}>
          {file.warnings.join(" ")}
        </Callout>
      )}
      {adding && <AddHost call={call} hosts={hosts ?? []} agents={agents.data?.agents ?? []} onDone={(h) => (setAdding(false), reload(), h && navigate(`/hosts/${h.id}`))} />}
      {hosts?.length === 0 ? (
        <EmptyState title={t("hostsPage.noHostsYet")} action={can("admin") && <Button onClick={() => setAdding(true)}>{t("hostsPage.addTheFirstHost")}</Button>}>
          {t("hostsPage.prepareAHostWithThe")}{" "}<a href="/setup">{t("hostsPage.setup")}</a>{t("hostsPage.thenAddItHere")}
        </EmptyState>
      ) : (
        <Panel flush>
          <List label={t("hostsPage.hosts")} rows={hosts} columns={columns} empty={t("hostsPage.noHosts")} getRowId={(h) => h.id} />
        </Panel>
      )}
    </>
  );
}

function AddHost({ call, hosts, agents, onDone }: { call: Call; hosts: Host[]; agents: Agent[]; onDone: (h?: Host) => void }) {
  const t = useT();
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
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      size="lg"
      title={t("addHost.addAHost")}
      description={t("addHost.theAgentAsksTheHost")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={() => onDone()}>
            {t("addHost.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name || !address || !agentId}>
            {t("addHost.addHost")}
          </Button>
        </>
      }
    >
      {error && (
        <Callout tone="danger" title={t("addHost.notAdded")}>
          {error}
        </Callout>
      )}
      <div className="grid grid-cols-2 gap-2">
        <TextField label={t("addHost.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="web-1" />
        <SelectField label={t("addHost.readBy")} value={agentId} onChange={(e) => setAgentId(e.target.value)} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
        <TextField label={t("addHost.address")} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="10.0.0.5" />
        <TextField label={t("addHost.sshPort")} value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        <SelectField
          label={t("addHost.login")}
          value={auth}
          onChange={(e) => setAuth(e.target.value as "certificate" | "key")}
          options={[
            { value: "certificate", label: t("addHost.certificateFromInfrastructureSCa") },
            { value: "key", label: t("addHost.fixedKeyInAuthorizedKeys") },
          ]}
        />
        <SelectField label={t("addHost.reachItThrough")} value={jump} onChange={(e) => setJump(e.target.value)} options={[{ value: "", label: t("addHost.directly") }, ...jumps.map((h) => ({ value: h.id, label: t("addHost.jumpHost", { name: h.name }) }))]} />
      </div>
      <Switch checked={containers} onCheckedChange={setContainers} label={t("addHost.readContainers")} description={t("addHost.throughDockerOrPodmanOn")} />
    </Dialog>
  );
}

/** Shown until an admin checks the key the host presents against the host itself (ADR 0031). */
export function HostKeyCheck({ host, call, onDone }: { host: Host; call: Call; onDone: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [error, setError] = useState<string>();
  const changed = host.status === "host-key-changed";
  const accept = (fingerprint: string) =>
    call(`/api/v1/hosts/${host.id}/host-key/accept`, { method: "POST", body: JSON.stringify({ fingerprint }) }).then(onDone, (e: Error) => setError(e.message));
  if (!host.pendingHostKeys.length) {
    return (
      <Callout tone="info" title={t("hostKeyCheck.noHostKeyYet")} action={can("admin") && <Button size="sm" onClick={() => void call(`/api/v1/hosts/${host.id}/host-key`, { method: "POST" }).then(onDone)}>{t("hostKeyCheck.askAgain")}</Button>}>
        {host.statusDetail ?? t("hostKeyCheck.waitingForToAskThe", { name: host.agent.name })}
      </Callout>
    );
  }
  return (
    <Callout tone={changed ? "danger" : "warning"} title={changed ? t("hostKeyCheck.theHostKeyChanged") : t("hostKeyCheck.checkTheHostKey")}>
      <span className="flex flex-col gap-2">
        {host.fileHostKey && (
          <span>
            {t("hostKeyCheck.theHostsFileTrusts")}{" "}<code className="infra-wrap font-mono text-xs">{host.fileHostKey}</code> {t("hostKeyCheck.forThisHostAndThe")}
          </span>
        )}
        <span>
          {changed
            ? t("hostKeyCheck.theHostPresentsADifferent")
            : t("hostKeyCheck.runThisOnTheHost")}
        </span>
        <code className="font-mono text-xs">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>
        {host.pendingHostKeys.map((k) => (
          <span key={k.fingerprint} className="flex flex-wrap items-center gap-2">
            <code className="infra-wrap font-mono text-sm">{k.fingerprint}</code> <span className="text-xs text-fg-muted">{k.type}</span>
            {can("admin") && !host.fileHostKey && (
              <Button size="sm" icon={<ShieldCheck />} onClick={() => void accept(k.fingerprint)}>
                {t("hostKeyCheck.itMatchesAccept")}
              </Button>
            )}
          </span>
        ))}
        {error && <span className="text-danger">{error}</span>}
      </span>
    </Callout>
  );
}

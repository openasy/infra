import { Badge, Button, Callout, EmptyState, navigate, PageHeader, Panel, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { Agent, Host, Summary } from "./api.ts";
import { duration, List, Status, Usage, useData, type Call } from "./shared.tsx";
import { useT } from "./i18n.ts";

export function HostsPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const { data } = useData<{ hosts: Host[] }>(call, "/api/v1/hosts");
  const agents = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 0);
  const file = useData<Summary>(call, "/api/v1/summary").data?.hostsFile;
  const hosts = data?.hosts;
  const added = (hosts ?? []).filter((h) => h.source === "ui");
  // Other products link to a host by its name, the key the hosts file gives every product (ADR 0052): /hosts?name=web.
  const wanted = new URLSearchParams(location.search).get("name");
  const found = wanted ? hosts?.find((h) => h.name === wanted) : undefined;
  useEffect(() => {
    if (found) navigate(`/hosts/${found.id}`, { replace: true });
  }, [found]);
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
    {
      id: "uptime",
      header: t("hostsPage.up"),
      width: "70px",
      cell: (h) => (h.summary ? duration(h.summary.uptimeSec) : "–"),
      sortValue: (h) => h.summary?.uptimeSec ?? -1,
    },
    {
      id: "load",
      header: t("hostsPage.load"),
      width: "70px",
      align: "right",
      mono: true,
      cell: (h) => (h.summary ? h.summary.load[0]!.toFixed(2) : "–"),
      sortValue: (h) => h.summary?.load[0] ?? -1,
    },
    {
      id: "mem",
      header: t("hostsPage.memory"),
      width: "120px",
      cell: (h) => (h.summary ? <Usage pct={Math.round((1 - h.summary.memoryAvailableKb / h.summary.memoryTotalKb) * 100)} /> : "–"),
      sortValue: (h) => (h.summary ? 1 - h.summary.memoryAvailableKb / h.summary.memoryTotalKb : -1),
    },
    {
      id: "disk",
      header: t("hostsPage.fullestDisk"),
      width: "120px",
      cell: (h) => (h.summary?.fullestDisk ? <Usage pct={h.summary.fullestDisk.pct} /> : "–"),
      sortValue: (h) => h.summary?.fullestDisk?.pct ?? -1,
    },
    { id: "seen", header: t("hostsPage.collected"), width: "110px", cell: (h) => ago(h.lastSuccessAt), sortValue: (h) => h.lastSuccessAt ?? "" },
  ];
  return (
    <>
      <PageHeader title={t("hostsPage.hosts")} description={t("hostsPage.readOverSshAsThe")} />
      {wanted && hosts && !found && (
        <Callout tone="warning" title={t("hostsPage.noHostNamed", { name: wanted })}>
          {t("hostsPage.noHostNamedText")}
        </Callout>
      )}
      {agents.data?.agents.length === 0 && (
        <Callout
          tone="info"
          title={t("hostsPage.addAnAgentFirst")}
          action={
            can("admin") && (
              <Button size="sm" onClick={() => navigate("/agents")}>
                {t("hostsPage.agents")}
              </Button>
            )
          }
        >
          {t("hostsPage.anAgentReadsTheHosts")}
        </Callout>
      )}
      {file?.error && (
        <Callout tone="danger" title={t("hostsPage.theHostsFileIsNot")}>
          {t("hostsPage.theHostsFromItsLast", { error: file.error, path: file.path })}
        </Callout>
      )}
      {!!file?.warnings.length && (
        <Callout tone="warning" title={t("hostsPage.theHostsFileHasSomething")}>
          {file.warnings.join(" ")}
        </Callout>
      )}
      {!!added.length && (
        <Callout tone="info" title={t("hostsPage.addedHereBefore", { count: added.length })}>
          {t("hostsPage.copyTheseIntoTheHostsFile")}
          <pre className="mt-2 mb-0 overflow-x-auto rounded-md bg-subtle p-3 font-mono text-xs">{toYaml(added)}</pre>
        </Callout>
      )}
      {hosts?.length === 0 ? (
        <EmptyState title={t("hostsPage.noHostsYet")}>
          {t("hostsPage.prepareAHostWithThe")} <a href="/setup">{t("hostsPage.setup")}</a>
          {t("hostsPage.thenListItInTheHostsFile")}
          <pre className="mt-3 mb-0 text-left font-mono text-xs">{EXAMPLE}</pre>
        </EmptyState>
      ) : (
        <Panel flush>
          <List label={t("hostsPage.hosts")} rows={hosts} columns={columns} empty={t("hostsPage.noHosts")} getRowId={(h) => h.id} />
        </Panel>
      )}
    </>
  );
}

// What to write in the hosts file (ADR 0052), shown where there is nothing yet.
const EXAMPLE = `hosts:
  - name: web-1
    address: 10.0.0.5
    agent: dc1
  - name: db-1
    address: 10.0.0.6
    jump: web-1`;

/** The entries of the hosts file for hosts added here before it was the way in. */
function toYaml(hosts: Host[]): string {
  const entry = (h: Host) => {
    const lines = [`  - name: ${h.name}`, `    address: ${h.address}`, `    agent: ${h.agent.name}`];
    if (h.port !== 22) lines.push(`    port: ${h.port}`);
    if (h.user !== "openasy") lines.push(`    user: ${h.user}`);
    if (h.auth === "key") lines.push("    auth: key");
    if (h.jumpHost) lines.push(`    jump: ${h.jumpHost.name}`);
    if (h.containers) lines.push("    containers: true");
    if (Object.keys(h.tags).length)
      lines.push(
        `    tags: { ${Object.entries(h.tags)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")} }`,
      );
    return lines.join("\n");
  };
  return ["hosts:", ...hosts.map(entry)].join("\n");
}

export function HostKeyCheck({ host, call, onDone }: { host: Host; call: Call; onDone: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [error, setError] = useState<string>();
  const changed = host.status === "host-key-changed";
  const accept = (fingerprint: string) =>
    call(`/api/v1/hosts/${host.id}/host-key/accept`, { method: "POST", body: JSON.stringify({ fingerprint }) }).then(onDone, (e: Error) => setError(e.message));
  if (!host.pendingHostKeys.length) {
    return (
      <Callout
        tone="info"
        title={t("hostKeyCheck.noHostKeyYet")}
        action={
          can("admin") && (
            <Button size="sm" onClick={() => void call(`/api/v1/hosts/${host.id}/host-key`, { method: "POST" }).then(onDone)}>
              {t("hostKeyCheck.askAgain")}
            </Button>
          )
        }
      >
        {host.statusDetail ?? t("hostKeyCheck.waitingForToAskThe", { name: host.agent.name })}
      </Callout>
    );
  }
  return (
    <Callout tone={changed ? "danger" : "warning"} title={changed ? t("hostKeyCheck.theHostKeyChanged") : t("hostKeyCheck.checkTheHostKey")}>
      <span className="flex flex-col gap-2">
        {host.fileHostKey && (
          <span>
            {t("hostKeyCheck.theHostsFileTrusts")} <code className="infra-wrap font-mono text-xs">{host.fileHostKey}</code>{" "}
            {t("hostKeyCheck.forThisHostAndThe")}
          </span>
        )}
        <span>{changed ? t("hostKeyCheck.theHostPresentsADifferent") : t("hostKeyCheck.runThisOnTheHost")}</span>
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

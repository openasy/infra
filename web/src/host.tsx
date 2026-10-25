import { Badge, Button, Callout, EmptyState, KpiCard, KpiGrid, navigate, PageHeader, Panel, SearchInput, Tabs, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Change, Container, Facts, Host } from "./api.ts";
import { HostKeyCheck } from "./hosts.tsx";
import { bytes, ChangeList, duration, List, Pairs, Status, Usage, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";

type Tab = "overview" | "ports" | "processes" | "services" | "access" | "packages" | "containers" | "network" | "storage" | "changes";

type F = Facts;
type Unreadable = "ports" | "authorizedKeys" | "sudoRules" | "sshServerSettings" | "firewallRules" | "containers";
const notReadable = (t: T, what: Unreadable) => (
  <EmptyState title={t("notReadable.title")}>{t("notReadable.body", { what: t(`notReadable.${what}`) })}</EmptyState>
);

function Ports({ f }: { f: F }) {
  const t = useT();
  if (!f.ports) return notReadable(t, "ports");
  const cols: Column<NonNullable<F["ports"]>[number]>[] = [
    { id: "proto", header: t("ports.protocol"), width: "90px", cell: (p) => p.proto },
    { id: "addr", header: t("ports.address"), mono: true, cell: (p) => p.address, sortValue: (p) => p.address },
    { id: "port", header: t("ports.port"), width: "80px", align: "right", mono: true, cell: (p) => p.port, sortValue: (p) => p.port },
    { id: "process", header: t("ports.process"), cell: (p) => p.process ?? <span className="text-fg-muted">{t("ports.needsTheSudoRules")}</span> },
    { id: "pid", header: "PID", width: "80px", align: "right", mono: true, cell: (p) => p.pid ?? "–" },
  ];
  return (
    <List
      label={t("ports.listeningPorts")}
      rows={f.ports}
      columns={cols}
      empty={t("ports.nothingListens")}
      getRowId={(p) => `${p.proto}${p.address}${p.port}`}
    />
  );
}

function Processes({ f }: { f: F }) {
  const t = useT();
  const cols: Column<F["processes"][number]>[] = [
    { id: "pid", header: "PID", width: "80px", align: "right", mono: true, cell: (p) => p.pid, sortValue: (p) => p.pid },
    { id: "user", header: t("processes.user"), width: "120px", cell: (p) => p.user, sortValue: (p) => p.user },
    { id: "cpu", header: t("processes.cpu"), width: "80px", align: "right", mono: true, cell: (p) => p.cpu.toFixed(1), sortValue: (p) => p.cpu },
    { id: "rss", header: t("processes.memory"), width: "90px", align: "right", mono: true, cell: (p) => bytes(p.rssKb * 1024), sortValue: (p) => p.rssKb },
    { id: "age", header: t("processes.running"), width: "90px", cell: (p) => duration(p.ageSec), sortValue: (p) => p.ageSec },
    { id: "cmd", header: t("processes.command"), cell: (p) => <span className="infra-wrap font-mono text-xs">{p.command}</span> },
  ];
  return (
    <List
      label={t("processes.processes")}
      rows={f.processes}
      columns={cols}
      empty={t("processes.noProcessesRead")}
      getRowId={(p) => String(p.pid)}
      pageSize={100}
    />
  );
}

function Services({ f }: { f: F }) {
  const msg = useT();
  if (!f.services) return <EmptyState title={msg("services.noSystemd")}>{msg("services.thisHostDoesNotRun")}</EmptyState>;
  const cols: Column<NonNullable<F["services"]>[number]>[] = [
    { id: "name", header: msg("services.service"), cell: (s) => s.name, sortValue: (s) => s.name },
    {
      id: "active",
      header: msg("services.state"),
      width: "140px",
      cell: (s) => <Badge tone={s.active === "active" ? "success" : s.active === "failed" ? "danger" : "neutral"}>{`${s.active}/${s.sub}`}</Badge>,
      sortValue: (s) => s.active,
    },
    { id: "enabled", header: msg("services.atBoot"), width: "110px", cell: (s) => s.enabled ?? "–" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <List label={msg("services.services")} rows={f.services} columns={cols} empty={msg("services.noServices")} getRowId={(s) => s.name} />
      <Panel title={msg("services.scheduled")}>
        <ul className="infra-list flex flex-col gap-1 font-mono text-xs">
          {(f.timers ?? []).map((t) => (
            <li key={t.unit}>
              {t.unit} → {t.activates} {t.next && <span className="text-fg-muted">next {t.next}</span>}
            </li>
          ))}
          {f.cron.map((c) => (
            <li key={c.source + c.entry} className="infra-wrap">
              {c.source}: {c.entry}
            </li>
          ))}
          {f.crontabUsers?.map((u) => (
            <li key={u}>{msg("services.crontabOf", { u })}</li>
          ))}
          {!f.timers?.length && !f.cron.length && !f.crontabUsers?.length && <li className="text-fg-muted">{msg("services.nothingScheduled")}</li>}
        </ul>
      </Panel>
    </div>
  );
}

function Access({ f }: { f: F }) {
  const t = useT();
  const people = f.users.filter((u) => u.login || u.uid === 0);
  const cols: Column<F["users"][number]>[] = [
    { id: "name", header: t("access.account"), cell: (u) => u.name, sortValue: (u) => u.name },
    { id: "uid", header: "UID", width: "80px", align: "right", mono: true, cell: (u) => u.uid, sortValue: (u) => u.uid },
    { id: "shell", header: t("access.shell"), mono: true, cell: (u) => u.shell },
    { id: "home", header: t("access.home"), mono: true, cell: (u) => u.home },
    {
      id: "pw",
      header: t("access.password"),
      width: "110px",
      cell: (u) =>
        u.password ? (
          <Badge tone={u.password === "set" ? "warning" : "neutral"}>{u.password}</Badge>
        ) : (
          <span className="text-fg-muted">{t("access.notReadable")}</span>
        ),
    },
    {
      id: "groups",
      header: t("access.groups"),
      cell: (u) =>
        f.groups
          .filter((g) => g.members.includes(u.name))
          .map((g) => g.name)
          .join(", ") || "–",
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("access.accountsThatCanLogIn")} description={t("access.ofAccountsHaveALogin", { length: people.length, length2: f.users.length })} flush>
        <List label={t("access.accounts")} rows={people} columns={cols} empty={t("access.noAccountsWithALogin")} getRowId={(u) => u.name} />
      </Panel>
      <Panel title={t("access.sshKeysThatMayLog")}>
        {f.authorizedKeys === null ? (
          notReadable(t, "authorizedKeys")
        ) : f.authorizedKeys.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">{t("access.none")}</p>
        ) : (
          <ul className="infra-list flex flex-col gap-1 font-mono text-xs">
            {f.authorizedKeys.map((k) => (
              <li key={k.file + k.fingerprint} className="infra-wrap">
                {k.user}: {k.fingerprint} {k.type} {k.comment}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="sudo">
        {f.sudo === null ? (
          notReadable(t, "sudoRules")
        ) : (
          <ul className="infra-list flex flex-col gap-1 font-mono text-xs">
            {f.sudo.map((s) => (
              <li key={s} className="infra-wrap">
                {s}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t("access.sshServer")}>
        {f.sshd === null ? (
          notReadable(t, "sshServerSettings")
        ) : (
          <Pairs
            items={(
              [
                "permitrootlogin",
                "passwordauthentication",
                "pubkeyauthentication",
                "kbdinteractiveauthentication",
                "x11forwarding",
                "allowtcpforwarding",
                "maxauthtries",
                "trustedusercakeys",
              ] as const
            )
              .filter((k) => f.sshd![k] !== undefined)
              .map((k) => [
                k,
                <span key={k} className="font-mono">
                  {f.sshd![k]}
                </span>,
              ])}
          />
        )}
      </Panel>
    </div>
  );
}

function Packages({ f }: { f: F }) {
  const t = useT();
  const [q, setQ] = useState("");
  const rows = useMemo(() => f.packages.filter((p) => !q || p.name.includes(q.toLowerCase())), [f, q]);
  const cols: Column<F["packages"][number]>[] = [
    { id: "name", header: t("packages.package"), cell: (p) => p.name, sortValue: (p) => p.name },
    { id: "version", header: t("packages.version"), mono: true, cell: (p) => p.version },
    { id: "arch", header: t("packages.arch"), width: "90px", cell: (p) => p.arch ?? "–" },
    { id: "mgr", header: t("packages.from"), width: "80px", cell: (p) => p.manager },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div style={{ maxWidth: 320 }}>
        <SearchInput label={t("packages.searchPackages")} value={q} onChange={(e) => setQ(e.target.value)} placeholder="openssl" />
      </div>
      <List
        label={t("packages.packages")}
        rows={rows}
        columns={cols}
        empty={t("packages.noPackages")}
        getRowId={(p) => `${p.manager}${p.name}${p.arch}`}
        pageSize={100}
      />
    </div>
  );
}

export function ContainerTable({
  rows,
  showHost = false,
}: {
  rows: Array<Container & { host?: { id: string; name: string } }> | undefined;
  showHost?: boolean;
}) {
  const t = useT();
  const cols: Column<Container & { host?: { id: string; name: string } }>[] = [
    { id: "name", header: t("containerTable.container"), cell: (c) => c.name, sortValue: (c) => c.name },
    ...(showHost
      ? [
          {
            id: "host",
            header: t("containerTable.host"),
            cell: (c: Container & { host?: { id: string; name: string } }) => c.host && <a href={`/hosts/${c.host.id}`}>{c.host.name}</a>,
          },
        ]
      : []),
    { id: "image", header: t("containerTable.image"), cell: (c) => <span className="infra-wrap font-mono text-xs">{c.image}</span> },
    {
      id: "state",
      header: t("containerTable.state"),
      width: "150px",
      cell: (c) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={c.state === "running" ? "success" : c.state === "restarting" || c.state === "exited" ? "danger" : "neutral"}>{c.state}</Badge>
          {c.health && <Badge tone={c.health === "healthy" ? "success" : "warning"}>{c.health}</Badge>}
        </span>
      ),
      sortValue: (c) => c.state,
    },
    { id: "restarts", header: t("containerTable.restarts"), width: "90px", align: "right", mono: true, cell: (c) => c.restarts, sortValue: (c) => c.restarts },
    { id: "ports", header: t("containerTable.ports"), cell: (c) => <span className="font-mono text-xs">{c.ports.join(", ") || "–"}</span> },
    {
      id: "limits",
      header: t("containerTable.limits"),
      width: "120px",
      cell: (c) => `${c.cpuLimit ?? "–"} CPU · ${c.memoryLimitBytes ? bytes(c.memoryLimitBytes) : "–"}`,
    },
    {
      id: "flags",
      header: "",
      width: "110px",
      cell: (c) => (c.privileged ? <Badge tone="danger">privileged</Badge> : c.user === "root" ? <Badge tone="warning">root</Badge> : null),
    },
  ];
  return (
    <List
      label={t("containerTable.containers")}
      rows={rows}
      columns={cols}
      empty={t("containerTable.noContainers")}
      getRowId={(c) => `${c.host?.id ?? ""}${c.id}`}
    />
  );
}

function Network({ f }: { f: F }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("network.interfaces")} flush>
        <List
          label={t("network.interfaces")}
          rows={f.interfaces}
          getRowId={(i) => i.name}
          empty={t("network.ipIsNotInstalledOn")}
          columns={[
            { id: "name", header: t("network.interface"), width: "140px", cell: (i) => i.name },
            { id: "state", header: t("network.state"), width: "90px", cell: (i) => i.state },
            { id: "addr", header: t("network.addresses"), cell: (i) => <span className="font-mono text-xs">{i.addresses.join(", ") || "–"}</span> },
            { id: "mac", header: "MAC", width: "160px", mono: true, cell: (i) => i.mac ?? "–" },
            { id: "mtu", header: "MTU", width: "70px", align: "right", mono: true, cell: (i) => i.mtu ?? "–" },
          ]}
        />
      </Panel>
      <Panel title={t("network.routesAndDns")}>
        <ul className="infra-list flex flex-col gap-1 font-mono text-xs">
          {f.routes.map((r) => (
            <li key={`${r.destination}${r.gateway}${r.device}`}>
              {r.destination} {r.gateway && t("network.via", { gateway: r.gateway })} {r.device && t("network.dev", { device: r.device })}
            </li>
          ))}
          <li>nameservers {f.dns.nameservers.join(", ") || "–"}</li>
        </ul>
      </Panel>
      <Panel title={t("network.firewall")}>
        {f.firewall ? <pre className="infra-code">{f.firewall.rules || t("notReadable.noRules")}</pre> : notReadable(t, "firewallRules")}
      </Panel>
    </div>
  );
}

function Storage({ f }: { f: F }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("storage.fileSystems")} flush>
        <List
          label={t("storage.fileSystems")}
          rows={f.filesystems}
          getRowId={(x) => x.mount}
          empty={t("storage.noFileSystems")}
          columns={[
            { id: "mount", header: t("storage.mountedAt"), mono: true, cell: (x) => x.mount, sortValue: (x) => x.mount },
            { id: "dev", header: t("storage.device"), mono: true, cell: (x) => x.device },
            { id: "type", header: t("storage.type"), width: "90px", cell: (x) => x.type },
            { id: "size", header: t("storage.size"), width: "90px", align: "right", cell: (x) => bytes(x.sizeKb * 1024), sortValue: (x) => x.sizeKb },
            {
              id: "used",
              header: t("storage.used"),
              width: "120px",
              cell: (x) => (x.sizeKb ? <Usage pct={Math.round((x.usedKb / x.sizeKb) * 100)} /> : "–"),
              sortValue: (x) => (x.sizeKb ? x.usedKb / x.sizeKb : 0),
            },
            { id: "ro", header: "", width: "60px", cell: (x) => (x.options.split(",").includes("ro") ? <Badge>ro</Badge> : null) },
          ]}
        />
      </Panel>
      {f.disks.length > 0 && (
        <Panel title={t("storage.disks")}>
          <ul className="infra-list flex flex-col gap-1 text-sm">
            {f.disks.map((d) => (
              <li key={d.name}>
                {d.name} · {bytes(d.sizeBytes)} {d.model && `· ${d.model}`}{" "}
                {d.rotational === false ? t("storage.ssd") : d.rotational ? t("storage.rotational") : ""}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function Overview({ f, host }: { f: F; host: Host }) {
  const ago = useAgo();
  const t = useT();
  const memPct = Math.round((1 - f.memory.availableKb / f.memory.totalKb) * 100);
  return (
    <div className="flex flex-col gap-4">
      <KpiGrid>
        <KpiCard label={t("overview.load1Min")} value={f.system.load[0].toFixed(2)} footer={t("overview.threads", { threads: f.cpu.threads })} />
        <KpiCard
          label={t("overview.memoryUsed")}
          value={memPct}
          unit="%"
          tone={memPct >= 90 ? "danger" : memPct >= 75 ? "warning" : undefined}
          footer={t("overview.of", { bytes: bytes(f.memory.totalKb * 1024) })}
        />
        <KpiCard
          label={t("overview.up")}
          value={duration(f.system.uptimeSec)}
          footer={t("overview.since", { value: new Date(f.system.bootedAt).toLocaleString() })}
        />
        <KpiCard label={t("overview.listeningPorts")} value={f.ports?.length ?? "–"} footer={t("overview.processes", { length: f.processes.length })} />
      </KpiGrid>
      <Panel title={t("overview.system")}>
        <Pairs
          items={[
            [t("overview.hostName"), f.system.hostname],
            [t("overview.system"), f.system.os.name],
            [t("overview.kernel"), `${f.system.kernel} (${f.system.arch})`],
            ["CPU", t("overview.threads2", { threads: f.cpu.threads, value: f.cpu.model ? ` · ${f.cpu.model}` : "" })],
            [t("overview.memory"), t("overview.swap", { bytes: bytes(f.memory.totalKb * 1024), bytes2: bytes(f.memory.swapTotalKb * 1024) })],
            [
              t("overview.runsOn"),
              f.system.virtualization ?? ([f.system.hardware.sys_vendor, f.system.hardware.product_name].filter(Boolean).join(" ") || "–"),
            ],
            [t("overview.serialNumber"), f.system.serial ?? t("overview.notReadable")],
            [t("overview.machineId"), f.system.machineId ?? "–"],
            [t("overview.packages"), String(f.packages.length)],
            [t("overview.readAs"), `${f.account.user}${f.account.sudo === "all" ? ` ${t("overview.withUnrestrictedSudo")}` : ""}, ${ago(f.collectedAt)}`],
            [
              t("overview.address"),
              t("overview.readBy", {
                user: host.user,
                address: host.address,
                port: host.port,
                value: host.jumpHost ? ` through ${host.jumpHost.name}` : "",
                name: host.agent.name,
              }),
            ],
            [
              t("overview.tags"),
              Object.entries(host.tags)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "–",
            ],
          ]}
        />
      </Panel>
      {f.account.sudo === "all" && (
        <Callout tone="warning" title={t("overview.theOpenasyAccountHasUnrestricted")}>
          {t("overview.itNeedsOnlyTheRead")}
        </Callout>
      )}
    </div>
  );
}

export function HostPage({ call, id }: { call: Call; id: string }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const host = useData<Host>(call, `/api/v1/hosts/${id}`, 10_000);
  const facts = useData<{ facts: F }>(call, host.data?.lastSuccessAt ? `/api/v1/hosts/${id}/facts` : null, 30_000);
  const changes = useData<{ changes: Change[] }>(call, tab === "changes" ? `/api/v1/hosts/${id}/changes?limit=500` : null, 30_000);
  const h = host.data;
  if (host.error && !h) return <EmptyState title={t("hostPage.notFound")}>{t("hostPage.thisHostNoLongerExists")}</EmptyState>;
  if (!h) return null;
  const f = facts.data?.facts;
  const collect = () => void call(`/api/v1/hosts/${id}/collect`, { method: "POST" }).then(() => setTimeout(host.reload, 3000));
  const remove = () =>
    window.confirm(t("hostPage.removeAndItsHistory", { name: h.name })) &&
    void call(`/api/v1/hosts/${id}`, { method: "DELETE" }).then(() => navigate("/hosts"));
  const waitingForKey = h.status === "new" || h.status === "host-key-pending" || h.status === "host-key-changed";
  return (
    <>
      <PageHeader
        title={h.name}
        breadcrumbs={[{ label: t("hostPage.hosts"), href: "/hosts" }, { label: h.name }]}
        description={f ? t("hostPage.collected", { name: f.system.os.name, kernel: f.system.kernel, ago: ago(h.lastSuccessAt) }) : `${h.address}:${h.port}`}
        meta={
          <span className="flex items-center gap-1.5">
            <Status status={h.status} />
            {h.source === "file" && <Badge tone="neutral">{t("hostPage.fromFile")}</Badge>}
          </span>
        }
        actions={
          <>
            {can("editor") && !waitingForKey && (
              <Button icon={<Play />} onClick={collect}>
                {t("hostPage.collectNow")}
              </Button>
            )}
            {can("admin") && h.source === "ui" && (
              <Button variant="danger" icon={<Trash2 />} onClick={remove}>
                {t("hostPage.remove")}
              </Button>
            )}
          </>
        }
      />
      {waitingForKey && <HostKeyCheck host={h} call={call} onDone={host.reload} />}
      {!waitingForKey && h.status !== "ok" && h.statusDetail && (
        <Callout tone="danger" title={t("hostPage.theLastCollectionFailed")}>
          {h.statusDetail} {h.lastSuccessAt && t("hostPage.whatIsShownIsFrom", { ago: ago(h.lastSuccessAt) })}
        </Callout>
      )}
      {f && f.unreadable.length > 0 && (
        <Callout tone="info" title={t("hostPage.someDetailsNeedTheSudo")}>
          {t("hostPage.notReadableAsTheOpenasy")} {f.unreadable.join(", ")}. Add the sudoers file from <a href="/setup">{t("hostPage.setup")}</a> to this host
          to read them.
        </Callout>
      )}
      {f && (
        <>
          <Tabs<Tab>
            label={t("hostPage.hostDetails")}
            value={tab}
            onChange={setTab}
            items={[
              { value: "overview", label: t("hostPage.overview") },
              { value: "ports", label: t("hostPage.ports"), count: f.ports?.length },
              { value: "processes", label: t("hostPage.processes"), count: f.processes.length },
              { value: "services", label: t("hostPage.services"), count: f.services?.length },
              { value: "access", label: t("hostPage.access") },
              { value: "packages", label: t("hostPage.packages"), count: f.packages.length },
              ...(h.containers ? [{ value: "containers" as const, label: t("hostPage.containers"), count: f.containers?.length }] : []),
              { value: "network", label: t("hostPage.network") },
              { value: "storage", label: t("hostPage.storage") },
              { value: "changes", label: t("hostPage.changes") },
            ]}
          />
          {tab === "overview" && <Overview f={f} host={h} />}
          {tab === "ports" && <Ports f={f} />}
          {tab === "processes" && <Processes f={f} />}
          {tab === "services" && <Services f={f} />}
          {tab === "access" && <Access f={f} />}
          {tab === "packages" && <Packages f={f} />}
          {tab === "containers" && (f.containers ? <ContainerTable rows={f.containers} /> : notReadable(t, "containers"))}
          {tab === "network" && <Network f={f} />}
          {tab === "storage" && <Storage f={f} />}
          {tab === "changes" && <ChangeList changes={changes.data?.changes} />}
        </>
      )}
    </>
  );
}

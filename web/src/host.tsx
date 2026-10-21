import { Badge, Button, Callout, EmptyState, KpiCard, KpiGrid, navigate, PageHeader, Panel, SearchInput, Tabs, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Change, Container, Facts, Host } from "./api.ts";
import { HostKeyCheck } from "./hosts.tsx";
import { ago, bytes, ChangeList, duration, List, Pairs, Status, Usage, useData, type Call } from "./shared.tsx";

type Tab = "overview" | "ports" | "processes" | "services" | "access" | "packages" | "containers" | "network" | "storage" | "changes";

type F = Facts;
const notReadable = (what: string) => <EmptyState title="Not readable">{`Reading ${what} needs the sudo rules from Setup on this host.`}</EmptyState>;

function Ports({ f }: { f: F }) {
  if (!f.ports) return notReadable("ports");
  const cols: Column<NonNullable<F["ports"]>[number]>[] = [
    { id: "proto", header: "Protocol", width: "90px", cell: (p) => p.proto },
    { id: "addr", header: "Address", mono: true, cell: (p) => p.address, sortValue: (p) => p.address },
    { id: "port", header: "Port", width: "80px", align: "right", mono: true, cell: (p) => p.port, sortValue: (p) => p.port },
    { id: "process", header: "Process", cell: (p) => p.process ?? <span className="text-fg-muted">needs the sudo rules</span> },
    { id: "pid", header: "PID", width: "80px", align: "right", mono: true, cell: (p) => p.pid ?? "–" },
  ];
  return <List label="Listening ports" rows={f.ports} columns={cols} empty="Nothing listens" getRowId={(p) => `${p.proto}${p.address}${p.port}`} />;
}

function Processes({ f }: { f: F }) {
  const cols: Column<F["processes"][number]>[] = [
    { id: "pid", header: "PID", width: "80px", align: "right", mono: true, cell: (p) => p.pid, sortValue: (p) => p.pid },
    { id: "user", header: "User", width: "120px", cell: (p) => p.user, sortValue: (p) => p.user },
    { id: "cpu", header: "CPU %", width: "80px", align: "right", mono: true, cell: (p) => p.cpu.toFixed(1), sortValue: (p) => p.cpu },
    { id: "rss", header: "Memory", width: "90px", align: "right", mono: true, cell: (p) => bytes(p.rssKb * 1024), sortValue: (p) => p.rssKb },
    { id: "age", header: "Running", width: "90px", cell: (p) => duration(p.ageSec), sortValue: (p) => p.ageSec },
    { id: "cmd", header: "Command", cell: (p) => <span className="infra-wrap font-mono text-xs">{p.command}</span> },
  ];
  return <List label="Processes" rows={f.processes} columns={cols} empty="No processes read" getRowId={(p) => String(p.pid)} pageSize={100} />;
}

function Services({ f }: { f: F }) {
  if (!f.services) return <EmptyState title="No systemd">This host does not run systemd, or its services could not be listed.</EmptyState>;
  const cols: Column<NonNullable<F["services"]>[number]>[] = [
    { id: "name", header: "Service", cell: (s) => s.name, sortValue: (s) => s.name },
    { id: "active", header: "State", width: "140px", cell: (s) => <Badge tone={s.active === "active" ? "success" : s.active === "failed" ? "danger" : "neutral"}>{`${s.active}/${s.sub}`}</Badge>, sortValue: (s) => s.active },
    { id: "enabled", header: "At boot", width: "110px", cell: (s) => s.enabled ?? "–" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <List label="Services" rows={f.services} columns={cols} empty="No services" getRowId={(s) => s.name} />
      <Panel title="Scheduled">
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
          {f.crontabUsers?.map((u) => <li key={u}>crontab of {u}</li>)}
          {!f.timers?.length && !f.cron.length && !f.crontabUsers?.length && <li className="text-fg-muted">Nothing scheduled</li>}
        </ul>
      </Panel>
    </div>
  );
}

function Access({ f }: { f: F }) {
  const people = f.users.filter((u) => u.login || u.uid === 0);
  const cols: Column<F["users"][number]>[] = [
    { id: "name", header: "Account", cell: (u) => u.name, sortValue: (u) => u.name },
    { id: "uid", header: "UID", width: "80px", align: "right", mono: true, cell: (u) => u.uid, sortValue: (u) => u.uid },
    { id: "shell", header: "Shell", mono: true, cell: (u) => u.shell },
    { id: "home", header: "Home", mono: true, cell: (u) => u.home },
    { id: "pw", header: "Password", width: "110px", cell: (u) => (u.password ? <Badge tone={u.password === "set" ? "warning" : "neutral"}>{u.password}</Badge> : <span className="text-fg-muted">not readable</span>) },
    { id: "groups", header: "Groups", cell: (u) => f.groups.filter((g) => g.members.includes(u.name)).map((g) => g.name).join(", ") || "–" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Accounts that can log in" description={`${people.length} of ${f.users.length} accounts have a login shell.`} flush>
        <List label="Accounts" rows={people} columns={cols} empty="No accounts with a login shell" getRowId={(u) => u.name} />
      </Panel>
      <Panel title="SSH keys that may log in">
        {f.authorizedKeys === null ? (
          notReadable("authorized keys")
        ) : f.authorizedKeys.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">None</p>
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
          notReadable("sudo rules")
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
      <Panel title="SSH server">
        {f.sshd === null ? (
          notReadable("the SSH server settings")
        ) : (
          <Pairs items={(["permitrootlogin", "passwordauthentication", "pubkeyauthentication", "kbdinteractiveauthentication", "x11forwarding", "allowtcpforwarding", "maxauthtries", "trustedusercakeys"] as const).filter((k) => f.sshd![k] !== undefined).map((k) => [k, <span className="font-mono">{f.sshd![k]}</span>])} />
        )}
      </Panel>
    </div>
  );
}

function Packages({ f }: { f: F }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => f.packages.filter((p) => !q || p.name.includes(q.toLowerCase())), [f, q]);
  const cols: Column<F["packages"][number]>[] = [
    { id: "name", header: "Package", cell: (p) => p.name, sortValue: (p) => p.name },
    { id: "version", header: "Version", mono: true, cell: (p) => p.version },
    { id: "arch", header: "Arch", width: "90px", cell: (p) => p.arch ?? "–" },
    { id: "mgr", header: "From", width: "80px", cell: (p) => p.manager },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div style={{ maxWidth: 320 }}>
        <SearchInput label="Search packages" value={q} onChange={(e) => setQ(e.target.value)} placeholder="openssl" />
      </div>
      <List label="Packages" rows={rows} columns={cols} empty="No packages" getRowId={(p) => `${p.manager}${p.name}${p.arch}`} pageSize={100} />
    </div>
  );
}

export function ContainerTable({ rows, showHost = false }: { rows: Array<Container & { host?: { id: string; name: string } }> | undefined; showHost?: boolean }) {
  const cols: Column<Container & { host?: { id: string; name: string } }>[] = [
    { id: "name", header: "Container", cell: (c) => c.name, sortValue: (c) => c.name },
    ...(showHost ? [{ id: "host", header: "Host", cell: (c: Container & { host?: { id: string; name: string } }) => c.host && <a href={`/hosts/${c.host.id}`}>{c.host.name}</a> }] : []),
    { id: "image", header: "Image", cell: (c) => <span className="infra-wrap font-mono text-xs">{c.image}</span> },
    {
      id: "state",
      header: "State",
      width: "150px",
      cell: (c) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={c.state === "running" ? "success" : c.state === "restarting" || c.state === "exited" ? "danger" : "neutral"}>{c.state}</Badge>
          {c.health && <Badge tone={c.health === "healthy" ? "success" : "warning"}>{c.health}</Badge>}
        </span>
      ),
      sortValue: (c) => c.state,
    },
    { id: "restarts", header: "Restarts", width: "90px", align: "right", mono: true, cell: (c) => c.restarts, sortValue: (c) => c.restarts },
    { id: "ports", header: "Ports", cell: (c) => <span className="font-mono text-xs">{c.ports.join(", ") || "–"}</span> },
    { id: "limits", header: "Limits", width: "120px", cell: (c) => `${c.cpuLimit ?? "–"} CPU · ${c.memoryLimitBytes ? bytes(c.memoryLimitBytes) : "–"}` },
    { id: "flags", header: "", width: "110px", cell: (c) => (c.privileged ? <Badge tone="danger">privileged</Badge> : c.user === "root" ? <Badge tone="warning">root</Badge> : null) },
  ];
  return <List label="Containers" rows={rows} columns={cols} empty="No containers" getRowId={(c) => `${c.host?.id ?? ""}${c.id}`} />;
}

function Network({ f }: { f: F }) {
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Interfaces" flush>
        <List
          label="Interfaces"
          rows={f.interfaces}
          getRowId={(i) => i.name}
          empty="ip is not installed on this host"
          columns={[
            { id: "name", header: "Interface", width: "140px", cell: (i) => i.name },
            { id: "state", header: "State", width: "90px", cell: (i) => i.state },
            { id: "addr", header: "Addresses", cell: (i) => <span className="font-mono text-xs">{i.addresses.join(", ") || "–"}</span> },
            { id: "mac", header: "MAC", width: "160px", mono: true, cell: (i) => i.mac ?? "–" },
            { id: "mtu", header: "MTU", width: "70px", align: "right", mono: true, cell: (i) => i.mtu ?? "–" },
          ]}
        />
      </Panel>
      <Panel title="Routes and DNS">
        <ul className="infra-list flex flex-col gap-1 font-mono text-xs">
          {f.routes.map((r) => (
            <li key={`${r.destination}${r.gateway}${r.device}`}>
              {r.destination} {r.gateway && `via ${r.gateway}`} {r.device && `dev ${r.device}`}
            </li>
          ))}
          <li>nameservers {f.dns.nameservers.join(", ") || "–"}</li>
        </ul>
      </Panel>
      <Panel title="Firewall">{f.firewall ? <pre className="infra-code">{f.firewall.rules || "(no rules)"}</pre> : notReadable("the firewall rules")}</Panel>
    </div>
  );
}

function Storage({ f }: { f: F }) {
  return (
    <div className="flex flex-col gap-4">
      <Panel title="File systems" flush>
        <List
          label="File systems"
          rows={f.filesystems}
          getRowId={(x) => x.mount}
          empty="No file systems"
          columns={[
            { id: "mount", header: "Mounted at", mono: true, cell: (x) => x.mount, sortValue: (x) => x.mount },
            { id: "dev", header: "Device", mono: true, cell: (x) => x.device },
            { id: "type", header: "Type", width: "90px", cell: (x) => x.type },
            { id: "size", header: "Size", width: "90px", align: "right", cell: (x) => bytes(x.sizeKb * 1024), sortValue: (x) => x.sizeKb },
            { id: "used", header: "Used", width: "120px", cell: (x) => (x.sizeKb ? <Usage pct={Math.round((x.usedKb / x.sizeKb) * 100)} /> : "–"), sortValue: (x) => (x.sizeKb ? x.usedKb / x.sizeKb : 0) },
            { id: "ro", header: "", width: "60px", cell: (x) => (x.options.split(",").includes("ro") ? <Badge>ro</Badge> : null) },
          ]}
        />
      </Panel>
      {f.disks.length > 0 && (
        <Panel title="Disks">
          <ul className="infra-list flex flex-col gap-1 text-sm">
            {f.disks.map((d) => (
              <li key={d.name}>
                {d.name} · {bytes(d.sizeBytes)} {d.model && `· ${d.model}`} {d.rotational === false ? "· SSD" : d.rotational ? "· rotational" : ""}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function Overview({ f, host }: { f: F; host: Host }) {
  const memPct = Math.round((1 - f.memory.availableKb / f.memory.totalKb) * 100);
  return (
    <div className="flex flex-col gap-4">
      <KpiGrid>
        <KpiCard label="Load (1 min)" value={f.system.load[0].toFixed(2)} footer={`${f.cpu.threads} threads`} />
        <KpiCard label="Memory used" value={memPct} unit="%" tone={memPct >= 90 ? "danger" : memPct >= 75 ? "warning" : undefined} footer={`of ${bytes(f.memory.totalKb * 1024)}`} />
        <KpiCard label="Up" value={duration(f.system.uptimeSec)} footer={`since ${new Date(f.system.bootedAt).toLocaleString()}`} />
        <KpiCard label="Listening ports" value={f.ports?.length ?? "–"} footer={`${f.processes.length} processes`} />
      </KpiGrid>
      <Panel title="System">
        <Pairs
          items={[
            ["Host name", f.system.hostname],
            ["System", f.system.os.name],
            ["Kernel", `${f.system.kernel} (${f.system.arch})`],
            ["CPU", `${f.cpu.threads} threads${f.cpu.model ? ` · ${f.cpu.model}` : ""}`],
            ["Memory", `${bytes(f.memory.totalKb * 1024)}, swap ${bytes(f.memory.swapTotalKb * 1024)}`],
            ["Runs on", f.system.virtualization ?? ([f.system.hardware.sys_vendor, f.system.hardware.product_name].filter(Boolean).join(" ") || "–")],
            ["Serial number", f.system.serial ?? "not readable"],
            ["Machine id", f.system.machineId ?? "–"],
            ["Packages", String(f.packages.length)],
            ["Read as", `${f.account.user}${f.account.sudo === "all" ? " with unrestricted sudo" : ""}, ${ago(f.collectedAt)}`],
            ["Address", `${host.user}@${host.address}:${host.port}${host.jumpHost ? ` through ${host.jumpHost.name}` : ""}, read by ${host.agent.name}`],
            ["Tags", Object.entries(host.tags).map(([k, v]) => `${k}=${v}`).join(", ") || "–"],
          ]}
        />
      </Panel>
      {f.account.sudo === "all" && (
        <Callout tone="warning" title="The openasy account has unrestricted sudo">
          It needs only the read-only rules from Setup. With full sudo, anyone who controls the agent controls this host.
        </Callout>
      )}
    </div>
  );
}

export function HostPage({ call, id }: { call: Call; id: string }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const host = useData<Host>(call, `/api/v1/hosts/${id}`, 10_000);
  const facts = useData<{ facts: F }>(call, host.data?.lastSuccessAt ? `/api/v1/hosts/${id}/facts` : null, 30_000);
  const changes = useData<{ changes: Change[] }>(call, tab === "changes" ? `/api/v1/hosts/${id}/changes?limit=500` : null, 30_000);
  const h = host.data;
  if (host.error && !h) return <EmptyState title="Not found">This host no longer exists.</EmptyState>;
  if (!h) return null;
  const f = facts.data?.facts;
  const collect = () => void call(`/api/v1/hosts/${id}/collect`, { method: "POST" }).then(() => setTimeout(host.reload, 3000));
  const remove = () => window.confirm(`Remove ${h.name} and its history?`) && void call(`/api/v1/hosts/${id}`, { method: "DELETE" }).then(() => navigate("/hosts"));
  const waitingForKey = h.status === "new" || h.status === "host-key-pending" || h.status === "host-key-changed";
  return (
    <>
      <PageHeader
        title={h.name}
        breadcrumbs={[{ label: "Hosts", href: "/hosts" }, { label: h.name }]}
        description={f ? `${f.system.os.name} · ${f.system.kernel} · collected ${ago(h.lastSuccessAt)}` : `${h.address}:${h.port}`}
        meta={<Status status={h.status} />}
        actions={
          <>
            {can("editor") && !waitingForKey && (
              <Button icon={<Play />} onClick={collect}>
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
      {waitingForKey && <HostKeyCheck host={h} call={call} onDone={host.reload} />}
      {!waitingForKey && h.status !== "ok" && h.statusDetail && (
        <Callout tone="danger" title="The last collection failed">
          {h.statusDetail} {h.lastSuccessAt && `What is shown is from ${ago(h.lastSuccessAt)}.`}
        </Callout>
      )}
      {f && f.unreadable.length > 0 && (
        <Callout tone="info" title="Some details need the sudo rules">
          Not readable as the openasy account: {f.unreadable.join(", ")}. Add the sudoers file from <a href="/setup">Setup</a> to this host to read them.
        </Callout>
      )}
      {f && (
        <>
          <Tabs<Tab>
            label="Host details"
            value={tab}
            onChange={setTab}
            items={[
              { value: "overview", label: "Overview" },
              { value: "ports", label: "Ports", count: f.ports?.length },
              { value: "processes", label: "Processes", count: f.processes.length },
              { value: "services", label: "Services", count: f.services?.length },
              { value: "access", label: "Access" },
              { value: "packages", label: "Packages", count: f.packages.length },
              ...(h.containers ? [{ value: "containers" as const, label: "Containers", count: f.containers?.length }] : []),
              { value: "network", label: "Network" },
              { value: "storage", label: "Storage" },
              { value: "changes", label: "Changes" },
            ]}
          />
          {tab === "overview" && <Overview f={f} host={h} />}
          {tab === "ports" && <Ports f={f} />}
          {tab === "processes" && <Processes f={f} />}
          {tab === "services" && <Services f={f} />}
          {tab === "access" && <Access f={f} />}
          {tab === "packages" && <Packages f={f} />}
          {tab === "containers" && (f.containers ? <ContainerTable rows={f.containers} /> : notReadable("containers"))}
          {tab === "network" && <Network f={f} />}
          {tab === "storage" && <Storage f={f} />}
          {tab === "changes" && <ChangeList changes={changes.data?.changes} />}
        </>
      )}
    </>
  );
}

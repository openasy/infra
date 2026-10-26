import { Badge, Button, Callout, EmptyState, KpiCard, KpiGrid, PageHeader, Panel, Tabs, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Play, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { Bmc, BmcFacts, Change, HostHardware, Summary } from "./api.ts";
import { bytes, ChangeList, List, Pairs, Status, useData, type Call } from "./shared.tsx";
import { useT } from "./i18n.ts";

type Tab = "overview" | "hardware" | "storage" | "firmware" | "access" | "events" | "changes";
type F = BmcFacts;

const HEALTH_TONE = { OK: "success", Warning: "warning", Critical: "danger" } as const;
export function Health({ health }: { health: string | null }) {
  if (!health) return <span className="text-fg-muted">–</span>;
  return <Badge tone={HEALTH_TONE[health as keyof typeof HEALTH_TONE] ?? "neutral"}>{health}</Badge>;
}

// What to write in the hosts file (ADR 0052, 0055), shown where there is nothing yet.
const EXAMPLE = `bmcs:
  - name: db-1-idrac
    address: 10.0.9.6
    server: db-1             # its server in hosts:
    user: openasy            # a ReadOnly account on the BMC
    passwordFile: db-1-bmc   # in the agent's key folder
    agent: dc1`;

export function BmcsPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { data } = useData<{ bmcs: Bmc[] }>(call, "/api/v1/bmcs");
  const file = useData<Summary>(call, "/api/v1/summary").data?.hostsFile;
  const columns: Column<Bmc>[] = [
    { id: "name", header: t("bmcs.bmc"), cell: (b) => <a href={`/bmcs/${b.id}`}>{b.name}</a>, sortValue: (b) => b.name },
    { id: "status", header: t("bmcs.status"), width: "180px", cell: (b) => <Status status={b.status} />, sortValue: (b) => b.status },
    {
      id: "server",
      header: t("bmcs.server"),
      cell: (b) => <ServerCell bmc={b} />,
      sortValue: (b) => b.match?.host?.name ?? b.server?.name ?? "",
    },
    { id: "model", header: t("bmcs.model"), cell: (b) => [b.summary?.vendor, b.summary?.model].filter(Boolean).join(" ") || "–" },
    { id: "serial", header: t("bmcs.serial"), mono: true, cell: (b) => b.summary?.sku ?? b.summary?.serial ?? "–" },
    {
      id: "health",
      header: t("bmcs.health"),
      width: "100px",
      cell: (b) => <Health health={b.summary?.health ?? null} />,
      sortValue: (b) => b.summary?.health ?? "",
    },
    { id: "power", header: t("bmcs.power"), width: "80px", cell: (b) => b.summary?.powerState ?? "–" },
    { id: "firmware", header: t("bmcs.bmcFirmware"), mono: true, cell: (b) => b.summary?.bmcFirmware ?? "–" },
    { id: "seen", header: t("bmcs.collected"), width: "110px", cell: (b) => ago(b.lastSuccessAt), sortValue: (b) => b.lastSuccessAt ?? "" },
  ];
  return (
    <>
      <PageHeader title={t("bmcs.bmcs")} description={t("bmcs.description")} />
      {file?.error && (
        <Callout tone="danger" title={t("hostsPage.theHostsFileIsNot")}>
          {t("hostsPage.theHostsFromItsLast", { error: file.error, path: file.path })}
        </Callout>
      )}
      {data?.bmcs.length === 0 ? (
        <EmptyState title={t("bmcs.noBmcsYet")}>
          {t("bmcs.listThemInTheHostsFile")}
          <pre className="mt-3 mb-0 text-left font-mono text-xs">{EXAMPLE}</pre>
        </EmptyState>
      ) : (
        <Panel flush>
          <List label={t("bmcs.bmcs")} rows={data?.bmcs} columns={columns} empty={t("bmcs.noBmcsYet")} getRowId={(b) => b.id} />
        </Panel>
      )}
    </>
  );
}

/** The BMC's server: the file's, or the host matched with it, and whether they agree. */
function ServerCell({ bmc }: { bmc: Bmc }) {
  const t = useT();
  const host = bmc.match?.host;
  if (!host && !bmc.server) return <>–</>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {host ? <a href={`/hosts/${host.id}`}>{host.name}</a> : bmc.server!.name}
      {bmc.match?.state === "mismatch" && <Badge tone="danger">{t("bmcs.mismatch")}</Badge>}
      {bmc.match?.state === "found" && <Badge tone="info">{t("bmcs.found")}</Badge>}
    </span>
  );
}

/** What the host and the BMC say about being one machine, when there is something to say. */
function MatchCallout({ bmc }: { bmc: Bmc }) {
  const t = useT();
  const m = bmc.match;
  if (!m?.host) return null;
  if (m.state === "mismatch")
    return (
      <Callout tone="danger" title={t("bmcs.theFileNamesAnotherMachine", { name: m.host.name })}>
        {m.detail} {t("bmcs.fixServerInTheFile")}
      </Callout>
    );
  if (m.state === "found")
    return (
      <Callout tone="info" title={t("bmcs.matchedWith", { name: m.host.name, by: m.by === "uuid" ? "UUID" : t("bmcs.serial") })}>
        {t("bmcs.addServerToTheFile")} <code className="font-mono text-xs">server: {m.host.name}</code>
      </Callout>
    );
  if (m.state === "unverified" && bmc.status === "ok")
    return (
      <Callout tone="info" title={t("bmcs.notVerifiedYet")}>
        {t("bmcs.notVerifiedYetText", { name: m.host.name })}
      </Callout>
    );
  return null;
}

const PART = {
  "power-supply": "bmcs.powerSupply",
  fan: "bmcs.fan",
  temperature: "bmcs.temperature",
  controller: "bmcs.controllerPart",
  drive: "bmcs.drive",
} as const;

/** A host's hardware as its BMC sees it, with its reboots next to what the BMC logged around each. */
export function HostHardwareTab({ call, hostId }: { call: Call; hostId: string }) {
  const t = useT();
  const { data, error } = useData<HostHardware>(call, `/api/v1/hosts/${hostId}/hardware`, 30_000);
  if (error && !data) return <EmptyState title={t("bmcs.noBmcMatched")}>{error}</EmptyState>;
  if (!data) return null;
  const b = data.bmc;
  return (
    <div className="flex flex-col gap-4">
      {data.match.state === "mismatch" && (
        <Callout tone="danger" title={t("bmcs.theFileNamesAnotherMachine", { name: data.match.host?.name ?? "" })}>
          {data.match.detail} {t("bmcs.fixServerInTheFile")}
        </Callout>
      )}
      <KpiGrid>
        <KpiCard
          label={t("bmcs.health")}
          value={b.summary?.health ?? "–"}
          tone={b.summary?.health === "Critical" ? "danger" : b.summary?.health === "Warning" ? "warning" : undefined}
          href={`/bmcs/${b.id}`}
          footer={b.name}
        />
        <KpiCard label={t("bmcs.power")} value={b.summary?.powerState ?? "–"} />
        <KpiCard label={t("bmcs.partsNotOk")} value={data.parts.length} tone={data.parts.length ? "warning" : undefined} />
        <KpiCard
          label={t("bmcs.sameMachine")}
          value={t(`bmcs.state.${data.match.state}`)}
          tone={data.match.state === "mismatch" ? "danger" : undefined}
          footer={data.match.by ? t("bmcs.byWhat", { by: data.match.by === "uuid" ? "UUID" : t("bmcs.serial") }) : undefined}
        />
      </KpiGrid>
      <Panel title={t("bmcs.partsNotOk")} flush>
        <List
          label={t("bmcs.partsNotOk")}
          rows={data.parts}
          getRowId={(p) => p.kind + p.name}
          empty={t("bmcs.everyPartIsOk")}
          columns={[
            { id: "kind", header: t("bmcs.part"), width: "160px", cell: (p) => (p.kind in PART ? t(PART[p.kind as keyof typeof PART]) : p.kind) },
            { id: "name", header: t("bmcs.name"), cell: (p) => p.name },
            { id: "health", header: t("bmcs.health"), width: "100px", cell: (p) => <Health health={p.health} /> },
          ]}
        />
      </Panel>
      <Panel title={t("bmcs.reboots")} description={t("bmcs.rebootsText")}>
        {data.reboots.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">{t("bmcs.noRebootsYet")}</p>
        ) : (
          <ul className="infra-list flex flex-col gap-3 text-sm">
            {data.reboots.map((r) => (
              <li key={r.at} className="flex flex-col gap-1">
                <strong>{new Date(r.at).toLocaleString()}</strong>
                {r.events.length === 0 ? (
                  <span className="text-fg-muted">{t("bmcs.theBmcLoggedNothing")}</span>
                ) : (
                  r.events.map((e) => (
                    <span key={`${e.log}${e.id}${e.at}`} className="flex flex-wrap items-center gap-2">
                      <Health health={e.severity} />
                      <span className="text-xs text-fg-muted">{e.at ? new Date(e.at).toLocaleTimeString() : ""}</span>
                      <span className="infra-wrap">{e.message}</span>
                    </span>
                  ))
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function CertificateCheck({ bmc, call, onDone }: { bmc: Bmc; call: Call; onDone: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [error, setError] = useState<string>();
  const changed = bmc.status === "certificate-changed";
  const c = bmc.pendingCertificate;
  const accept = (fingerprint: string) =>
    call(`/api/v1/bmcs/${bmc.id}/certificate/accept`, { method: "POST", body: JSON.stringify({ fingerprint }) }).then(onDone, (e: Error) =>
      setError(e.message),
    );
  if (!c) {
    return (
      <Callout
        tone="info"
        title={t("bmcs.noCertificateYet")}
        action={
          can("admin") && (
            <Button size="sm" onClick={() => void call(`/api/v1/bmcs/${bmc.id}/certificate`, { method: "POST" }).then(onDone)}>
              {t("hostKeyCheck.askAgain")}
            </Button>
          )
        }
      >
        {bmc.statusDetail ?? t("bmcs.waitingForTheAgent", { name: bmc.agent.name })}
      </Callout>
    );
  }
  return (
    <Callout tone={changed ? "danger" : "warning"} title={changed ? t("bmcs.theCertificateChanged") : t("bmcs.checkTheCertificate")}>
      <span className="flex flex-col gap-2">
        {bmc.fileCertificate && (
          <span>
            {t("bmcs.theHostsFileTrusts")} <code className="infra-wrap font-mono text-xs">{bmc.fileCertificate}</code> {t("bmcs.andTheBmcPresentsAnother")}
          </span>
        )}
        <span>{changed ? t("bmcs.theBmcPresentsADifferent") : t("bmcs.compareItOnTheBmc")}</span>
        <code className="infra-wrap font-mono text-xs">{`openssl s_client -connect ${bmc.address}:${bmc.port} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`}</code>
        <span className="flex flex-wrap items-center gap-2">
          <code className="infra-wrap font-mono text-sm">{c.fingerprint}</code>
          <span className="text-xs text-fg-muted">
            {c.subject} · {t("bmcs.validTo", { date: new Date(c.validTo).toLocaleDateString() })}
          </span>
          {can("admin") && !bmc.fileCertificate && (
            <Button size="sm" icon={<ShieldCheck />} onClick={() => void accept(c.fingerprint)}>
              {t("hostKeyCheck.itMatchesAccept")}
            </Button>
          )}
        </span>
        {error && <span className="text-danger">{error}</span>}
      </span>
    </Callout>
  );
}

function Overview({ f, bmc }: { f: F; bmc: Bmc }) {
  const t = useT();
  const s = f.systems[0];
  const m = f.managers[0];
  const services = (m?.protocols ?? []).filter((p) => p.enabled);
  return (
    <div className="flex flex-col gap-4">
      <KpiGrid>
        <KpiCard
          label={t("bmcs.health")}
          value={bmc.summary?.health ?? "–"}
          tone={bmc.summary?.health === "Critical" ? "danger" : bmc.summary?.health === "Warning" ? "warning" : undefined}
        />
        <KpiCard label={t("bmcs.power")} value={s?.powerState ?? "–"} footer={f.chassis[0]?.powerWatts != null ? `${f.chassis[0].powerWatts} W` : undefined} />
        <KpiCard label={t("bmcs.partsNotOk")} value={bmc.summary?.unhealthy ?? 0} tone={bmc.summary?.unhealthy ? "warning" : undefined} />
        <KpiCard label={t("bmcs.servicesOn")} value={services.length} footer={services.map((p) => p.name).join(", ") || undefined} />
      </KpiGrid>
      <Panel title={t("bmcs.machine")}>
        <Pairs
          items={[
            [t("bmcs.model"), [s?.manufacturer, s?.model].filter(Boolean).join(" ") || "–"],
            [t("bmcs.serial"), s?.serial ?? "–"],
            [t("bmcs.serviceTag"), s?.sku ?? "–"],
            ["BIOS", s?.biosVersion ?? "–"],
            ["CPU", s ? `${s.processors.count ?? "?"} × ${s.processors.model ?? "?"}` : "–"],
            [t("bmcs.memory"), s?.memoryGiB != null ? `${s.memoryGiB} GiB` : "–"],
            [t("bmcs.hostName"), s?.hostName ?? "–"],
            [
              "UUID",
              <span key="uuid" className="font-mono text-xs">
                {s?.uuid ?? "–"}
              </span>,
            ],
          ]}
        />
      </Panel>
      <Panel title={t("bmcs.controller")}>
        <Pairs
          items={[
            [t("bmcs.product"), [f.service.vendor, f.service.product].filter(Boolean).join(" · ") || "–"],
            [t("bmcs.bmcFirmware"), m ? `${m.firmware ?? "?"}${m.model ? ` (${m.model})` : ""}` : "–"],
            ["Redfish", f.service.redfishVersion],
            [t("overview.address"), t("bmcs.readBy", { user: bmc.user, address: bmc.address, port: bmc.port, name: bmc.agent.name })],
            [t("bmcs.server"), <ServerCell key="s" bmc={bmc} />],
            [
              t("overview.tags"),
              Object.entries(bmc.tags)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "–",
            ],
          ]}
        />
      </Panel>
    </div>
  );
}

function Hardware({ f }: { f: F }) {
  const t = useT();
  const psus = f.chassis.flatMap((c) => c.powerSupplies.map((p) => ({ ...p, chassis: c.id })));
  const fans = f.chassis.flatMap((c) => c.fans.map((x) => ({ ...x, chassis: c.id })));
  const temps = f.chassis.flatMap((c) => c.temperatures.map((x) => ({ ...x, chassis: c.id })));
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("bmcs.powerSupplies")} flush>
        <List
          label={t("bmcs.powerSupplies")}
          rows={psus}
          getRowId={(p) => p.chassis + p.name}
          empty={t("bmcs.noneReported")}
          columns={[
            { id: "name", header: t("bmcs.name"), cell: (p) => p.name },
            { id: "model", header: t("bmcs.model"), cell: (p) => p.model ?? "–" },
            { id: "w", header: "W", width: "80px", align: "right", mono: true, cell: (p) => p.capacityWatts ?? "–" },
            { id: "fw", header: t("bmcs.firmware"), mono: true, cell: (p) => p.firmware ?? "–" },
            { id: "health", header: t("bmcs.health"), width: "100px", cell: (p) => <Health health={p.health} />, sortValue: (p) => p.health ?? "" },
          ]}
        />
      </Panel>
      <Panel title={t("bmcs.temperatures")} flush>
        <List
          label={t("bmcs.temperatures")}
          rows={temps}
          getRowId={(x) => x.chassis + x.name}
          empty={t("bmcs.noneReported")}
          columns={[
            { id: "name", header: t("bmcs.name"), cell: (x) => x.name },
            { id: "c", header: "°C", width: "80px", align: "right", mono: true, cell: (x) => x.celsius ?? "–", sortValue: (x) => x.celsius ?? -1 },
            { id: "crit", header: t("bmcs.critical"), width: "90px", align: "right", mono: true, cell: (x) => x.criticalCelsius ?? "–" },
            { id: "health", header: t("bmcs.health"), width: "100px", cell: (x) => <Health health={x.health} />, sortValue: (x) => x.health ?? "" },
          ]}
        />
      </Panel>
      <Panel title={t("bmcs.fans")} flush>
        <List
          label={t("bmcs.fans")}
          rows={fans}
          getRowId={(x) => x.chassis + x.name}
          empty={t("bmcs.noneReported")}
          columns={[
            { id: "name", header: t("bmcs.name"), cell: (x) => x.name },
            {
              id: "r",
              header: t("bmcs.reading"),
              width: "120px",
              align: "right",
              mono: true,
              cell: (x) => (x.reading != null ? `${x.reading} ${x.units ?? ""}` : "–"),
            },
            { id: "health", header: t("bmcs.health"), width: "100px", cell: (x) => <Health health={x.health} />, sortValue: (x) => x.health ?? "" },
          ]}
        />
      </Panel>
    </div>
  );
}

function Storage({ f }: { f: F }) {
  const t = useT();
  const drives = f.storage.flatMap((s) => s.drives.map((d) => ({ ...d, storage: s.id })));
  const controllers = f.storage.flatMap((s) => s.controllers.map((c) => ({ ...c, storage: s.id })));
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("bmcs.drives")} flush>
        <List
          label={t("bmcs.drives")}
          rows={drives}
          getRowId={(d) => d.storage + d.id}
          empty={t("bmcs.noneReported")}
          columns={[
            { id: "name", header: t("bmcs.name"), cell: (d) => d.name ?? d.id },
            { id: "model", header: t("bmcs.model"), cell: (d) => d.model ?? "–" },
            { id: "serial", header: t("bmcs.serial"), mono: true, cell: (d) => d.serial ?? "–" },
            {
              id: "size",
              header: t("storage.size"),
              width: "90px",
              align: "right",
              cell: (d) => bytes(d.capacityBytes),
              sortValue: (d) => d.capacityBytes ?? 0,
            },
            { id: "media", header: t("storage.type"), width: "90px", cell: (d) => [d.media, d.protocol].filter(Boolean).join(" ") || "–" },
            {
              id: "life",
              header: t("bmcs.lifeLeft"),
              width: "90px",
              align: "right",
              mono: true,
              cell: (d) => (d.lifeLeftPercent != null ? `${d.lifeLeftPercent}%` : "–"),
            },
            { id: "health", header: t("bmcs.health"), width: "100px", cell: (d) => <Health health={d.health} />, sortValue: (d) => d.health ?? "" },
          ]}
        />
      </Panel>
      <Panel title={t("bmcs.controllers")} flush>
        <List
          label={t("bmcs.controllers")}
          rows={controllers}
          getRowId={(c) => c.storage + c.name}
          empty={t("bmcs.noneReported")}
          columns={[
            { id: "name", header: t("bmcs.name"), cell: (c) => c.name },
            { id: "fw", header: t("bmcs.firmware"), mono: true, cell: (c) => c.firmware ?? "–" },
            { id: "health", header: t("bmcs.health"), width: "100px", cell: (c) => <Health health={c.health} /> },
          ]}
        />
      </Panel>
    </div>
  );
}

function Firmware({ f }: { f: F }) {
  const t = useT();
  return (
    <List
      label={t("bmcs.firmware")}
      rows={f.firmware}
      getRowId={(x) => x.id}
      empty={t("bmcs.noneReported")}
      columns={[
        { id: "name", header: t("bmcs.name"), cell: (x) => x.name ?? x.id, sortValue: (x) => x.name ?? x.id },
        { id: "version", header: t("packages.version"), mono: true, cell: (x) => x.version ?? "–" },
        { id: "up", header: t("bmcs.updateable"), width: "110px", cell: (x) => (x.updateable === null ? "–" : x.updateable ? t("bmcs.yes") : t("bmcs.no")) },
      ]}
    />
  );
}

function Access({ f }: { f: F }) {
  const t = useT();
  const protocols = f.managers.flatMap((m) => m.protocols ?? []);
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("bmcs.accounts")} description={t("bmcs.whoMaySignInToTheBmc")} flush>
        {f.accounts === null ? (
          <EmptyState title={t("notReadable.title")}>{t("bmcs.accountsNotReadable")}</EmptyState>
        ) : (
          <List
            label={t("bmcs.accounts")}
            rows={f.accounts}
            getRowId={(a) => a.user}
            empty={t("bmcs.noneReported")}
            columns={[
              { id: "user", header: t("access.account"), cell: (a) => a.user, sortValue: (a) => a.user },
              {
                id: "role",
                header: t("bmcs.role"),
                width: "150px",
                cell: (a) => <Badge tone={a.role === "Administrator" ? "warning" : "neutral"}>{a.role ?? "–"}</Badge>,
                sortValue: (a) => a.role ?? "",
              },
              { id: "enabled", header: t("bmcs.enabled"), width: "100px", cell: (a) => (a.enabled === false ? t("bmcs.no") : a.enabled ? t("bmcs.yes") : "–") },
              { id: "locked", header: t("bmcs.locked"), width: "100px", cell: (a) => (a.locked ? <Badge tone="danger">{t("bmcs.locked")}</Badge> : "–") },
            ]}
          />
        )}
      </Panel>
      <Panel title={t("bmcs.networkServices")} description={t("bmcs.whatTheBmcOffers")} flush>
        <List
          label={t("bmcs.networkServices")}
          rows={protocols}
          getRowId={(p) => p.name}
          empty={t("bmcs.noneReported")}
          columns={[
            { id: "name", header: t("bmcs.name"), cell: (p) => p.name, sortValue: (p) => p.name },
            {
              id: "on",
              header: t("bmcs.enabled"),
              width: "120px",
              cell: (p) => <Badge tone={p.enabled ? "info" : "neutral"}>{p.enabled ? t("bmcs.on") : t("bmcs.off")}</Badge>,
            },
            { id: "port", header: t("ports.port"), width: "90px", align: "right", mono: true, cell: (p) => p.port ?? "–" },
          ]}
        />
      </Panel>
    </div>
  );
}

function Events({ f }: { f: F }) {
  const t = useT();
  return (
    <List
      label={t("bmcs.events")}
      rows={f.events}
      getRowId={(e) => `${e.log}${e.id}${e.at}`}
      empty={t("bmcs.noEvents")}
      columns={[
        { id: "at", header: t("changeList.when"), width: "170px", cell: (e) => (e.at ? new Date(e.at).toLocaleString() : "–"), sortValue: (e) => e.at ?? "" },
        { id: "sev", header: t("bmcs.severity"), width: "100px", cell: (e) => <Health health={e.severity} /> },
        { id: "log", header: t("bmcs.log"), width: "80px", cell: (e) => e.log },
        { id: "msg", header: t("bmcs.message"), cell: (e) => <span className="infra-wrap text-sm">{e.message ?? "–"}</span> },
      ]}
    />
  );
}

export function BmcPage({ call, id }: { call: Call; id: string }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const bmc = useData<Bmc>(call, `/api/v1/bmcs/${id}`, 10_000);
  const facts = useData<{ facts: F }>(call, bmc.data?.lastSuccessAt ? `/api/v1/bmcs/${id}/facts` : null, 30_000);
  const changes = useData<{ changes: Change[] }>(call, tab === "changes" ? `/api/v1/bmcs/${id}/changes?limit=500` : null, 30_000);
  const b = bmc.data;
  if (bmc.error && !b) return <EmptyState title={t("hostPage.notFound")}>{t("bmcs.thisBmcNoLongerExists")}</EmptyState>;
  if (!b) return null;
  const f = facts.data?.facts;
  const collect = () => void call(`/api/v1/bmcs/${id}/collect`, { method: "POST" }).then(() => setTimeout(bmc.reload, 3000));
  const waiting = b.status === "new" || b.status === "certificate-pending" || b.status === "certificate-changed";
  const on = (name: string) => f?.managers.some((m) => m.protocols?.some((p) => p.name === name && p.enabled));
  return (
    <>
      <PageHeader
        title={b.name}
        breadcrumbs={[{ label: t("bmcs.bmcs"), href: "/bmcs" }, { label: b.name }]}
        description={
          b.summary
            ? t("bmcs.collectedFrom", { model: [b.summary.vendor, b.summary.model].filter(Boolean).join(" "), ago: ago(b.lastSuccessAt) })
            : `${b.address}:${b.port}`
        }
        meta={
          <span className="flex items-center gap-1.5">
            <Status status={b.status} />
            <Badge tone="neutral">{t("hostPage.fromFile")}</Badge>
          </span>
        }
        actions={
          can("editor") &&
          !waiting && (
            <Button icon={<Play />} onClick={collect}>
              {t("hostPage.collectNow")}
            </Button>
          )
        }
      />
      {waiting && <CertificateCheck bmc={b} call={call} onDone={bmc.reload} />}
      <MatchCallout bmc={b} />
      {!waiting && b.status !== "ok" && b.statusDetail && (
        <Callout tone="danger" title={t("hostPage.theLastCollectionFailed")}>
          {b.statusDetail} {b.lastSuccessAt && t("hostPage.whatIsShownIsFrom", { ago: ago(b.lastSuccessAt) })}
        </Callout>
      )}
      {on("IPMI") && (
        <Callout tone="warning" title={t("bmcs.ipmiIsOn")}>
          {t("bmcs.ipmiIsOnText")}
        </Callout>
      )}
      {on("Telnet") && (
        <Callout tone="danger" title={t("bmcs.telnetIsOn")}>
          {t("bmcs.telnetIsOnText")}
        </Callout>
      )}
      {f && f.unreadable.length > 0 && (
        <Callout tone="info" title={t("bmcs.someDetailsAreNotReadable")}>
          {t("bmcs.notReadableAs", { user: b.user })} {f.unreadable.join(", ")}.
        </Callout>
      )}
      {f && (
        <>
          <Tabs<Tab>
            label={t("bmcs.bmcDetails")}
            value={tab}
            onChange={setTab}
            items={[
              { value: "overview", label: t("hostPage.overview") },
              { value: "hardware", label: t("bmcs.hardware") },
              { value: "storage", label: t("hostPage.storage"), count: f.storage.reduce((n, s) => n + s.drives.length, 0) },
              { value: "firmware", label: t("bmcs.firmware"), count: f.firmware.length },
              { value: "access", label: t("hostPage.access"), count: f.accounts?.length },
              { value: "events", label: t("bmcs.events"), count: f.events.length },
              { value: "changes", label: t("hostPage.changes") },
            ]}
          />
          {tab === "overview" && <Overview f={f} bmc={b} />}
          {tab === "hardware" && <Hardware f={f} />}
          {tab === "storage" && <Storage f={f} />}
          {tab === "firmware" && <Firmware f={f} />}
          {tab === "access" && <Access f={f} />}
          {tab === "events" && <Events f={f} />}
          {tab === "changes" && <ChangeList changes={changes.data?.changes} />}
        </>
      )}
    </>
  );
}

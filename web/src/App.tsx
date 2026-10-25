import {
  AppShell,
  BarList,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SegmentedControl,
  SelectField,
  StackedBarChart,
  Tabs,
  TONE_COLORS,
  usePath,
  type Column,
  type ProductId,
  useThemePreference,
  toLocale,
  useLocalePreference,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { Bot, Boxes, GitCompare, KeyRound, LayoutDashboard, LogIn, LogOut, Server, UserRound, Users, Network } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Agent, AgentSetup, Change, Container, Host, ProductLink, Setup, Summary } from "./api.ts";
import { AgentsPage } from "./agents.tsx";
import { ClusterPage, ClustersPage } from "./clusters.tsx";
import { ContainerTable, HostPage } from "./host.tsx";
import { HostsPage } from "./hosts.tsx";
import { ChangeList, Code, List, Status, useApi, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";
import { search } from "./search.ts";

export const PAGES = ["overview", "hosts", "containers", "clusters", "changes", "setup", "agents", "account", "members", "signin", "tokens", "about"] as const;
type Page = (typeof PAGES)[number];
type Route = { page: Page } | { page: "host"; id: string } | { page: "cluster"; id: string };

function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "hosts" && id) return { page: "host", id: decodeURIComponent(id) };
  if (page === "clusters" && id) return { page: "cluster", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  return { page: "overview" };
}

function OverviewPage({ call }: { call: Call }) {
  const t = useT();
  const summary = useData<Summary>(call, "/api/v1/summary");
  const hosts = useData<{ hosts: Host[] }>(call, "/api/v1/hosts");
  const changes = useData<{ changes: Change[] }>(call, "/api/v1/changes?limit=20");
  const s = summary.data;
  const total = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
  const attention = (hosts.data?.hosts ?? []).filter((h) => h.status !== "ok" || (h.summary?.fullestDisk?.pct ?? 0) >= 85);
  // The hosts using the most of their disk and memory, as last read; 85% and more is what needs attention.
  const read = (hosts.data?.hosts ?? []).filter((h) => h.summary);
  const top = (pct: (h: Host) => number | null) =>
    read
      .map((h) => ({ h, pct: pct(h) }))
      .filter((x): x is { h: Host; pct: number } => x.pct !== null)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 8)
      .map(({ h, pct }) => ({ id: h.id, label: h.name, value: pct, href: `/hosts/${h.id}`, color: pct >= 85 ? TONE_COLORS.warning : undefined }));
  const disks = top((h) => h.summary!.fullestDisk?.pct ?? null);
  const memory = top((h) =>
    h.summary!.memoryTotalKb ? Math.round(((h.summary!.memoryTotalKb - h.summary!.memoryAvailableKb) / h.summary!.memoryTotalKb) * 100) : null,
  );
  if (s && total(s.hosts) + total(s.clusters) === 0) {
    return (
      <>
        <PageHeader title={t("overviewPage.getStarted")} description={t("overviewPage.anAgentReadsHostsOver")} />
        <EmptyState
          title={t("overviewPage.nothingToReadYet")}
          action={
            <Button variant="primary" onClick={() => navigate(total(s.agents) ? "/setup" : "/agents")}>
              {total(s.agents) ? t("overviewPage.prepareAHost") : t("overviewPage.addAnAgent")}
            </Button>
          }
        >
          {t("overviewPage.addAnAgentAndStart")}
        </EmptyState>
      </>
    );
  }
  const cols: Column<Host>[] = [
    { id: "name", header: t("overviewPage.host"), cell: (h) => <a href={`/hosts/${h.id}`}>{h.name}</a> },
    { id: "status", header: t("overviewPage.status"), width: "180px", cell: (h) => <Status status={h.status} /> },
    {
      id: "why",
      header: t("overviewPage.why"),
      cell: (h) => (h.status !== "ok" ? (h.statusDetail ?? "") : `${h.summary!.fullestDisk!.mount} is ${h.summary!.fullestDisk!.pct}% full`),
    },
  ];
  return (
    <>
      <PageHeader title={t("overviewPage.overview")} description={t("overviewPage.everyHostContainerAndCluster")} />
      <KpiGrid>
        <KpiCard
          label={t("overviewPage.hostsCollected")}
          value={`${s?.hosts.ok ?? 0}/${total(s?.hosts)}`}
          tone={s && (s.hosts.ok ?? 0) < total(s.hosts) ? "warning" : undefined}
          href="/hosts"
        />
        <KpiCard label={t("overviewPage.containers")} value={s?.containers ?? "–"} href="/containers" />
        <KpiCard label={t("overviewPage.clustersCollected")} value={`${s?.clusters.ok ?? 0}/${total(s?.clusters)}`} href="/clusters" />
        <KpiCard label={t("overviewPage.changesIn24H")} value={s?.changesLastDay ?? "–"} href="/changes" />
      </KpiGrid>
      {(disks.length > 0 || memory.length > 0) && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title={t("overviewPage.fullestDisks")} description={t("overviewPage.theFullestDiskOfEach")}>
            <BarList label={t("overviewPage.fullestDisks")} items={disks} max={100} format={(v) => `${v}%`} />
          </Panel>
          <Panel title={t("overviewPage.memoryInUse")} description={t("overviewPage.ofEachHostAsLast")}>
            <BarList label={t("overviewPage.memoryInUse")} items={memory} max={100} format={(v) => `${v}%`} />
          </Panel>
        </div>
      )}
      {s && (
        <Panel title={t("overviewPage.changesOverTime")} description={t("overviewPage.eachDayOfTheLast")}>
          <StackedBarChart
            label={t("overviewPage.changesEachDayByKind")}
            categories={s.changeDays.map((d) =>
              new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }),
            )}
            segments={[
              { id: "added", name: t("overviewPage.added"), color: TONE_COLORS.success },
              { id: "changed", name: t("overviewPage.changed"), color: TONE_COLORS.info },
              { id: "removed", name: t("overviewPage.removed"), color: TONE_COLORS.danger },
            ]}
            values={s.changeDays.map((d) => [d.added, d.changed, d.removed])}
            height={140}
            xTicks={7}
          />
        </Panel>
      )}
      {attention.length > 0 && (
        <Panel title={t("overviewPage.needsAttention")} flush>
          <List label={t("overviewPage.hostsThatNeedAttention")} rows={attention} columns={cols} empty="" getRowId={(h) => h.id} />
        </Panel>
      )}
      <Panel title={t("overviewPage.latestChanges")} flush>
        <ChangeList changes={changes.data?.changes} showTarget />
      </Panel>
    </>
  );
}

function ContainersPage({ call }: { call: Call }) {
  const t = useT();
  const { data } = useData<{ containers: Array<Container & { host: { id: string; name: string } }> }>(call, "/api/v1/containers");
  return (
    <>
      <PageHeader title={t("containersPage.containers")} description={t("containersPage.onHostsWhereReadingContainers")} />
      <Panel flush>
        <ContainerTable rows={data?.containers} showHost />
      </Panel>
    </>
  );
}

const CATEGORIES = ["all", "package", "port", "user", "sudo", "ssh-key", "service", "container", "system"] as const;
function ChangesPage({ call }: { call: Call }) {
  const t = useT();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("all");
  const { data } = useData<{ changes: Change[] }>(call, `/api/v1/changes?limit=500${category === "all" ? "" : `&category=${category}`}`, 30_000);
  return (
    <>
      <PageHeader title={t("changesPage.changes")} description={t("changesPage.everythingThatWasAddedRemoved")} />
      <SegmentedControl
        label={t("changesPage.whatChanged")}
        size="sm"
        value={category}
        onChange={setCategory}
        options={CATEGORIES.map((c) => ({ value: c, label: c === "all" ? t("changesPage.all") : c }))}
      />
      <Panel flush>
        <ChangeList changes={data?.changes} showTarget />
      </Panel>
    </>
  );
}

function SetupPage({ call }: { call: Call }) {
  const t = useT();
  const agents = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 0);
  const k8s = useData<Setup>(call, "/api/v1/setup", 0);
  const [agentId, setAgentId] = useState("");
  const enrolled = (agents.data?.agents ?? []).filter((a) => a.caFingerprint);
  const chosen = agentId || enrolled[0]?.id || "";
  const setup = useData<AgentSetup>(call, chosen ? `/api/v1/agents/${chosen}/setup` : null, 0);
  const [tab, setTab] = useState<"host" | "key" | "kubernetes">("host");
  const s = setup.data;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.whatToPutOnHosts")} />
      <Tabs
        label={t("setupPage.whatToPrepare")}
        value={tab}
        onChange={setTab}
        items={[
          { value: "host", label: t("setupPage.aHostCertificate") },
          { value: "key", label: t("setupPage.aHostFixedKey") },
          { value: "kubernetes", label: t("setupPage.aKubernetesCluster") },
        ]}
      />
      {tab !== "kubernetes" &&
        (enrolled.length === 0 ? (
          <EmptyState title={t("setupPage.noAgentYet")}>
            {t("setupPage.hostsTrustTheCertificateAuthority")} <a href="/agents">{t("setupPage.agents")}</a> {t("setupPage.andStartItItsSetup")}
          </EmptyState>
        ) : (
          <>
            {enrolled.length > 1 && (
              <div style={{ maxWidth: 320 }}>
                <SelectField
                  label={t("setupPage.forHostsReadBy")}
                  value={chosen}
                  onChange={(e) => setAgentId(e.target.value)}
                  options={enrolled.map((a) => ({ value: a.id, label: a.name }))}
                />
              </div>
            )}
            {s && tab === "host" && (
              <>
                <Panel title={t("setupPage.n1TrustTheAgentFor")} description={t("setupPage.runAsRootOnThe", { name: s.agent.name })}>
                  <Code label={t("setupPage.commandsToPrepareAHost")}>{s.hostSetup}</Code>
                </Panel>
                <Panel title={t("setupPage.n2AddItUnderHosts")} description={t("setupPage.theAgentAsksTheHost")} />
                <Panel
                  title={t("setupPage.theCaOf", { name: s.agent.name })}
                  description={t("setupPage.itStaysOnTheAgent", { caFingerprint: s.caFingerprint })}
                >
                  <Code label={t("setupPage.caPublicKey")}>{s.caPublicKey}</Code>
                </Panel>
                <Panel title={t("setupPage.jumpHosts")} description={t("setupPage.toReachHostsInAnother")} />
              </>
            )}
            {s && tab === "key" && (
              <Panel title={t("setupPage.oneFixedKey")} description={t("setupPage.forHostsWhereSshdConfig")}>
                <Code label="authorized_keys line">{`# ~openasy/.ssh/authorized_keys\n${s.authorizedKey}`}</Code>
              </Panel>
            )}
          </>
        ))}
      {tab === "kubernetes" && k8s.data && (
        <Panel title={t("setupPage.aReadOnlyServiceAccount")} description={t("setupPage.kubectlApplyFThisFile")}>
          <Code label={t("setupPage.kubernetesRole")}>{k8s.data.kubernetesRbac}</Code>
        </Panel>
      )}
      {tab === "host" && s && (
        <Callout tone="info" title={t("setupPage.optionalDetailsThatNeedRoot")}>
          {t("setupPage.theCommandsAboveIncludeA")}
        </Callout>
      )}
    </>
  );
}

const SETTINGS = (t: T) =>
  ({
    account: [t("settings.account"), t("settings.accountText")],
    members: [t("settings.members"), t("settings.membersText")],
    signin: [t("settings.signin"), t("settings.signinText")],
    tokens: [t("settings.tokens"), t("settings.tokensText")],
  }) as const;

function Product() {
  const t = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can, signOut } = useAuth();
  const account = useAccountMenu();
  const call = useApi();
  const onSearch = useMemo(() => search(call, t), [call, t]);
  const route = parseRoute(usePath());
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const summary = useData<Summary>(call, "/api/v1/summary", 30_000);
  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(
          r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "infrastructure" && (PRODUCT_IDS as readonly string[]).includes(p.id)),
        ),
      () => {},
    );
  }, [call]);
  const total = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
  const nav = [
    { id: "overview", label: t("product.overview"), icon: LayoutDashboard },
    { id: "hosts", label: t("product.hosts"), icon: Server, count: total(summary.data?.hosts) || undefined },
    { id: "containers", label: t("product.containers"), icon: Boxes, count: summary.data?.containers || undefined },
    { id: "clusters", label: t("product.kubernetes"), icon: Network, count: total(summary.data?.clusters) || undefined },
    { id: "changes", label: t("product.changes"), icon: GitCompare },
  ];
  const footerNav = [
    { id: "agents", label: t("product.agents"), icon: Bot },
    ...(can("admin")
      ? [
          { id: "members", label: t("product.members"), icon: Users },
          { id: "signin", label: t("product.signIn"), icon: LogIn },
          { id: "tokens", label: t("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: t("product.account"), icon: UserRound },
  ];
  const active = route.page === "host" ? "hosts" : route.page === "cluster" ? "clusters" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const page = route.page;
  return (
    <AppShell
      product="infrastructure"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {route.page === "host" ? (
        <HostPage key={route.id} call={call} id={route.id} vulnsUrl={products.find((p) => p.id === "vulnerabilities")?.url} />
      ) : route.page === "cluster" ? (
        <ClusterPage key={route.id} call={call} id={route.id} />
      ) : page === "hosts" ? (
        <HostsPage call={call} />
      ) : page === "containers" ? (
        <ContainersPage call={call} />
      ) : page === "clusters" ? (
        <ClustersPage call={call} />
      ) : page === "changes" ? (
        <ChangesPage call={call} />
      ) : page === "setup" ? (
        <SetupPage call={call} />
      ) : page === "agents" ? (
        <AgentsPage call={call} />
      ) : page === "account" || page === "members" || page === "signin" || page === "tokens" ? (
        page !== "account" && !can("admin") ? (
          <EmptyState title={t("product.adminsOnly")}>{t("product.askAnAdminOfThis")}</EmptyState>
        ) : (
          <>
            <PageHeader
              title={SETTINGS(t)[page][0]}
              description={SETTINGS(t)[page][1]}
              actions={
                page === "account" && (
                  <Button icon={<LogOut />} onClick={() => void signOut()}>
                    {t("product.signOut")}
                  </Button>
                )
              }
            />
            {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
          </>
        )
      ) : (
        <OverviewPage call={call} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Infrastructure">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}

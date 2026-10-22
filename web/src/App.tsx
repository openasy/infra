import { AppShell, BrandProvider, Button, Callout, EmptyState, KpiCard, KpiGrid, navigate, PageHeader, Panel, PRODUCT_IDS, SegmentedControl, SelectField, Tabs, usePath, type Column, type ProductId, useThemePreference } from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { Bot, Boxes, GitCompare, KeyRound, LayoutDashboard, LogIn, LogOut, Server, Settings2, UserRound, Users, Network } from "lucide-react";
import { useEffect, useState } from "react";
import type { Agent, AgentSetup, Change, Container, Host, ProductLink, Setup, Summary } from "./api.ts";
import { AgentsPage } from "./agents.tsx";
import { ClusterPage, ClustersPage } from "./clusters.tsx";
import { ContainerTable, HostPage } from "./host.tsx";
import { HostsPage } from "./hosts.tsx";
import { ChangeList, Code, List, Status, useApi, useData, type Call } from "./shared.tsx";

export const PAGES = ["overview", "hosts", "containers", "clusters", "changes", "setup", "agents", "account", "members", "signin", "tokens"] as const;
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
  const summary = useData<Summary>(call, "/api/v1/summary");
  const hosts = useData<{ hosts: Host[] }>(call, "/api/v1/hosts");
  const changes = useData<{ changes: Change[] }>(call, "/api/v1/changes?limit=20");
  const s = summary.data;
  const total = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
  const attention = (hosts.data?.hosts ?? []).filter((h) => h.status !== "ok" || (h.summary?.fullestDisk?.pct ?? 0) >= 85);
  if (s && total(s.hosts) + total(s.clusters) === 0) {
    return (
      <>
        <PageHeader title="Get started" description="An agent reads hosts over SSH, and Infrastructure reads clusters through their API. Nothing is installed on them." />
        <EmptyState title="Nothing to read yet" action={<Button variant="primary" onClick={() => navigate(total(s.agents) ? "/setup" : "/agents")}>{total(s.agents) ? "Prepare a host" : "Add an agent"}</Button>}>
          Add an agent and start it, prepare a host with the commands under Setup, add the host, check its key, and the first collection follows within a minute.
        </EmptyState>
      </>
    );
  }
  const cols: Column<Host>[] = [
    { id: "name", header: "Host", cell: (h) => <a href={`/hosts/${h.id}`}>{h.name}</a> },
    { id: "status", header: "Status", width: "180px", cell: (h) => <Status status={h.status} /> },
    { id: "why", header: "Why", cell: (h) => (h.status !== "ok" ? (h.statusDetail ?? "") : `${h.summary!.fullestDisk!.mount} is ${h.summary!.fullestDisk!.pct}% full`) },
  ];
  return (
    <>
      <PageHeader title="Overview" description="Every host, container and cluster, and what changed." />
      <KpiGrid>
        <KpiCard label="Hosts collected" value={`${s?.hosts.ok ?? 0}/${total(s?.hosts)}`} tone={s && (s.hosts.ok ?? 0) < total(s.hosts) ? "warning" : undefined} href="/hosts" />
        <KpiCard label="Containers" value={s?.containers ?? "–"} href="/containers" />
        <KpiCard label="Clusters collected" value={`${s?.clusters.ok ?? 0}/${total(s?.clusters)}`} href="/clusters" />
        <KpiCard label="Changes in 24 h" value={s?.changesLastDay ?? "–"} href="/changes" />
      </KpiGrid>
      {attention.length > 0 && (
        <Panel title="Needs attention" flush>
          <List label="Hosts that need attention" rows={attention} columns={cols} empty="" getRowId={(h) => h.id} />
        </Panel>
      )}
      <Panel title="Latest changes" flush>
        <ChangeList changes={changes.data?.changes} showTarget />
      </Panel>
    </>
  );
}

function ContainersPage({ call }: { call: Call }) {
  const { data } = useData<{ containers: Array<Container & { host: { id: string; name: string } }> }>(call, "/api/v1/containers");
  return (
    <>
      <PageHeader title="Containers" description="On hosts where reading containers is switched on. Environment variables are kept by name only." />
      <Panel flush>
        <ContainerTable rows={data?.containers} showHost />
      </Panel>
    </>
  );
}

const CATEGORIES = ["all", "package", "port", "user", "sudo", "ssh-key", "service", "container", "system"] as const;
function ChangesPage({ call }: { call: Call }) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("all");
  const { data } = useData<{ changes: Change[] }>(call, `/api/v1/changes?limit=500${category === "all" ? "" : `&category=${category}`}`, 30_000);
  return (
    <>
      <PageHeader title="Changes" description="Everything that was added, removed or changed between two collections, newest first." />
      <SegmentedControl label="What changed" size="sm" value={category} onChange={setCategory} options={CATEGORIES.map((c) => ({ value: c, label: c === "all" ? "All" : c }))} />
      <Panel flush>
        <ChangeList changes={data?.changes} showTarget />
      </Panel>
    </>
  );
}

function SetupPage({ call }: { call: Call }) {
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
      <PageHeader title="Setup" description="What to put on hosts and clusters so they can be read. Nothing is installed on them." />
      <Tabs
        label="What to prepare"
        value={tab}
        onChange={setTab}
        items={[
          { value: "host", label: "A host (certificate)" },
          { value: "key", label: "A host (fixed key)" },
          { value: "kubernetes", label: "A Kubernetes cluster" },
        ]}
      />
      {tab !== "kubernetes" &&
        (enrolled.length === 0 ? (
          <EmptyState title="No agent yet">
            Hosts trust the certificate authority of the agent that reads them. Add one under <a href="/agents">Agents</a> and start it; its setup shows here.
          </EmptyState>
        ) : (
          <>
            {enrolled.length > 1 && (
              <div style={{ maxWidth: 320 }}>
                <SelectField label="For hosts read by" value={chosen} onChange={(e) => setAgentId(e.target.value)} options={enrolled.map((a) => ({ value: a.id, label: a.name }))} />
              </div>
            )}
            {s && tab === "host" && (
              <>
                <Panel title="1. Trust the agent for one account" description={`Run as root on the host. It creates the openasy account and trusts the CA of ${s.agent.name} for that account only, so the CA can never log in as root or anyone else.`}>
                  <Code label="Commands to prepare a host">{s.hostSetup}</Code>
                </Panel>
                <Panel title="2. Add it under Hosts" description="The agent asks the host for its key; check the fingerprint on the host before accepting it." />
                <Panel title={`The CA of ${s.agent.name}`} description={`It stays on the agent, not in Infrastructure. Certificates last 5 minutes and allow no TTY and no forwarding. Fingerprint ${s.caFingerprint}.`}>
                  <Code label="CA public key">{s.caPublicKey}</Code>
                </Panel>
                <Panel title="Jump hosts" description="To reach hosts in another network through one of them, add it as a host and set AllowTcpForwarding yes for the openasy account on it only. Or run another agent in that network." />
              </>
            )}
            {s && tab === "key" && (
              <Panel title="One fixed key" description="For hosts where sshd_config cannot change. The key cannot open a TTY or forward anything. Prefer certificates: a key lasts until it is removed.">
                <Code label="authorized_keys line">{`# ~openasy/.ssh/authorized_keys\n${s.authorizedKey}`}</Code>
              </Panel>
            )}
          </>
        ))}
      {tab === "kubernetes" && k8s.data && (
        <Panel title="A read-only service account" description="kubectl apply -f this file, then add the cluster with its API server URL, CA and the token from the openasy-infra-token Secret. It cannot read Secrets or ConfigMaps or change anything.">
          <Code label="Kubernetes role">{k8s.data.kubernetesRbac}</Code>
        </Panel>
      )}
      {tab === "host" && s && (
        <Callout tone="info" title="Optional: details that need root">
          The commands above include a sudoers file that allows only fixed, read-only commands: which process listens on a port, SSH keys that may log in, sudo rules, the SSH server settings and the firewall rules.
        </Callout>
      )}
    </>
  );
}

const SETTINGS = {
  account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
  members: ["Members", "Who can sign in, and with which role. Viewers see everything; editors also start collections; admins also add and remove agents, hosts and clusters, accept host keys, and manage members and tokens."],
  signin: ["Sign-in", "Identity providers people can sign in with, such as OpenAsy Identity, Keycloak or Microsoft Entra ID, and which of their groups give which role."],
  tokens: ["API tokens", "For scripts. Each token has one role and an expiry; the secret is shown once."],
} as const;

function Product() {
  const [theme, setTheme] = useThemePreference();
  const { me, can, signOut } = useAuth();
  const call = useApi();
  const route = parseRoute(usePath());
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const summary = useData<Summary>(call, "/api/v1/summary", 30_000);
  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "infrastructure" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);
  const total = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
  const nav = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "hosts", label: "Hosts", icon: Server, count: total(summary.data?.hosts) || undefined },
    { id: "containers", label: "Containers", icon: Boxes, count: summary.data?.containers || undefined },
    { id: "clusters", label: "Kubernetes", icon: Network, count: total(summary.data?.clusters) || undefined },
    { id: "changes", label: "Changes", icon: GitCompare },
  ];
  const footerNav = [
    { id: "setup", label: "Setup", icon: Settings2 },
    { id: "agents", label: "Agents", icon: Bot },
    ...(can("admin")
      ? [
          { id: "members", label: "Members", icon: Users },
          { id: "signin", label: "Sign-in", icon: LogIn },
          { id: "tokens", label: "API tokens", icon: KeyRound },
        ]
      : []),
    { id: "account", label: "Account", icon: UserRound },
  ];
  const active = route.page === "host" ? "hosts" : route.page === "cluster" ? "clusters" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const page = route.page;
  return (
    <AppShell
      product="infrastructure"
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
      theme={theme}
      onThemeChange={setTheme}
    >
      {route.page === "host" ? (
        <HostPage key={route.id} call={call} id={route.id} />
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
          <EmptyState title="Admins only">Ask an admin of this Infrastructure for access.</EmptyState>
        ) : (
          <>
            <PageHeader
              title={SETTINGS[page][0]}
              description={SETTINGS[page][1]}
              actions={
                page === "account" && (
                  <Button icon={<LogOut />} onClick={() => void signOut()}>
                    Sign out
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
  const [theme] = useThemePreference();
  return (
    // No organization until branding is configurable (ADR 0004); the library's default is a placeholder.
    <BrandProvider theme={theme} brand={{ name: "OpenAsy", organization: undefined }} className="min-h-screen">
      <AuthGate product="OpenAsy Infrastructure">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}

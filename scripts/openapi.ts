// Writes openapi.json (ADR 0014, 0024). Run `node scripts/openapi.ts` after changing the API; a test fails when the
// file is out of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties), extra = false) => ({
  type: "object",
  required,
  properties,
  ...(extra ? {} : {}),
});
const map = { type: "object", additionalProperties: str };

const STATUS = {
  type: "string",
  enum: ["new", "host-key-pending", "host-key-changed", "pending", "ok", "unreachable", "auth-failed", "timeout", "error"],
  description: "Of the last collection. new and host-key-pending wait for an admin to accept the host key.",
};

const schemas: Record<string, S> = {
  Problem: {
    type: "object",
    required: ["type", "title", "status", "code"],
    properties: {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        enum: [
          "invalid-json",
          "invalid-body",
          "not-found",
          "conflict",
          "not-configured",
          "internal-error",
          "unauthenticated",
          "invalid-token",
          "mfa-setup-required",
          "forbidden",
          "cross-site",
          "rate-limited",
        ],
        description: "Stable; match on this.",
      },
      detail: str,
    },
  },
  HostKey: obj({ type: str, fingerprint: { type: "string", pattern: "^SHA256:" } }),
  HostSummary: nul(
    obj({
      hostname: str,
      os: str,
      kernel: str,
      arch: str,
      virtualization: nul(str),
      uptimeSec: int,
      load: arr({ type: "number" }),
      cpuThreads: int,
      memoryTotalKb: int,
      memoryAvailableKb: int,
      fullestDisk: nul(obj({ mount: str, pct: int })),
      packages: int,
      listeningPorts: nul(int),
      processes: int,
      containers: nul(int),
      unreadable: { ...arr(str), description: "What needs the sudo rules or the container switch to be read." },
    }),
  ),
  Host: obj({
    id: str,
    name: str,
    address: str,
    port: int,
    user: str,
    auth: { type: "string", enum: ["certificate", "key"] },
    agent: obj({ id: str, name: str }),
    jumpHost: nul(obj({ id: str, name: str })),
    source: {
      type: "string",
      enum: ["ui", "file"],
      description: "file: from the hosts file (OPENASY_HOSTS, ADR 0052); changed there, so PATCH and DELETE answer 409. Fetching its key still works.",
    },
    fileHostKey: {
      ...nul(str),
      description:
        "The fingerprint hostKey gives in the hosts file: a host that presents that key is trusted without an admin, and no other key can be accepted here.",
    },
    containers: { ...bool, description: "Read containers through the host's Docker or Podman. Access to the socket is equivalent to root (ADR 0031)." },
    intervalMinutes: int,
    tags: map,
    hostKeys: { ...arr(ref("HostKey")), description: "Pinned. Collection stops when the host presents another key." },
    pendingHostKeys: { ...arr(ref("HostKey")), description: "What the host presents now, waiting to be checked and accepted." },
    status: STATUS,
    statusDetail: nul(str),
    lastAttemptAt: nul(dt),
    lastSuccessAt: nul(dt),
    createdAt: dt,
    summary: ref("HostSummary"),
  }),
  HostInput: {
    type: "object",
    required: ["name", "address"],
    properties: {
      name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$" },
      agentId: { type: "string", description: "The agent that reads this host. Optional when there is only one." },
      address: { type: "string", description: "Host name or IP address." },
      port: { type: "integer", default: 22 },
      user: { type: "string", default: "openasy" },
      auth: {
        type: "string",
        enum: ["certificate", "key"],
        default: "certificate",
        description: "certificate: a 5-minute certificate from Infrastructure's CA for each collection. key: one fixed key in authorized_keys.",
      },
      jumpHostId: { ...nul(str), description: "Reach the host through this one (ProxyJump)." },
      containers: { type: "boolean", default: false },
      intervalMinutes: { type: "integer", minimum: 1, maximum: 1440, default: 5 },
      tags: map,
    },
  },
  Facts: {
    type: "object",
    description: "Everything read from the host in one collection. Values that look like secrets are masked; container environment variables are names only.",
    required: ["collectedAt", "system", "packages", "users", "unreadable"],
    properties: {
      collectedAt: dt,
      account: obj({ user: str, uid: int, sudo: { type: "string", enum: ["all", "rules"] } }),
      system: { type: "object" },
      cpu: { type: "object" },
      memory: { type: "object" },
      disks: arr({ type: "object" }),
      filesystems: arr({ type: "object" }),
      interfaces: arr({ type: "object" }),
      routes: arr({ type: "object" }),
      dns: { type: "object" },
      ports: nul(arr(obj({ proto: str, address: str, port: int, process: nul(str), pid: nul(int) }))),
      processes: arr({ type: "object" }),
      services: nul(arr({ type: "object" })),
      timers: nul(arr({ type: "object" })),
      cron: arr({ type: "object" }),
      crontabUsers: nul(arr(str)),
      users: arr({ type: "object" }),
      groups: arr({ type: "object" }),
      sudo: nul(arr(str)),
      authorizedKeys: nul(arr({ type: "object" })),
      sshd: nul(map),
      modules: arr(str),
      sysctl: map,
      firewall: nul({ type: "object" }),
      packages: arr(obj({ manager: str, name: str, version: str, arch: nul(str) })),
      containers: nul(arr(ref("Container"))),
      unreadable: arr(str),
    },
  },
  Container: {
    type: "object",
    required: ["engine", "id", "name", "image", "state", "envNames"],
    properties: {
      engine: { type: "string", enum: ["docker", "podman"] },
      id: str,
      name: str,
      image: str,
      imageId: str,
      state: str,
      health: nul(str),
      createdAt: str,
      startedAt: nul(str),
      restarts: int,
      restartPolicy: nul(str),
      command: str,
      ports: arr(str),
      mounts: arr({ type: "object" }),
      networks: arr(str),
      labels: map,
      envNames: { ...arr(str), description: "Names only: values are never collected." },
      memoryLimitBytes: nul(int),
      cpuLimit: nul({ type: "number" }),
      privileged: bool,
      user: str,
      host: obj({ id: str, name: str }),
    },
  },
  Cluster: obj({
    id: str,
    name: str,
    server: str,
    intervalMinutes: int,
    tags: map,
    status: { type: "string" },
    statusDetail: nul(str),
    lastAttemptAt: nul(dt),
    lastSuccessAt: nul(dt),
    createdAt: dt,
    summary: nul(
      obj({ version: str, nodes: int, nodesReady: int, namespaces: int, workloads: int, pods: int, podsNotRunning: int, restarts: int, warnings: int }),
    ),
  }),
  ClusterInput: {
    type: "object",
    required: ["name", "server", "token"],
    properties: {
      name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$" },
      server: { type: "string", description: "The API server's https:// URL." },
      caCert: { ...nul(str), description: "The cluster CA in PEM; null to use the system's." },
      token: {
        type: "string",
        writeOnly: true,
        description: "Token of the read-only service account from GET /api/v1/setup. Stored encrypted, never returned.",
      },
      intervalMinutes: { type: "integer", minimum: 1, maximum: 1440, default: 5 },
      tags: map,
    },
  },
  ClusterFacts: {
    type: "object",
    required: ["collectedAt", "version", "nodes", "workloads", "pods"],
    description: "Nodes, namespaces, workloads, pods, services, ingresses, volumes, cluster-admin bindings and recent warnings.",
  },
  Change: obj({
    id: int,
    target: obj({ kind: { type: "string", enum: ["host", "cluster"] }, id: str, name: str }),
    at: dt,
    category: str,
    item: str,
    change: { type: "string", enum: ["added", "removed", "changed"] },
    before: nul(str),
    after: nul(str),
  }),
  Changes: { type: "object", required: ["changes"], properties: { changes: arr(ref("Change")), nextCursor: str } },
  Agent: obj({
    id: str,
    name: str,
    status: { type: "string", enum: ["waiting-to-enrol", "online", "offline", "version-mismatch"] },
    version: nul(str),
    caFingerprint: { ...nul(str), description: "Of the SSH certificate authority the agent made; hosts read by it trust this CA." },
    lastSeenAt: nul(dt),
    lastError: nul(str),
    hosts: int,
    createdAt: dt,
  }),
  NewAgent: obj({
    agent: ref("Agent"),
    enrollToken: { type: "string", description: "One-time; start infra-agent with INFRA_ENROLL_TOKEN set to it. Shown once." },
    enrollExpiresAt: dt,
  }),
  AgentSetup: obj({
    agent: ref("Agent"),
    caPublicKey: str,
    caFingerprint: str,
    keyPublicKey: nul(str),
    sshdConfig: str,
    sudoers: str,
    hostSetup: str,
    authorizedKey: str,
  }),
  AgentReport: {
    type: "object",
    required: ["version", "caPublicKey", "keyPublicKey", "setup"],
    description:
      "What infra-agent says about itself on every call: its version (it must equal infra's, ADR 0019), its public keys, and the host setup that matches its script.",
    properties: {
      version: str,
      caPublicKey: str,
      keyPublicKey: str,
      setup: obj({ sshdConfig: str, sudoers: str, hostSetup: str, authorizedKey: str }),
      running: int,
    },
  },
  Job: obj({
    id: str,
    hostId: str,
    action: { type: "string", enum: ["collect", "host-key"] },
    target: obj({ address: str, port: int, user: str, hostKeys: arr(str), auth: { type: "string", enum: ["certificate", "key"] }, containers: bool }),
    jump: nul(obj({ address: str, port: int, user: str, hostKeys: arr(str) })),
  }),
  Result: {
    type: "object",
    required: ["jobId", "hostId", "ok"],
    description: "One of: facts (a collection), hostKeys (the keys a host presents), or error.",
    properties: { jobId: str, hostId: str, ok: bool, facts: ref("Facts"), hostKeys: arr(str), error: obj({ kind: str, message: str }) },
  },
  ProductLink: obj({
    id: { type: "string", description: "The product, as OpenAsy names it.", examples: ["vpn"] },
    url: { type: "string", format: "uri", description: "The address people open it at.", examples: ["https://vpn.example.com"] },
  }),
  Summary: obj({
    agents: { type: "object", additionalProperties: int },
    hosts: { type: "object", additionalProperties: int },
    clusters: { type: "object", additionalProperties: int },
    containers: int,
    changesLastDay: int,
    hostsFile: { ...nul(ref("HostsFile")), description: "null when OPENASY_HOSTS is not set." },
  }),
  HostsFile: {
    ...obj({
      path: str,
      appliedAt: { ...nul(dt), description: "When it was last read and applied; null if it never was." },
      entries: int,
      error: { ...nul(str), description: "Why the file on disk is not applied." },
      warnings: { ...arr(str), description: "What to fix that did not stop the file from being applied, such as a host whose agent is not enrolled yet." },
    }),
    description:
      "The hosts file (ADR 0052), shared with Logs. It is read again within a minute of a change; a file that cannot be applied leaves the hosts from its last good version.",
  },
};

const P = (...codes: number[]) => Object.fromEntries(codes.map((c) => [String(c), { $ref: "#/components/responses/Problem" }]));
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = (schema: S) => ({ required: true, content: { "application/json": { schema } } });
const id = { name: "id", in: "path", required: true, schema: str };
const pageParams = [
  { name: "category", in: "query", schema: str, description: "package, port, service, user, sudo, ssh-key, container, ..." },
  { name: "since", in: "query", schema: dt },
  { name: "cursor", in: "query", schema: str },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
];
const SEC = [{ session: [] }, { apiToken: [] }];
const AGENT_SEC = [{ agentSecret: [] }];
const op = (o: {
  id: string;
  tag: string;
  summary: string;
  description?: string;
  role?: string;
  security?: unknown[];
  params?: unknown[];
  body?: S;
  responses: Record<string, unknown>;
}) => ({
  operationId: o.id,
  tags: [o.tag],
  summary: o.summary,
  ...(o.description || o.role ? { description: [o.description, o.role && `Needs the ${o.role} role.`].filter(Boolean).join("\n\n") } : {}),
  ...(o.role && { security: SEC, "x-openasy-role": o.role }),
  ...(o.security && { security: o.security }),
  ...(o.params && { parameters: o.params }),
  ...(o.body && { requestBody: body(o.body) }),
  responses: o.responses,
});
const R = (role: string) => P(...(role ? [401, 403] : []));

const spec = {
  openapi: "3.1.1",
  info: {
    title: "OpenAsy Infrastructure API",
    version: "0.1.0",
    summary: "Hosts, containers and Kubernetes, read without installing anything, with every change kept.",
    description:
      "Every screen of Infrastructure uses this API, and so can your scripts (ADR 0014). Within `/api/v1` changes are additive only (ADR 0024). Errors use Problem Details (RFC 9457).\n\nHosts are read over SSH as an unprivileged `openasy` account with 5-minute certificates, and clusters through their API with a read-only token (ADR 0031). Each operation names the role it needs (`x-openasy-role`). Sign-in, members and API tokens are under `/api/v1/auth`, provided by [@openasy/auth](https://github.com/openasy/auth#routes).",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/", description: "This Infrastructure" }],
  tags: [
    { name: "Agents", description: "infra-agent: installed once, it reads hosts over SSH. Nothing is installed on the hosts (ADR 0031)." },
    { name: "Hosts", description: "Servers an agent reads over SSH." },
    { name: "Clusters", description: "Kubernetes read through its API." },
    { name: "Changes", description: "What changed, and when." },
    { name: "Setup", description: "What to put on hosts and clusters." },
    { name: "Product", description: "Version, health and overview." },
  ],
  paths: {
    "/api/v1/version": { get: op({ id: "version", tag: "Product", summary: "Version", responses: { "200": ok(obj({ product: str, version: str })) } }) },
    "/api/v1/products": {
      get: op({
        id: "listProducts",
        tag: "Product",
        summary: "Other OpenAsy products",
        description: "The OpenAsy products of this install and their addresses, from `OPENASY_PRODUCTS`, for the product switcher. Empty when it is not set.",
        role: "viewer",
        responses: { "200": ok(obj({ products: arr(ref("ProductLink")) }), "The products, in the order they are configured."), ...R("v") },
      }),
    },
    "/api/v1/summary": { get: op({ id: "summary", tag: "Product", summary: "Overview", role: "viewer", responses: { "200": ok(ref("Summary")), ...R("v") } }) },
    "/api/v1/setup": {
      get: op({
        id: "setup",
        tag: "Setup",
        summary: "The read-only Kubernetes role",
        description: "What to put on hosts comes from each agent: GET /api/v1/agents/{id}/setup.",
        role: "viewer",
        responses: { "200": ok(obj({ kubernetesRbac: str })), ...R("v") },
      }),
    },
    "/api/v1/agents": {
      get: op({
        id: "listAgents",
        tag: "Agents",
        summary: "List agents",
        role: "viewer",
        responses: { "200": ok(obj({ agents: arr(ref("Agent")) })), ...R("v") },
      }),
      post: op({
        id: "createAgent",
        tag: "Agents",
        summary: "Add an agent",
        description: "Returns a one-time enrolment token, valid for 7 days. Start infra-agent with it; the agent then has its own secret (ADR 0023).",
        role: "admin",
        body: obj({ name: str }),
        responses: { "201": ok(ref("NewAgent"), "Added"), ...R("a"), ...P(400, 409, 422) },
      }),
    },
    "/api/v1/agents/{id}": {
      get: op({
        id: "getAgent",
        tag: "Agents",
        summary: "Get an agent",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("Agent")), ...R("v"), ...P(404) },
      }),
      delete: op({
        id: "deleteAgent",
        tag: "Agents",
        summary: "Remove an agent",
        description: "Only an agent that reads no hosts. Its secret stops working.",
        role: "admin",
        params: [id],
        responses: { "204": { description: "Removed" }, ...R("a"), ...P(404, 409) },
      }),
    },
    "/api/v1/agents/{id}/enroll-token": {
      post: op({
        id: "reEnrollAgent",
        tag: "Agents",
        summary: "Enrol an agent again",
        description:
          "A new one-time token, for an agent that lost its volume or whose CA changed. Its old secret stops working; its hosts must trust the new CA.",
        role: "admin",
        params: [id],
        responses: { "200": ok(ref("NewAgent")), ...R("a"), ...P(404) },
      }),
    },
    "/api/v1/agents/{id}/setup": {
      get: op({
        id: "agentSetup",
        tag: "Setup",
        summary: "What to put on the hosts this agent reads",
        description: "Its CA public key, the sshd drop-in, the sudoers file that matches its script, the commands to prepare a host and the fixed key.",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("AgentSetup")), ...R("v"), ...P(404, 409) },
      }),
    },
    "/api/v1/agent/enroll": {
      post: op({
        id: "agentEnroll",
        tag: "Agents",
        summary: "infra-agent: enrol with a one-time token",
        description: "Called by infra-agent, not by people. Returns the agent's own secret for every later call.",
        body: { allOf: [ref("AgentReport"), obj({ token: str })] },
        responses: { "200": ok(obj({ agentId: str, secret: str })), ...P(400, 401, 422) },
      }),
    },
    "/api/v1/agent/work": {
      post: op({
        id: "agentWork",
        tag: "Agents",
        summary: "infra-agent: ask for jobs",
        description:
          "Called by infra-agent with its secret every few seconds. Each job is leased for 10 minutes. Answers 409 when the agent's version differs from infra's (ADR 0019).",
        body: ref("AgentReport"),
        security: AGENT_SEC,
        responses: { "200": ok(obj({ jobs: arr(ref("Job")) })), ...P(400, 401, 409, 422) },
      }),
    },
    "/api/v1/agent/results": {
      post: op({
        id: "agentResult",
        tag: "Agents",
        summary: "infra-agent: send what a job found",
        description: "Facts are parsed and masked by the agent; Infrastructure checks their shape and stores what changed. Gzip the body.",
        body: ref("Result"),
        security: AGENT_SEC,
        responses: { "202": ok(obj({ status: str }), "Accepted"), ...P(400, 401, 404, 409, 422) },
      }),
    },
    "/api/v1/hosts": {
      get: op({ id: "listHosts", tag: "Hosts", summary: "List hosts", role: "viewer", responses: { "200": ok(obj({ hosts: arr(ref("Host")) })), ...R("v") } }),
      post: op({
        id: "createHost",
        tag: "Hosts",
        summary: "Add a host",
        description: "Infrastructure asks the host for its key right away. Check the fingerprint on the host and accept it before the first collection.",
        role: "admin",
        body: ref("HostInput"),
        responses: { "201": ok(ref("Host"), "Added"), ...R("a"), ...P(400, 409, 422) },
      }),
    },
    "/api/v1/hosts/{id}": {
      get: op({
        id: "getHost",
        tag: "Hosts",
        summary: "Get a host",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("Host")), ...R("v"), ...P(404) },
      }),
      patch: op({
        id: "updateHost",
        tag: "Hosts",
        summary: "Change a host",
        description: "A new address or port unpins the host key.",
        role: "admin",
        params: [id],
        body: { type: "object", properties: (schemas.HostInput as { properties: S }).properties },
        responses: { "200": ok(ref("Host")), ...R("a"), ...P(400, 404, 409, 422) },
      }),
      delete: op({
        id: "deleteHost",
        tag: "Hosts",
        summary: "Remove a host and its history",
        role: "admin",
        params: [id],
        responses: { "204": { description: "Removed" }, ...R("a"), ...P(404, 409) },
      }),
    },
    "/api/v1/hosts/{id}/facts": {
      get: op({
        id: "hostFacts",
        tag: "Hosts",
        summary: "What the host has",
        description: "The last collection, or with `at` the one in effect at that time.",
        role: "viewer",
        params: [id, { name: "at", in: "query", schema: dt }],
        responses: { "200": ok(obj({ facts: ref("Facts"), collectedAt: dt })), ...R("v"), ...P(404, 422) },
      }),
    },
    "/api/v1/hosts/{id}/changes": {
      get: op({
        id: "hostChanges",
        tag: "Changes",
        summary: "What changed on a host",
        role: "viewer",
        params: [id, ...pageParams],
        responses: { "200": ok(ref("Changes")), ...R("v"), ...P(404, 422) },
      }),
    },
    "/api/v1/hosts/{id}/collect": {
      post: op({
        id: "collectHost",
        tag: "Hosts",
        summary: "Collect now",
        role: "editor",
        params: [id],
        responses: { "202": ok(obj({ status: str }), "Requested"), ...R("e"), ...P(404, 409) },
      }),
    },
    "/api/v1/hosts/{id}/host-key": {
      post: op({
        id: "fetchHostKey",
        tag: "Hosts",
        summary: "Ask the host for its key again",
        role: "admin",
        params: [id],
        responses: { "200": ok(ref("Host")), ...R("a"), ...P(404) },
      }),
    },
    "/api/v1/hosts/{id}/host-key/accept": {
      post: op({
        id: "acceptHostKey",
        tag: "Hosts",
        summary: "Accept a host key",
        description: "After checking on the host that `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints this fingerprint.",
        role: "admin",
        params: [id],
        body: obj({ fingerprint: str }),
        responses: { "200": ok(ref("Host")), ...R("a"), ...P(400, 404, 409, 422) },
      }),
    },
    "/api/v1/clusters": {
      get: op({
        id: "listClusters",
        tag: "Clusters",
        summary: "List clusters",
        role: "viewer",
        responses: { "200": ok(obj({ clusters: arr(ref("Cluster")) })), ...R("v") },
      }),
      post: op({
        id: "createCluster",
        tag: "Clusters",
        summary: "Add a cluster",
        role: "admin",
        body: ref("ClusterInput"),
        responses: { "201": ok(ref("Cluster"), "Added"), ...R("a"), ...P(400, 409, 422) },
      }),
    },
    "/api/v1/clusters/{id}": {
      get: op({
        id: "getCluster",
        tag: "Clusters",
        summary: "Get a cluster",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("Cluster")), ...R("v"), ...P(404) },
      }),
      patch: op({
        id: "updateCluster",
        tag: "Clusters",
        summary: "Change a cluster",
        role: "admin",
        params: [id],
        body: { type: "object", properties: (schemas.ClusterInput as { properties: S }).properties },
        responses: { "200": ok(ref("Cluster")), ...R("a"), ...P(400, 404, 409, 422) },
      }),
      delete: op({
        id: "deleteCluster",
        tag: "Clusters",
        summary: "Remove a cluster and its history",
        role: "admin",
        params: [id],
        responses: { "204": { description: "Removed" }, ...R("a"), ...P(404) },
      }),
    },
    "/api/v1/clusters/{id}/facts": {
      get: op({
        id: "clusterFacts",
        tag: "Clusters",
        summary: "What the cluster runs",
        role: "viewer",
        params: [id],
        responses: { "200": ok(ref("ClusterFacts")), ...R("v"), ...P(404) },
      }),
    },
    "/api/v1/clusters/{id}/changes": {
      get: op({
        id: "clusterChanges",
        tag: "Changes",
        summary: "What changed in a cluster",
        role: "viewer",
        params: [id, ...pageParams],
        responses: { "200": ok(ref("Changes")), ...R("v"), ...P(404, 422) },
      }),
    },
    "/api/v1/clusters/{id}/collect": {
      post: op({
        id: "collectCluster",
        tag: "Clusters",
        summary: "Collect now",
        role: "editor",
        params: [id],
        responses: { "202": ok(obj({ status: str }), "Requested"), ...R("e"), ...P(404) },
      }),
    },
    "/api/v1/containers": {
      get: op({
        id: "listContainers",
        tag: "Hosts",
        summary: "Containers on every host",
        role: "viewer",
        responses: { "200": ok(obj({ containers: arr(ref("Container")) })), ...R("v") },
      }),
    },
    "/api/v1/changes": {
      get: op({
        id: "listChanges",
        tag: "Changes",
        summary: "What changed everywhere",
        role: "viewer",
        params: [{ name: "kind", in: "query", schema: { type: "string", enum: ["host", "cluster"] } }, ...pageParams],
        responses: { "200": ok(ref("Changes")), ...R("v"), ...P(422) },
      }),
    },
    "/healthz": { get: { operationId: "healthz", tags: ["Product"], summary: "Liveness", responses: { "200": ok(obj({ status: str })) } } },
    "/readyz": {
      get: {
        operationId: "readyz",
        tags: ["Product"],
        summary: "Readiness",
        responses: { "200": ok(obj({ status: str })), "503": ok(obj({ status: str }), "Not ready") },
      },
    },
    "/metrics": {
      get: {
        operationId: "metrics",
        tags: ["Product"],
        summary: "Prometheus metrics",
        responses: { "200": { description: "Prometheus text format", content: { "text/plain": { schema: str } } } },
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-openasy-session",
        description: "The browser session after signing in (`openasy-session` on plain http://localhost).",
      },
      apiToken: {
        type: "http",
        scheme: "bearer",
        description: "An API token from Settings → API tokens (`oa_infra_...`): one role, always an expiry (ADR 0003).",
      },
      agentSecret: { type: "http", scheme: "bearer", description: "infra-agent's own secret (`oia_...`), from enrolment (ADR 0023)." },
    },
    responses: { Problem: { description: "An error, as RFC 9457 Problem Details.", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = spec;
if (import.meta.url === `file://${process.argv[1]}`) writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");

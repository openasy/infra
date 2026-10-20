import { Badge, Button, Callout, EmptyState, PageHeader, Panel, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Agent, NewAgent } from "./api.ts";
import { ago, Code, List, useData, type Call } from "./shared.tsx";

const STATUS: Record<string, { tone: "success" | "warning" | "danger" | "info"; label: string }> = {
  online: { tone: "success", label: "Online" },
  offline: { tone: "danger", label: "Offline" },
  "waiting-to-enrol": { tone: "info", label: "Waiting to enrol" },
  "version-mismatch": { tone: "danger", label: "Other version" },
};

/** How to start infra-agent with its one-time token, next to Infrastructure or in another network. */
function EnrollCommand({ token, expiresAt, version }: { token: string; expiresAt: string; version?: string }) {
  const here = window.location.origin;
  return (
    <Callout tone="warning" title="Start the agent with this one-time token">
      <span className="flex flex-col gap-2">
        <span>It works once, until {new Date(expiresAt).toLocaleString()}, and is not shown again. With the compose file of Infrastructure:</span>
        <Code label="Start the agent next to Infrastructure">{`INFRA_ENROLL_TOKEN=${token} docker compose up -d infra-agent`}</Code>
        <span>In another network, on any server that reaches the hosts there and reaches Infrastructure:</span>
        <Code label="Start the agent in another network">
          {`openssl rand -hex 32 > openasy-agent-kek
docker run -d --name infra-agent --restart unless-stopped --read-only --tmpfs /tmp \\
  --cap-drop ALL --security-opt no-new-privileges \\
  -v infra-agent-data:/data -v "$PWD/openasy-agent-kek:/run/secrets/openasy-agent-kek:ro" \\
  -e INFRA_URL=${here} -e INFRA_ENROLL_TOKEN=${token} \\
  ghcr.io/openasy/infra-agent:${version ?? "<the version of Infrastructure>"}`}
        </Code>
      </span>
    </Callout>
  );
}

export function AgentsPage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 10_000);
  // The agent must be the same version as Infrastructure (ADR 0019).
  const version = useData<{ version: string }>(call, "/api/v1/version", 0).data?.version;
  const [name, setName] = useState("");
  const [created, setCreated] = useState<NewAgent>();
  const [error, setError] = useState<string>();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setCreated(await call<NewAgent>("/api/v1/agents", { method: "POST", body: JSON.stringify({ name }) }));
      setName("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const cols: Column<Agent>[] = [
    { id: "name", header: "Agent", cell: (a) => a.name, sortValue: (a) => a.name },
    { id: "status", header: "Status", width: "150px", cell: (a) => <Badge tone={STATUS[a.status]?.tone ?? "neutral"}>{STATUS[a.status]?.label ?? a.status}</Badge> },
    { id: "hosts", header: "Hosts", width: "80px", align: "right", cell: (a) => a.hosts },
    { id: "version", header: "Version", width: "90px", mono: true, cell: (a) => a.version ?? "–" },
    { id: "ca", header: "CA fingerprint", cell: (a) => <span className="infra-wrap font-mono text-xs">{a.caFingerprint ?? "–"}</span> },
    { id: "seen", header: "Last seen", width: "110px", cell: (a) => <span title={a.lastError ?? undefined}>{ago(a.lastSeenAt)}</span> },
    {
      id: "actions",
      header: "",
      width: "200px",
      cell: (a) =>
        can("admin") && (
          <span className="flex gap-1">
            <Button size="xs" variant="ghost" icon={<RotateCw />} onClick={() => window.confirm(`Enrol ${a.name} again? Its secret stops working; if its CA changes, the hosts it reads must trust the new one.`) && void call<NewAgent>(`/api/v1/agents/${a.id}/enroll-token`, { method: "POST" }).then((r) => (setCreated(r), reload()))}>
              Enrol again
            </Button>
            {a.hosts === 0 && (
              <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => window.confirm(`Remove ${a.name}?`) && void call(`/api/v1/agents/${a.id}`, { method: "DELETE" }).then(reload)}>
                Remove
              </Button>
            )}
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Agents"
        description="infra-agent is installed once, next to Infrastructure or in another network, and reads the hosts there over SSH. It keeps the SSH certificate authority; Infrastructure only says which host to read. Nothing is installed on the hosts."
      />
      {can("admin") && (
        <Panel title="Add an agent">
          <form onSubmit={add} className="flex flex-wrap items-end gap-2">
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="dc-frankfurt" error={error} />
            <Button type="submit" variant="primary" icon={<Plus />} disabled={!name}>
              Add agent
            </Button>
          </form>
        </Panel>
      )}
      {created && <EnrollCommand token={created.enrollToken} expiresAt={created.enrollExpiresAt} version={version} />}
      {data?.agents.length === 0 ? (
        <EmptyState title="No agents yet">Add one; it reads the hosts you add under Hosts.</EmptyState>
      ) : (
        <Panel flush>
          <List label="Agents" rows={data?.agents} columns={cols} empty="No agents" getRowId={(a) => a.id} />
        </Panel>
      )}
    </>
  );
}

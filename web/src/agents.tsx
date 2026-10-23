import { Badge, Button, Callout, Dialog, EmptyState, PageHeader, Panel, TextField, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Check, Plus, RotateCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Agent, NewAgent } from "./api.ts";
import { Code, List, useData, type Call } from "./shared.tsx";
import { useT, type T } from "./i18n.ts";

const STATUS = (t: T): Record<string, { tone: "success" | "warning" | "danger" | "info"; label: string }> => ({
  online: { tone: "success", label: t("status.online") },
  offline: { tone: "danger", label: t("status.offline") },
  "waiting-to-enrol": { tone: "info", label: t("status.waitingToEnrol") },
  "version-mismatch": { tone: "danger", label: t("status.otherVersion") },
});

/** How to start infra-agent with its one-time token, next to Infrastructure or in another network. */
function EnrollCommand({ token, expiresAt, version, onDone }: { token: string; expiresAt: string; version?: string; onDone: () => void }) {
  const t = useT();
  const here = window.location.origin;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      size="lg"
      icon={<Check aria-hidden className="size-4" />}
      iconTone="success"
      title={t("enrollCommand.startTheAgentWithThis")}
      description={t("enrollCommand.itWorksOnceUntilAnd", { value: new Date(expiresAt).toLocaleString() })}
      footer={
        <Button variant="primary" onClick={onDone}>
          {t("enrollCommand.done")}
        </Button>
      }
    >
      <span className="flex flex-col gap-2">
        <span>{t("enrollCommand.withTheComposeFileOf")}</span>
        <Code label={t("enrollCommand.startTheAgentNextTo")}>{`INFRA_ENROLL_TOKEN=${token} docker compose up -d infra-agent`}</Code>
        <span>{t("enrollCommand.inAnotherNetworkOnAny")}</span>
        <Code label={t("enrollCommand.startTheAgentInAnother")}>
          {`openssl rand -hex 32 > openasy-agent-kek
docker run -d --name infra-agent --restart unless-stopped --read-only --tmpfs /tmp \\
  --cap-drop ALL --security-opt no-new-privileges \\
  -v infra-agent-data:/data -v "$PWD/openasy-agent-kek:/run/secrets/openasy-agent-kek:ro" \\
  -e INFRA_URL=${here} -e INFRA_ENROLL_TOKEN=${token} \\
  ghcr.io/openasy/infra-agent:${version ?? "<the version of Infrastructure>"}`}
        </Code>
      </span>
      <Callout tone="warning" title={t("enrollCommand.closingThisDialogHidesThe")}>
        {t("enrollCommand.ifItIsLostEnrol")}
      </Callout>
    </Dialog>
  );
}

export function AgentsPage({ call }: { call: Call }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const { data, reload } = useData<{ agents: Agent[] }>(call, "/api/v1/agents", 10_000);
  // The agent must be the same version as Infrastructure (ADR 0019).
  const version = useData<{ version: string }>(call, "/api/v1/version", 0).data?.version;
  const [name, setName] = useState("");
  const [created, setCreated] = useState<NewAgent>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => (setAdding(false), setName(""), setError(undefined));
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await call<NewAgent>("/api/v1/agents", { method: "POST", body: JSON.stringify({ name }) });
      close();
      setCreated(r);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const cols: Column<Agent>[] = [
    { id: "name", header: t("agentsPage.agent"), cell: (a) => a.name, sortValue: (a) => a.name },
    { id: "status", header: t("agentsPage.status"), width: "150px", cell: (a) => <Badge tone={STATUS(t)[a.status]?.tone ?? "neutral"}>{STATUS(t)[a.status]?.label ?? a.status}</Badge> },
    { id: "hosts", header: t("agentsPage.hosts"), width: "80px", align: "right", cell: (a) => a.hosts },
    { id: "version", header: t("agentsPage.version"), width: "90px", mono: true, cell: (a) => a.version ?? "–" },
    { id: "ca", header: t("agentsPage.caFingerprint"), cell: (a) => <span className="infra-wrap font-mono text-xs">{a.caFingerprint ?? "–"}</span> },
    { id: "seen", header: t("agentsPage.lastSeen"), width: "110px", cell: (a) => <span title={a.lastError ?? undefined}>{ago(a.lastSeenAt)}</span> },
    {
      id: "actions",
      header: "",
      width: "200px",
      cell: (a) =>
        can("admin") && (
          <span className="flex gap-1">
            <Button size="xs" variant="ghost" icon={<RotateCw />} onClick={() => window.confirm(t("agentsPage.enrolAgainItsSecretStops", { name: a.name })) && void call<NewAgent>(`/api/v1/agents/${a.id}/enroll-token`, { method: "POST" }).then((r) => (setCreated(r), reload()))}>
              {t("agentsPage.enrolAgain")}
            </Button>
            {a.hosts === 0 && (
              <Button size="xs" variant="ghost" icon={<Trash2 />} onClick={() => window.confirm(t("agentsPage.remove", { name: a.name })) && void call(`/api/v1/agents/${a.id}`, { method: "DELETE" }).then(reload)}>
                {t("agentsPage.remove2")}
              </Button>
            )}
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("agentsPage.agents")}
        description={t("agentsPage.infraAgentIsInstalledOnce")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("agentsPage.addAgent")}
            </Button>
          )
        }
      />
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        size="sm"
        title={t("agentsPage.addAnAgent")}
        description={t("agentsPage.nameItAfterWhereIt")}
        onSubmit={add}
        footer={
          <>
            <Button type="button" onClick={close}>
              {t("agentsPage.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!name}>
              {t("agentsPage.addAgent")}
            </Button>
          </>
        }
      >
        <TextField label={t("agentsPage.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="dc-frankfurt" error={error} />
      </Dialog>
      {created && <EnrollCommand token={created.enrollToken} expiresAt={created.enrollExpiresAt} version={version} onDone={() => setCreated(undefined)} />}
      {data?.agents.length === 0 ? (
        <EmptyState title={t("agentsPage.noAgentsYet")}>{t("agentsPage.addOneItReadsThe")}</EmptyState>
      ) : (
        <Panel flush>
          <List label={t("agentsPage.agents")} rows={data?.agents} columns={cols} empty={t("agentsPage.noAgents")} getRowId={(a) => a.id} />
        </Panel>
      )}
    </>
  );
}

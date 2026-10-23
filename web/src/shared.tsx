import { Badge, Button, DataTable, EmptyState, StatusBadge, type Column, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Copy } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Change } from "./api.ts";
import { useT, type T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path now and every `everyMs`; `reload` loads it again at once. */
export function useData<T>(call: Call, path: string | null, everyMs = 15_000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    if (!path) return;
    call<T>(path).then(
      (d) => {
        setData(d);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, [call, path]);
  useEffect(() => {
    setData(undefined);
    load();
    if (!everyMs) return;
    const t = setInterval(load, everyMs);
    return () => clearInterval(t);
  }, [load, everyMs]);
  return { data, error, reload: load };
}

export function duration(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86_400)} d`;
}

export const bytes = (n: number | null | undefined) => {
  if (n == null) return "–";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) ((v /= 1024), i++);
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

const STATUS = (t: T): Record<string, { tone: "success" | "warning" | "danger" | "info" | "neutral"; label: string }> => ({
  ok: { tone: "success", label: t("status.ok") },
  new: { tone: "info", label: t("status.new") },
  pending: { tone: "info", label: t("status.waitingForTheFirstCollection") },
  "host-key-pending": { tone: "warning", label: t("status.checkTheHostKey") },
  "host-key-changed": { tone: "danger", label: t("status.hostKeyChanged") },
  unreachable: { tone: "danger", label: t("status.unreachable") },
  "auth-failed": { tone: "danger", label: t("status.loginRefused") },
  forbidden: { tone: "danger", label: t("status.notAllowed") },
  timeout: { tone: "warning", label: t("status.timedOut") },
  error: { tone: "danger", label: t("status.failed") },
});
export function Status({ status }: { status: string }) {
  const t = useT();
  const s = STATUS(t)[status] ?? { tone: "neutral" as const, label: status };
  return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
}

export function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

/** A file or commands to copy onto a host. */
export function Code({ children, label }: { children: string; label: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <pre tabIndex={0} aria-label={label} className="infra-code">
        {children}
      </pre>
      <div>
        <Button size="xs" icon={<Copy />} onClick={() => copy(children)}>
          {t("code.copy")}
        </Button>
      </div>
    </div>
  );
}

export function Pairs({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="infra-pairs text-sm">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? "–"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Usage({ pct }: { pct: number }) {
  const level = pct >= 90 ? "bad" : pct >= 75 ? "warn" : "ok";
  return (
    <span className="flex items-center gap-2 font-mono text-xs">
      <span className="infra-bar" data-level={level} aria-hidden>
        <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      {pct}%
    </span>
  );
}

/** A simple table of rows, with search over every column, for the many lists of a host. */
export function List<T>({
  label,
  rows,
  columns,
  empty,
  getRowId,
  pageSize = 50,
}: {
  label: string;
  rows: T[] | undefined;
  columns: Column<T>[];
  empty: string;
  getRowId: (r: T) => string;
  pageSize?: number;
}) {
  return (
    <DataTable
      label={label}
      columns={columns}
      rows={rows ?? []}
      loading={!rows}
      getRowId={getRowId}
      pageSize={pageSize}
      density="compact"
      empty={<EmptyState title={empty} />}
    />
  );
}

const CHANGE_TONE = { added: "success", removed: "danger", changed: "info" } as const;
const pretty = (v: string | null) => {
  if (v === null) return null;
  try {
    const o = JSON.parse(v) as unknown;
    if (o && typeof o === "object")
      return Object.entries(o as Record<string, unknown>)
        .map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(", ") || "–" : String(x)}`)
        .join(" · ");
  } catch {
    // Not JSON: shown as it is.
  }
  return v;
};

/** What changed, newest first. */
export function ChangeList({ changes, showTarget = false }: { changes: Change[] | undefined; showTarget?: boolean }) {
  const ago = useAgo();
  const t = useT();
  const columns: Column<Change>[] = [
    {
      id: "at",
      header: t("changeList.when"),
      width: "120px",
      cell: (c) => <span title={new Date(c.at).toLocaleString()}>{ago(c.at)}</span>,
      sortValue: (c) => c.at,
    },
    ...(showTarget
      ? [
          {
            id: "target",
            header: t("changeList.where"),
            width: "160px",
            cell: (c: Change) => <a href={`/${c.target.kind === "host" ? "hosts" : "clusters"}/${c.target.id}`}>{c.target.name}</a>,
          } satisfies Column<Change>,
        ]
      : []),
    { id: "change", header: t("changeList.change"), width: "100px", cell: (c) => <Badge tone={CHANGE_TONE[c.change]}>{c.change}</Badge> },
    { id: "category", header: t("changeList.what"), width: "120px", cell: (c) => c.category },
    {
      id: "item",
      header: t("changeList.item"),
      cell: (c) => (
        <span className="infra-wrap flex flex-col gap-0.5 font-mono text-xs">
          <span>{c.item}</span>
          {c.change === "changed" && <span className="infra-before">{pretty(c.before)}</span>}
          {c.change !== "removed" && c.after !== "present" && c.after !== "running" && c.after !== "loaded" && <span>{pretty(c.after)}</span>}
        </span>
      ),
    },
  ];
  return <List label={t("changeList.changes")} rows={changes} columns={columns} empty={t("changeList.noChangesYetTheFirst")} getRowId={(c) => String(c.id)} />;
}

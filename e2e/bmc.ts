// A BMC for the end-to-end test (ADR 0029, 0055): Redfish over TLS with its own self-signed certificate, answering
// from the tree infra-agent's tests read (agent/fixtures/redfish-idrac9.json). It takes Basic auth or a session's
// token like iDRAC and iLO do (ADR 0056), and logs every request, so the test can check that the agent reads with GET
// and signs in and out of one session only.
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const tree = JSON.parse(readFileSync("/bmc/tree.json", "utf8")) as Record<string, unknown>;
const password = readFileSync("/bmc/password", "utf8").trim();
const expected = `Basic ${Buffer.from(`openasy:${password}`).toString("base64")}`;
const SESSIONS = "/redfish/v1/SessionService/Sessions";
const sessions = new Map<string, string>();
let made = 0;

createServer({ key: readFileSync("/bmc/tls/key.pem"), cert: readFileSync("/bmc/tls/cert.pem") }, (req, res) => {
  const token = req.headers["x-auth-token"];
  const signedIn = typeof token === "string" && sessions.has(token);
  const authed = req.headers.authorization === expected || signedIn;
  const auth = signedIn ? "token" : req.headers.authorization || token ? (authed ? "right" : "wrong") : "none";
  const log = (extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ method: req.method, path: req.url, auth, ...extra }));
  // Signing in needs no account: the account is in the body.
  if (req.method === "POST" && req.url === SESSIONS) {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw || "{}") as { UserName?: string; Password?: string };
      const right = b.UserName === "openasy" && b.Password === password;
      log({ auth: right ? "right" : "wrong" });
      if (!right) return res.writeHead(401).end();
      const id = String(++made);
      const t = `token-${id}-${Math.random().toString(36).slice(2)}`;
      sessions.set(t, id);
      res.writeHead(201, { "x-auth-token": t, location: `${SESSIONS}/${id}`, "content-type": "application/json" }).end(JSON.stringify({ Id: id }));
    });
    return;
  }
  log();
  // The service root answers without signing in, as Redfish says; everything else needs the account.
  if (req.url !== "/redfish/v1" && !authed) return res.writeHead(401, { "www-authenticate": 'Basic realm="Redfish"' }).end();
  if (req.method === "DELETE" && signedIn && req.url === `${SESSIONS}/${sessions.get(token)}`) {
    sessions.delete(token);
    return res.writeHead(204).end();
  }
  if (req.method !== "GET") return res.writeHead(405).end();
  const body = tree[req.url ?? ""];
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json", "odata-version": "4.0" }).end(JSON.stringify(body));
}).listen(443, () => console.log(JSON.stringify({ listening: 443 })));

// A BMC for the end-to-end test (ADR 0029, 0055): Redfish over TLS with its own self-signed certificate, answering
// from the tree infra-agent's tests read (agent/fixtures/redfish-idrac9.json). It asks for Basic auth like iDRAC and
// iLO do, and logs every request, so the test can check that the agent only ever sends GET.
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const tree = JSON.parse(readFileSync("/bmc/tree.json", "utf8")) as Record<string, unknown>;
const expected = `Basic ${Buffer.from(`openasy:${readFileSync("/bmc/password", "utf8").trim()}`).toString("base64")}`;

createServer({ key: readFileSync("/bmc/tls/key.pem"), cert: readFileSync("/bmc/tls/cert.pem") }, (req, res) => {
  const authed = req.headers.authorization === expected;
  console.log(JSON.stringify({ method: req.method, path: req.url, auth: req.headers.authorization ? (authed ? "right" : "wrong") : "none" }));
  // The service root answers without signing in, as Redfish says; everything else needs the account.
  if (req.url !== "/redfish/v1" && !authed) return res.writeHead(401, { "www-authenticate": 'Basic realm="Redfish"' }).end();
  if (req.method !== "GET") return res.writeHead(405).end();
  const body = tree[req.url ?? ""];
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json", "odata-version": "4.0" }).end(JSON.stringify(body));
}).listen(443, () => console.log(JSON.stringify({ listening: 443 })));

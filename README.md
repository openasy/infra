# infra

[![CI](https://github.com/openasy/infra/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/infra/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Infrastructure product: every host, container and Kubernetes cluster, in
detail, with every change kept. **Nothing is installed on what it reads** (ADR 0018, 0031): one
[infra-agent](https://github.com/openasy/infra-agent) per network reads the hosts there over SSH, and infra reads
clusters through their API.

```
browser ──▶ infra (API, UI, changes) ◀── asks for jobs, sends results ── infra-agent ── SSH, 5-minute certificate ──▶ hosts
              │                                                          (keeps the SSH CA)
              └── Kubernetes API, read-only token ──▶ clusters
```

infra holds no SSH key and sends no commands. It tells an agent which host to read; the agent runs the collection
script built into it, with certificates for the `openasy` account only. A compromised infra cannot run commands on
your hosts.

## What it reads

| | |
| --- | --- |
| System | OS, kernel, CPU, memory, uptime and reboots, virtualization or hardware, serial number |
| Running | Processes with user and command, listening ports and the process behind each, systemd services and timers, cron |
| Access | Accounts and groups, whether each has a password or is locked (never the hash), sudo rules, SSH keys that may log in, the SSH server's settings |
| Software | Packages from dpkg, rpm or apk, kernel modules, security sysctls, firewall rules |
| Storage and network | File systems and usage, disks, interfaces, addresses, routes, DNS |
| Containers | Docker and Podman: image and digest, state, health, restarts, ports, mounts, limits, privileged, labels, environment variable names |
| Kubernetes | Nodes, namespaces, workloads, pods and restarts, services, ingresses, volumes, who is cluster-admin, recent warnings |

Every collection is compared with the last one. What was added, removed or changed (a package version, a new
account, a port that opened, an image that changed) is kept with its time; values that move all the time (CPU,
free memory) are not changes. A collection that changed nothing stores nothing new.

Values that look like secrets are masked before they are stored: container environment variables are kept by name
only, and passwords, tokens and keys in command lines are replaced with `***`.

## Run

```bash
openssl rand -hex 32 > openasy-kek
openssl rand -hex 32 > openasy-agent-kek
docker compose up -d infra
docker compose logs infra | grep 'no owner yet'
# then in the UI: Settings, Agents, Add agent, and with the token it shows:
INFRA_ENROLL_TOKEN=oie_... docker compose up -d infra-agent
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and
API are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

`openasy-kek` encrypts cluster tokens and sign-in secrets in infra's database; `openasy-agent-kek` encrypts the
agent's SSH certificate authority, keys and secret on its volume (ADR 0021). Keep each apart from its volume and with
your backups. Neither starts without its key. A lost agent volume means enrolling the agent again and pointing the
hosts at its new CA.

For hosts in another network, add another agent and run it there (Settings, Agents shows the command). It only needs
to reach infra and the hosts of its network; infra never connects to it.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `INFRA_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher: `identity=https://id.example.com,vpn=https://vpn.example.com`. Give every product the same value |
| `INFRA_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `INFRA_DB` | `/data/infra.db` | SQLite file (WAL), on the `/data` volume |
| `INFRA_RETENTION_DAYS` | `365` | Changes and snapshots older than this are deleted; the newest snapshot of each host stays |
| `INFRA_CONCURRENCY` | `4` | Cluster collections at the same time |
| `OPENASY_HOSTS` | | A YAML file of hosts, shared with Logs; see [From a file](#from-a-file) |
| `INFRA_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `INFRA_HEADLESS` | `false` | `true` serves only the API |
| `INFRA_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)). Owners can also add identity providers under Settings, Sign-in |

Both containers run as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. The
agent's key and certificate for one SSH connection live in `/tmp` (tmpfs) and are deleted when it ends.

## Prepare a host

Setup in the UI prints these with the CA of the agent that reads the host. As root on the host:

```bash
useradd --create-home --shell /bin/sh openasy && passwd -l openasy
install -d -m 755 /etc/ssh/principals && echo openasy > /etc/ssh/principals/openasy
echo 'ssh-ed25519 AAAA... OpenAsy Infrastructure CA' > /etc/ssh/openasy_ca.pub
cat > /etc/ssh/sshd_config.d/openasy.conf <<'EOF'
TrustedUserCAKeys /etc/ssh/openasy_ca.pub
AuthorizedPrincipalsFile /etc/ssh/principals/%u
Match User openasy
  PasswordAuthentication no
  AllowTcpForwarding no
  AllowAgentForwarding no
  AllowStreamLocalForwarding no
  X11Forwarding no
  PermitTTY no
EOF
sshd -t && systemctl reload ssh
```

- **The agent's CA is trusted for the `openasy` account only.** `AuthorizedPrincipalsFile` makes sshd accept its
  certificates only for the principals listed per account, so the CA can never log in as root or anyone else.
- **Certificates last 5 minutes** and allow no TTY, forwarding or agent. The agent signs one for each collection.
- **Host keys are pinned.** When you add a host, the agent reports the fingerprint it presents; compare it with
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host before accepting. If the key changes later,
  collection stops until an admin accepts the new one.
- **Details that need root are optional.** Setup also prints a sudoers file that allows a fixed list of read-only
  commands with fixed arguments and no wildcards (which process listens on a port, SSH keys, sudo rules, the SSH
  server's settings, firewall rules). Without it those details show as "not readable". CI checks the file against
  every way out we know of (`e2e/sudoers-test.sh`).
- **Containers are opt-in per host.** The `openasy` account needs the Docker socket, which is equivalent to root on
  that host; switch it on only where you accept that.
- **Hosts that cannot change `sshd_config`** take one fixed key in `~openasy/.ssh/authorized_keys`, prefixed with
  `restrict`: the agent's own key, which Setup prints, or a key of yours (see `keyFile` below). A fixed key lasts
  until it is removed.
- **Other networks** are reached through a jump host: add it as a host, set `AllowTcpForwarding yes` for `openasy`
  on it only, and choose it when adding hosts behind it.

What this means if something is compromised (ADR 0031): a compromised infra can make agents collect, nothing else. A
compromised agent can run commands as the unprivileged `openasy` account on the hosts that trust its CA, and the
read-only sudo commands where you allowed them; it cannot log in as anyone else. A certificate it signed is useless
five minutes later, but its CA, like a fixed key, opens the hosts until they stop trusting it: after a compromise,
remove the CA or key from the hosts. Run one agent per network so each CA is trusted only where it is needed.

### From a file

Hosts can also come from a file the install keeps, the same file Logs reads (ADR 0052). Mount it and set
`OPENASY_HOSTS`; Infrastructure reads it at start and again within a minute of a change.

```yaml
hosts:
  - name: bastion
    address: 203.0.113.2
    agent: dc1                        # the agent that reaches it, by name; may be left out when there is one
  - name: web-1
    address: 10.0.0.5
    port: 22                          # 22 by default
    user: openasy                     # openasy by default
    containers: true
    jump: bastion                     # another host in the file, reached directly by the same agent
    agent: dc1
    hostKey: SHA256:...               # optional: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the host, or first
    tags: { env: prod }
  - name: shop
    address: shop.example.com
    auth: key                         # a fixed key instead of a certificate
    keyFile: shop.key                 # optional: a private key in the agent's /keys folder, else the agent's own
```

- **keyFile is read by the agent alone.** Mount the folder into the agent, read-only, at `/keys`
  (`OPENASY_KEYS_DIR`); Infrastructure keeps and sends only the file name. It is a name, not a path, and the key has
  no passphrase. Put its public key, prefixed with `restrict`, in `~openasy/.ssh/authorized_keys` on the host.
- **hostKey is a trust decision made in the file.** A host that presents that key is trusted without an admin; one
  that presents another waits, and no other key can be accepted in the UI until hostKey changes. `hostKey: first`
  trusts the key the host presents the first time, as `ssh -o StrictHostKeyChecking=accept-new` does; a different key
  later waits for an admin, as for any host. It is quicker, but whoever answers at the address first is trusted.
  Without hostKey, the key is checked and accepted here as for any host. Whoever can change the file can already change
  the install.
- A host from the file shows **From file** and is changed there: the API answers 409 to a change or delete, while
  fetching its key again and collecting still work. Hosts added in the UI stay as they are.
- A host that cannot be added yet, because its agent is not enrolled or there are several agents and it names none,
  is a warning, and it is added once it can be. A host removed from the file is removed with its history.
- A file with a mistake is not applied at all: the hosts from its last good version stay, and the Hosts page and the
  log say what to fix. Endpoints in the endpoints file name these hosts with `server:`.

## Add a Kubernetes cluster

Setup prints a ServiceAccount with a read-only ClusterRole: no Secrets, no ConfigMaps (RBAC cannot limit a list to
names), nothing it can change. Apply it, then add the cluster with its API server URL, CA and the token:

```bash
kubectl -n openasy get secret openasy-infra-token -o jsonpath='{.data.token}' | base64 -d
```

The token is stored encrypted and never returned by the API.

## Roles

Viewers see everything; editors also start collections; admins also add and remove agents, hosts and clusters, accept
host keys, and manage members and API tokens (ADR 0003).

## Upgrade

### To 0.2.0

- The sign-in variables lose the `INFRA_` prefix and have the same names in every product (ADR 0002):
  `INFRA_OIDC_ISSUER` is now `OPENASY_OIDC_ISSUER`, and so on for every `INFRA_OIDC_*`. The old names still work, with
  a warning in the log, and go in a later release: rename them.
- Upgrade infra-agent to the same version.

## Develop

```bash
npm install
npm test               # unit and contract tests, with facts infra-agent parsed on real hosts (server/fixtures)
KIND_CLUSTER=x e2e/run.sh   # infra and infra-agent (../infra-agent) against real sshd hosts, a jump host, Docker and kind
node scripts/openapi.ts     # after changing the API: rewrites openapi.json
```

## Licence

AGPL-3.0 (ADR 0008).

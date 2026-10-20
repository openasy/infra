#!/bin/sh
# OPENASY_CA: the CA public key line from Infrastructure. OPENASY_SUDOERS: its sudoers file, optional.
# OPENASY_KEY: a fixed public key for the key mode, optional. OPENASY_JUMP: act as a jump host.
set -e
ssh-keygen -A >/dev/null
printf '%s\n' "${OPENASY_CA:-}" > /etc/ssh/openasy_ca.pub
if [ -n "${OPENASY_SUDOERS:-}" ]; then printf '%s\n' "$OPENASY_SUDOERS" > /etc/sudoers.d/openasy && chmod 440 /etc/sudoers.d/openasy && visudo -cf /etc/sudoers.d/openasy; fi
if [ -n "${OPENASY_KEY:-}" ]; then mkdir -p /home/openasy/.ssh && printf '%s\n' "$OPENASY_KEY" > /home/openasy/.ssh/authorized_keys && chown -R openasy /home/openasy/.ssh; fi
if [ -n "${OPENASY_DOCKER:-}" ] && [ -S /var/run/docker.sock ]; then groupadd -g "$(stat -c %g /var/run/docker.sock)" -o dockerhost && usermod -aG dockerhost openasy; fi
# A jump host forwards connections for the openasy account, and only for it (see Setup).
if [ -n "${OPENASY_JUMP:-}" ]; then sed -i 's/  AllowTcpForwarding no/  AllowTcpForwarding yes/' /etc/ssh/sshd_config.d/openasy.conf; fi
# A service that listens, for the inventory to find.
python3 -m http.server 8088 --bind 0.0.0.0 >/dev/null 2>&1 &
exec /usr/sbin/sshd -D -e

# Checks the sudoers file on a host: the read-only commands are allowed, every way out of them is refused.
# Run as root on a host that has /etc/sudoers.d/openasy; e2e/run.ts does this on a real host.
visudo -cf /etc/sudoers.d/openasy >/dev/null || exit 9
t() { c=$(echo "$1" | sed "s|^sudo -n |sudo -n -l |"); if su openasy -s /bin/sh -c "$c" >/dev/null 2>&1; then echo "ALLOWED  $1"; else echo "refused  $1"; fi; }
echo "== must be allowed"
t 'sudo -n ss -H -tulnp'
t 'sudo -n cat /sys/class/dmi/id/product_serial'
t 'sudo -n cat /sys/class/dmi/id/product_uuid'
t 'sudo -n passwd -S -a'
t 'sudo -n cat /etc/sudoers'
t 'sudo -n find /etc/sudoers.d -maxdepth 1 -type f -print -exec cat {} \;'
t 'sudo -n find /root /home -maxdepth 3 -name authorized_keys -type f -print -exec ssh-keygen -lf {} \;'
t 'sudo -n sshd -T'
t 'sudo -n nft list ruleset'
t 'sudo -n iptables-save'
echo "== must be refused"
t 'sudo -n iptables-save -f /tmp/owned'
t 'sudo -n cat /etc/shadow'
t 'sudo -n cat /etc/sudoers /etc/shadow'
t 'sudo -n cat /sys/class/dmi/id/product_uuid /etc/shadow'
t 'sudo -n find /etc/sudoers.d -maxdepth 1 -type f -print -exec cat {} \; -delete'
t 'sudo -n find /etc/sudoers.d -maxdepth 1 -type f -print -exec cat {} \; -exec sh -c id \;'
t 'sudo -n find /root /home -maxdepth 3 -name authorized_keys -type f -print -exec ssh-keygen -lf {} \; -fprint /etc/x'
t 'sudo -n nft list ruleset -f /etc/x'
t 'sudo -n nft flush ruleset'
t 'sudo -n sshd -T -f /tmp/x'
t 'sudo -n passwd -S -a root'
t 'sudo -n ls -1 /var/spool/cron/crontabs /root'
t 'sudo -n sh'

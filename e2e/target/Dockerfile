# A host as Infrastructure expects to find it (ADR 0031): sshd trusts the product's CA for the openasy account only.
# Used by the end-to-end test; the setup steps mirror what the Setup page tells admins to do.
FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server sudo procps iproute2 nftables cron python3 docker-cli \
  && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd /etc/ssh/principals
RUN useradd --create-home --shell /bin/sh openasy && passwd -l openasy \
  && echo openasy > /etc/ssh/principals/openasy \
  && useradd --create-home --shell /bin/bash dana && mkdir -p /home/dana/.ssh \
  && ssh-keygen -q -t ed25519 -N '' -C dana@laptop -f /tmp/dana && cp /tmp/dana.pub /home/dana/.ssh/authorized_keys && rm /tmp/dana* \
  && chown -R dana:dana /home/dana/.ssh \
  && echo '17 3 * * * root /usr/bin/true nightly-report' > /etc/cron.d/report \
  && echo 'dana ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart nginx' > /etc/sudoers.d/dana && chmod 440 /etc/sudoers.d/dana
COPY sshd_config.d/openasy.conf /etc/ssh/sshd_config.d/openasy.conf
COPY entrypoint.sh /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]

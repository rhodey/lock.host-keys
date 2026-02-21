#!/bin/sh
set -e

# net
if [[ "${PROD}" == "true" ]]; then
  ifconfig lo up
  ip route add 0.0.0.0/0 dev lo
fi

# net
iptables -A OUTPUT -t nat -p udp --dport 53 -j DNAT --to-destination 127.0.0.1:53
iptables -A OUTPUT -t nat -p tcp --dport 1:65535 ! -d 127.0.0.1 -j DNAT --to-destination 127.0.0.1:9000
iptables -t nat -A POSTROUTING -o lo -s 0.0.0.0 -j SNAT --to-source 127.0.0.1

# clock
if [[ "${PROD}" == "true" ]]; then
  cat /sys/devices/system/clocksource/clocksource0/current_clocksource
  [ "$(cat /sys/devices/system/clocksource/clocksource0/current_clocksource)" = "kvm-clock" ] || exit 1
fi

# tpm (for client side of attest flow)
mkdir /tmp/mytpm1
swtpm socket --tpmstate dir=/tmp/mytpm1 --tpm2 --ctrl type=tcp,port=2322 --server type=tcp,port=2321 --flags not-need-init,startup-clear &
export TPM2TOOLS_TCTI="swtpm:host=localhost,port=2321"

# vsock (for test flow)
chown -f root /tmp/write || true

# override /.well-known/lockhost
export LH_SESSION_PATH="/api/k/v1"

# start
cd /runtime
node runtime.js 8870 8872 8874 8880 8882 node /app/app.js 8871 8873 8875 8881 8883

#!/bin/sh
set -e

if [[ "${PROD}" != "true" ]]; then
  # mock tpm
  mkdir -p /tmp/swtpm
  swtpm socket --tpmstate dir=/tmp/swtpm --tpm2 --ctrl type=tcp,port=2322 --server type=tcp,port=2321 --flags not-need-init,startup-clear &

  # abrmd is needed because swtpm has tiny mem
  mkdir -p /run/dbus
  dbus-daemon --system --nofork --nopidfile --address=unix:path=/run/dbus/system_bus_socket &
  tpm2-abrmd --allow-root --flush-all --logger=stdout --tcti="swtpm:host=127.0.0.1,port=2321" &
  export TPM2TOOLS_TCTI="tabrmd:bus_name=com.intel.tss2.Tabrmd,bus_type=system"

  # abrmd is needed to be bypassed in one place
  export TPM2TOOLS_TCTI_FIX="swtpm:host=localhost,port=2321"

  # mock tpm ready
  count=0
  until timeout 0.2 tpm2_pcrread > /dev/null 2>&1
  do
    sleep 0.2
    count=$((count + 200))
    if [ "$count" -gt "2500" ]; then
      printf "\ntpm (abrmd) fail (happens with !prod often)\n"
      printf "try again (restart) maybe this is fixed some day\n" && exit 1
    fi
  done

  # mock vsock
  chown -f root /tmp/write || true

  # computed at test time
  echo "APP_PCR = $APP_PCR"
else
  # prod
  export APP_PCR="1111111111111111111111111111111111111111111111111111111111111111"
  echo "APP_PCR = $APP_PCR"

  # prod
  ipv4=`curl -4 https://ifconfig.me`
  export host_id=$ipv4
fi

# override /.well-known/lockhost
export LH_SESSION_PATH="/api/k/v1"

# start
node khost.js 8870 8872 8874 8880 8882

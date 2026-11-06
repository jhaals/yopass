#!/bin/sh
# Starts a Redis primary, a replica and three Sentinels on 127.0.0.1 for the
# Sentinel tests, then prints the URL to export as SENTINEL_URL. The Sentinels
# and the Redis nodes have separate passwords, as in a typical deployment.
#
#   tests/sentinel.sh /tmp/yopass-sentinel     # start
#   tests/sentinel.sh /tmp/yopass-sentinel stop
set -eu
dir=${1:?usage: sentinel.sh DIR [stop]}
server=${REDIS_SERVER:-redis-server}
primary=16400
replica=16401
sentinels="16410 16411 16412"

if [ "${2:-}" = stop ]; then
  for port in $primary $replica $sentinels; do
    [ -f "$dir/$port.pid" ] && kill "$(cat "$dir/$port.pid")" 2>/dev/null || true
  done
  exit 0
fi

mkdir -p "$dir"
for port in $primary $replica; do
  cat > "$dir/$port.conf" <<CONF
port $port
bind 127.0.0.1
daemonize yes
pidfile $dir/$port.pid
dir $dir
dbfilename $port.rdb
save ""
requirepass redis-pw
masterauth redis-pw
CONF
done
echo "replicaof 127.0.0.1 $primary" >> "$dir/$replica.conf"
"$server" "$dir/$primary.conf"
"$server" "$dir/$replica.conf"

for port in $sentinels; do
  cat > "$dir/$port.conf" <<CONF
port $port
bind 127.0.0.1
daemonize yes
pidfile $dir/$port.pid
dir $dir
requirepass sentinel-pw
sentinel monitor mymaster 127.0.0.1 $primary 2
sentinel auth-pass mymaster redis-pw
sentinel down-after-milliseconds mymaster 1000
sentinel failover-timeout mymaster 5000
CONF
  "$server" "$dir/$port.conf" --sentinel
done

echo "redis://:sentinel-pw@127.0.0.1:16410/0?master_name=mymaster&addr=127.0.0.1:16411&addr=127.0.0.1:16412&password=redis-pw"

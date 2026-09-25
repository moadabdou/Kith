#!/usr/bin/env bash
# Phase 2 cliff-hunt sampler (Issue #88 Step 3).
# Samples remote BEAM internals + box state every 2s while the army runs:
# run-queue totals, top message queues, close-code series.
# Output: TSV for post-run analysis.
#
# Usage: ./sample_cliff.sh <out.tsv>  (runs until killed)
set -u
OUT="${1:-/tmp/cliff_sample.tsv}"
COOKIE="${ERLANG_COOKIE:-dev-cluster-cookie}"

IP1=$(docker inspect kith-gateway-1 --format '{{.NetworkSettings.Networks.kith_default.IPAddress}}')
IP2=$(docker inspect kith-gateway-2-1 --format '{{.NetworkSettings.Networks.kith_default.IPAddress}}')

# Stage the remote probe inside both gateway containers (App code is
# available there; distribution uses the shared cookie).
docker cp scripts/bench/remote_probe_file.exs kith-gateway-1:/tmp/rp_file.exs 2>/dev/null || true
docker cp scripts/bench/remote_probe_file.exs kith-gateway-2-1:/tmp/rp_file.exs 2>/dev/null || true

echo -e "ts\tnode\tconns\tsessions\trun_queue\ttop_queues\tclose1000\tsys_load1" > "$OUT"

# Remote one-shot BEAM introspection via an ephemeral distributed node.
# Prints: run_queue_total=N / top_queues=[...] / procs=N
beam_probe() {
  local self_ip="$1" target_ip="$2"
  docker exec "$3" elixir \
    --name "cliffprobe@${self_ip}" \
    --cookie "${COOKIE}" \
    -e "
Node.start(:\"cliffprobe@${self_ip}\");
Node.set_cookie(String.to_atom(\"${COOKIE}\"));
target = :\"gateway@${target_ip}\";
if Node.connect(target) do
  rqs = :rpc.call(target, :erlang, :statistics, [:run_queue_lengths]);
  IO.puts(\"RQ=\" <> inspect(if is_list(rqs), do: Enum.sum(rqs), else: -1));
  procs = :rpc.call(target, Process, :list, []);
  top = if is_list(procs) do
    proms = Enum.map(procs, &:rpc.call(target, Process, :info, [&1, :message_queue_len]));
    proms |> Enum.filter(fn
      {:message_queue_len, l} when l > 0 -> true
      _ -> false
    end) |> Enum.map(fn {:message_queue_len, l} -> l end) |> Enum.sort(:desc) |> Enum.take(5)
  else
    [:rpc_failed]
  end;
  IO.puts(\"Q=\" <> inspect(top));
else
  IO.puts(\"RQ=noconn\"); IO.puts(\"Q=noconn\");
end
System.halt(0)" 2>/dev/null
}

while true; do
  TS=$(date +%s)
  LOAD=$(cut -d' ' -f1 /proc/loadavg)
  for i in 0 1; do
    if [ "$i" -eq 0 ]; then C=kith-gateway-1; IP=$IP1; PORT=4000; else C=kith-gateway-2-1; IP=$IP2; PORT=4001; fi
    M=$(docker exec "$C" wget -q -O - http://127.0.0.1:4000/metrics 2>/dev/null)
    CONNS=$(echo "$M" | grep -E '^gateway_connections_active ' | awk '{print $2}')
    SESS=$(echo "$M" | grep -E '^gateway_sessions_active ' | awk '{print $2}')
    C1000=$(echo "$M" | grep -E '^gateway_ws_close_codes_total\{code="1000"\}' | awk '{print $2}')
    PROBE=$(beam_probe "$IP" "$IP" "$C" | tr '\n' '|')
    RQ=$(echo "$PROBE" | grep -oE 'RQ=[0-9]+|RQ=[a-z]+' | head -n 1 | cut -d= -f2)
    TQ=$(echo "$PROBE" | grep -oE 'Q=\[[^]]*\]|Q=[a-z]+' | head -n 1 | cut -d= -f2-)
    echo -e "${TS}\tgw$((i + 1))\t${CONNS:-?}\t${SESS:-?}\t${RQ:-?}\t${TQ:-?}\t${C1000:-?}\t${LOAD}" >> "$OUT"
  done
  sleep 2
done

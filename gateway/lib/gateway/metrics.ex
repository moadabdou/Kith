defmodule Gateway.Metrics do
  # Lock-free counters (Issue #88 Step 4): this module used to be a plain
  # Agent, and every increment / histogram sample was a synchronous call
  # into that one process. Past ~100k updates/s (each fan-out delivery
  # records two) its mailbox became the gateway-wide funnel: the NATS
  # consumer blocked behind it, backlog crossed the 30s AckWait, and
  # redelivery storms followed — while actors sat idle.
  #
  # Storage is now a public ETS table with :write_concurrency: updates are
  # atomic CPU ops with no process, no mailbox, nobody waits. The Agent
  # remains only as the table owner (supervision tree unchanged); no
  # traffic goes through it. Public API and /metrics output are identical
  # (histogram sums kept as integer microseconds, rendered back to
  # seconds). Gauge floors (max(0, …)) moved to the readers.
  use Agent

  @table __MODULE__

  def start_link(_opts) do
    Agent.start_link(fn ->
      case :ets.whereis(@table) do
        :undefined ->
          :ets.new(@table, [:named_table, :public, :set, write_concurrency: true])

        _ ->
          @table
      end

      :ets.insert(@table, {{:sys, :booted_at}, System.monotonic_time(:native)})
      :ok
    end, name: __MODULE__)
  end

  # ── lock-free primitives (no process, callers never wait) ──

  defp bump(field, by \\ 1) when is_atom(field) and is_integer(by) do
    :ets.update_counter(@table, {:c, field}, {2, by}, {{:c, field}, 0})
    :ok
  end

  defp bump_label(field, label, by \\ 1) when is_atom(field) and is_integer(by) do
    :ets.update_counter(@table, {:c, field, label}, {2, by}, {{:c, field, label}, 0})
    :ok
  end

  defp drop_gauge(field, by \\ 1) when is_atom(field) and is_integer(by) do
    :ets.update_counter(@table, {:c, field}, {2, -by}, {{:c, field}, 0})
    :ok
  end

  defp put_gauge(field, value) when is_atom(field) do
    :ets.insert(@table, {{:c, field}, value})
    :ok
  end

  defp get_counter(field, default \\ 0) when is_atom(field) do
    case :ets.lookup(@table, {:c, field}) do
      [{_, v}] -> v
      [] -> default
    end
  end

  defp get_gauge(field, default \\ 0) when is_atom(field) do
    case :ets.lookup(@table, {:c, field}) do
      [{_, v}] when is_number(v) -> max(v, 0)
      _ -> default
    end
  end

  defp get_labeled(field) when is_atom(field) do
    :ets.match(@table, {{:c, field, :"$1"}, :"$2"})
    |> Map.new(fn [k, v] -> {k, v} end)
  end

  defp record_hist(field, buckets, value, micros?)
       when is_atom(field) and is_list(buckets) and is_number(value) do
    sum_incr = if micros?, do: round(value * 1_000_000), else: value
    :ets.update_counter(@table, {:h, field, :count}, {2, 1}, {{:h, field, :count}, 0})
    :ets.update_counter(@table, {:h, field, :sum}, {2, sum_incr}, {{:h, field, :sum}, 0})

    for b <- buckets, value <= b do
      :ets.update_counter(@table, {:h, field, b}, {2, 1}, {{:h, field, b}, 0})
    end

    :ok
  end

  # Rebuilds the render-state map from ETS (same shape as init/0, which
  # stays as the template with defaults for anything never written).
  defp snapshot do
    :ets.foldl(&fold_entry/2, init(), @table)
  end

  defp fold_entry({{:c, field}, v}, acc) when is_atom(field) do
    if Map.has_key?(acc, field), do: Map.put(acc, field, v), else: acc
  end

  defp fold_entry({{:c, field, label}, v}, acc) when is_atom(field) do
    case Map.fetch(acc, field) do
      {:ok, m} when is_map(m) -> Map.put(acc, field, Map.put(m, label, v))
      _ -> acc
    end
  end

  defp fold_entry({{:h, field, :count}, v}, acc) do
    put_hist(acc, field, {:count, v})
  end

  defp fold_entry({{:h, :fanout_latency, :sum}, v}, acc) do
    put_hist(acc, :fanout_latency, {:sum, v / 1_000_000})
  end

  defp fold_entry({{:h, field, :sum}, v}, acc) do
    put_hist(acc, field, {:sum, v})
  end

  defp fold_entry({{:h, field, b}, v}, acc) when is_number(b) do
    put_hist(acc, field, {:bucket, b, v})
  end

  defp fold_entry({{:sys, :booted_at}, v}, acc) do
    Map.put(acc, :booted_at, v)
  end

  defp fold_entry(_, acc), do: acc

  defp put_hist(acc, field, part) do
    case Map.fetch(acc, field) do
      {:ok, hist} when is_map(hist) ->
        hist =
          case part do
            {:count, v} -> %{hist | count: v}
            {:sum, s} -> %{hist | sum: s}
            {:bucket, b, v} -> %{hist | buckets: Map.put(hist.buckets, b, v)}
          end

        Map.put(acc, field, hist)

      _ ->
        acc
    end
  end

  def incr_request(method, route) do
    bump_label(:requests, {method, route})
  end

  def child_started(child) do
    bump_label(:child_starts, Gateway.Application.child_label(child))
  end

  def incr_event_consumed do
    bump(:events_consumed)
  end

  def incr_event_redelivered do
    bump(:event_redeliveries)
  end

  def set_consumer_lag(lag) when is_integer(lag) do
    put_gauge(:consumer_lag, lag)
  end

  def incr_connection do
    bump(:connections_active)
  end

  def decr_connection do
    drop_gauge(:connections_active)
  end

  def incr_identify do
    bump(:identifies)
  end

  def incr_resume do
    bump(:resumes)
  end

  def incr_typing_broadcast do
    bump(:typing_broadcasts)
  end

  def incr_members_request do
    bump(:members_requests)
  end

  def incr_members_chunk do
    bump(:members_chunks)
  end

  def get_resumes do
    get_counter(:resumes)
  end

  def incr_close_code(code) do
    bump_label(:close_codes, to_string(code))
  end

  def incr_guild_actor do
    bump(:guild_actors_active)
  end

  def decr_guild_actor do
    drop_gauge(:guild_actors_active)
  end

  def get_guild_actors_active do
    get_gauge(:guild_actors_active)
  end

  def incr_session do
    bump(:sessions_active)
  end

  def decr_session do
    drop_gauge(:sessions_active)
  end

  def get_sessions_active do
    get_gauge(:sessions_active)
  end

  def incr_slow_consumer_drop do
    bump(:slow_consumer_drops)
  end

  # Phase 7c (Issue #86): clustering counters.
  def incr_dedup_drop do
    bump(:dedup_drops)
  end

  def incr_lease_drop do
    bump(:lease_drops)
  end

  def incr_lease_acquired do
    bump(:lease_acquired)
  end

  def incr_lease_lost do
    bump(:lease_lost)
  end

  def incr_resubscribe do
    bump(:resubscribes)
  end

  # Phase 7d (Issue #87): SFU liveness transitions, by direction.
  def incr_sfu_flip(direction) when direction in ["up", "down"] do
    bump_label(:sfu_flips, direction)
  end

  def get_sfu_flips do
    flips = get_labeled(:sfu_flips)
    %{"up" => Map.get(flips, "up", 0), "down" => Map.get(flips, "down", 0)}
  end

  # Phase 7d Step 4: voice sessions moved off a dead SFU (null-then-reallocate).
  def incr_sfu_failover(count \\ 1) do
    bump(:sfu_failovers, count)
  end

  def get_sfu_failovers do
    get_counter(:sfu_failovers)
  end

  # Phase 7d Step 5c (Tier 1): session-cached intent applies + guarded drops.
  def incr_voice_intent_apply do
    bump(:voice_intent_applies)
  end

  def incr_voice_intent_drop(reason) when is_binary(reason) do
    bump_label(:voice_intent_drops, reason)
  end

  # Phase 7d Step 6a: demand-path confirmations that excluded a dead
  # candidate for the answerer.
  def incr_voice_placement_exclusion do
    bump(:voice_placement_exclusions)
  end

  # Phase 7d Step 4 diagnosis: local actors notified per liveness transition.
  def incr_sfu_notify(count) do
    bump(:sfu_notifies, count)
  end

  # Phase 7c cache-warm fix: counts actual Postgres loads (not hits), by
  # key type. The rate of these IS the cross-node miss rate.
  def incr_cache_warm(kind) when is_binary(kind) do
    bump_label(:cache_warms, kind)
  end

  def get_slow_consumer_drops do
    get_counter(:slow_consumer_drops)
  end

  def incr_voice_state_update do
    bump(:voice_state_updates)
  end

  def incr_voice_server_update do
    bump(:voice_server_updates)
  end

  def incr_voice_connection do
    bump(:voice_connections_active)
  end

  def decr_voice_connection(count \\ 1) do
    drop_gauge(:voice_connections_active, count)
  end

  def get_voice_connections_active do
    get_gauge(:voice_connections_active)
  end

  def get_voice_state_updates do
    get_counter(:voice_state_updates)
  end

  def get_voice_server_updates do
    get_counter(:voice_server_updates)
  end

  @fanout_buckets [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]

  def record_fanout_latency(seconds) when is_number(seconds) do
    record_hist(:fanout_latency, @fanout_buckets, seconds, true)
  end

  @queue_buckets [0, 1, 5, 10, 50, 100, 250, 500, 1000, 2048]

  def record_send_queue_depth(depth) when is_integer(depth) do
    record_hist(:send_queue_depth, @queue_buckets, depth, false)
  end

  @resume_replay_buckets [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000]

  def record_resume_replay_size(count) when is_integer(count) do
    record_hist(:resume_replay_size, @resume_replay_buckets, count, false)
  end

  def render do
    state = snapshot()

    request_lines =
      counter_lines("gateway_http_requests_total", state.requests, fn {method, route} ->
        ~s({method="#{method}",route="#{route}"})
      end)

    child_start_lines =
      counter_lines("gateway_supervisor_child_starts_total", state.child_starts, fn child ->
        ~s({child="#{child}"})
      end)

    close_code_lines =
      counter_lines("gateway_ws_close_codes_total", state.close_codes, fn code ->
        ~s({code="#{code}"})
      end)

    ready = if Gateway.Health.ready?(), do: 1, else: 0

    lines =
      ["# HELP gateway_http_requests_total HTTP requests served, by method and route.",
       "# TYPE gateway_http_requests_total counter" | request_lines] ++
        [
          "# HELP gateway_supervisor_child_starts_total Supervisor child starts; above 1 per child indicates restarts.",
          "# TYPE gateway_supervisor_child_starts_total counter" | child_start_lines
        ] ++
        [
          "# HELP gateway_ready 1 when every supervised child is running, else 0.",
          "# TYPE gateway_ready gauge",
          "gateway_ready #{ready}",
          "# HELP gateway_uptime_seconds Seconds since the metrics agent last (re)started.",
          "# TYPE gateway_uptime_seconds gauge",
          "gateway_uptime_seconds #{uptime(state)}",
          "# HELP gateway_connections_active Active WebSocket connections.",
          "# TYPE gateway_connections_active gauge",
          "gateway_connections_active #{state.connections_active}",
          "# HELP gateway_sessions_active Active session actor processes.",
          "# TYPE gateway_sessions_active gauge",
          "gateway_sessions_active #{state.sessions_active}",
          "# HELP gateway_guild_actors_active Active guild actor processes.",
          "# TYPE gateway_guild_actors_active gauge",
          "gateway_guild_actors_active #{state.guild_actors_active}",
          "# HELP gateway_slow_consumer_drops_total Total connections dropped due to excessive outbound queue backlog.",
          "# TYPE gateway_slow_consumer_drops_total counter",
          "gateway_slow_consumer_drops_total #{state.slow_consumer_drops}",
          "# HELP gateway_guild_dedup_drops_total Mirror bus events dropped before dispatch: non-host copies (local-only dispatch) + stream-seq duplicates (split-brain/handover safety net).",
          "# TYPE gateway_guild_dedup_drops_total counter",
          "gateway_guild_dedup_drops_total #{state.dedup_drops}",
          "# HELP gateway_guild_lease_drops_total Events dropped because this actor does not hold the guild lease (Phase 7c).",
          "# TYPE gateway_guild_lease_drops_total counter",
          "gateway_guild_lease_drops_total #{state.lease_drops}",
          "# HELP gateway_guild_lease_acquisitions_total Guild lease acquisitions (Phase 7c).",
          "# TYPE gateway_guild_lease_acquisitions_total counter",
          "gateway_guild_lease_acquisitions_total #{state.lease_acquired}",
          "# HELP gateway_guild_lease_losses_total Guild lease losses (renewal failed or taken elsewhere) (Phase 7c).",
          "# TYPE gateway_guild_lease_losses_total counter",
          "gateway_guild_lease_losses_total #{state.lease_lost}",
          "# HELP gateway_session_resubscribes_total Sessions re-subscribed to a restarted guild actor (Phase 7c).",
          "# TYPE gateway_session_resubscribes_total counter",
          "gateway_session_resubscribes_total #{state.resubscribes}",
          "# HELP gateway_sfu_flips_total SFU liveness transitions observed by the health poller (Phase 7d).",
          "# TYPE gateway_sfu_flips_total counter"] ++
          sfu_flip_lines(state.sfu_flips) ++ [
          "# HELP gateway_sfu_failovers_total Voice sessions moved off a dead SFU via null-then-reallocate (Phase 7d).",
          "# TYPE gateway_sfu_failovers_total counter",
          "gateway_sfu_failovers_total #{state.sfu_failovers}",
          "# HELP gateway_voice_intent_applies_total Session-cached voice intents applied on resubscribe/push (Phase 7d Tier 1).",
          "# TYPE gateway_voice_intent_applies_total counter",
          "gateway_voice_intent_applies_total #{state.voice_intent_applies}",
          "# HELP gateway_voice_intent_drops_total Session-cached voice intents dropped by guard reason (Phase 7d Tier 1).",
          "# TYPE gateway_voice_intent_drops_total counter"] ++
          voice_intent_drop_lines(state.voice_intent_drops) ++ [
          "# HELP gateway_voice_placement_exclusions_total Demand-path confirmations that excluded a dead candidate (Phase 7d Step 6a).",
          "# TYPE gateway_voice_placement_exclusions_total counter",
          "gateway_voice_placement_exclusions_total #{state.voice_placement_exclusions}",
          "# HELP gateway_sfu_notifies_total Local guild actors notified per SFU liveness transition (Phase 7d Step 4 diagnosis).",
          "# TYPE gateway_sfu_notifies_total counter",
          "gateway_sfu_notifies_total #{state.sfu_notifies}"] ++ [
          "# HELP gateway_cache_warms_total Postgres loads on cache miss by key type (Phase 7c warm-on-miss).",
          "# TYPE gateway_cache_warms_total counter"] ++
          cache_warm_lines(state.cache_warms) ++ [
          "# HELP gateway_identifies_total Total IDENTIFY payloads received.",
          "# TYPE gateway_identifies_total counter",
          "gateway_identifies_total #{state.identifies}",
           "# HELP gateway_resumes_total Total RESUME payloads processed successfully.",
           "# TYPE gateway_resumes_total counter",
           "gateway_resumes_total #{state.resumes}",
           "# HELP gateway_typing_broadcasts_total Total TYPING_START events dispatched to guild subscribers.",
           "# TYPE gateway_typing_broadcasts_total counter",
           "gateway_typing_broadcasts_total #{state.typing_broadcasts}",
           "# HELP gateway_members_requests_total Total Opcode 8 REQUEST_GUILD_MEMBERS payloads accepted for streaming.",
           "# TYPE gateway_members_requests_total counter",
           "gateway_members_requests_total #{state.members_requests}",
           "# HELP gateway_members_chunks_total Total GUILD_MEMBERS_CHUNK events streamed to requesting sessions.",
           "# TYPE gateway_members_chunks_total counter",
           "gateway_members_chunks_total #{state.members_chunks}",
           "# HELP gateway_voice_connections_active Active voice channel connections across all guilds.",
           "# TYPE gateway_voice_connections_active gauge",
           "gateway_voice_connections_active #{state.voice_connections_active}",
           "# HELP gateway_voice_state_updates_total Total Opcode 4 VOICE_STATE_UPDATE payloads processed.",
           "# TYPE gateway_voice_state_updates_total counter",
           "gateway_voice_state_updates_total #{state.voice_state_updates}",
           "# HELP gateway_voice_server_updates_total Total VOICE_SERVER_UPDATE events dispatched to clients.",
           "# TYPE gateway_voice_server_updates_total counter",
           "gateway_voice_server_updates_total #{state.voice_server_updates}",
          "# HELP gateway_events_consumed_total Total events consumed and acknowledged from event bus.",
          "# TYPE gateway_events_consumed_total counter",
          "gateway_events_consumed_total #{state.events_consumed}",
          "# HELP gateway_event_redeliveries_total Total unacknowledged events redelivered from PEL.",
          "# TYPE gateway_event_redeliveries_total counter",
          "gateway_event_redeliveries_total #{state.event_redeliveries}",
          "# HELP gateway_consumer_lag Current unread or pending event lag across streams.",
          "# TYPE gateway_consumer_lag gauge",
          "gateway_consumer_lag #{state.consumer_lag}"
        ] ++
        histogram_lines(
          "gateway_fanout_latency_seconds",
          "Fan-out latency from bus consumption to socket write in seconds.",
          @fanout_buckets,
          state.fanout_latency
        ) ++
        histogram_lines(
          "gateway_ws_send_queue_depth",
          "Outbound WebSocket connection send queue depth histogram.",
          @queue_buckets,
          state.send_queue_depth
        ) ++
        histogram_lines(
          "gateway_resume_replay_size",
          "Number of replayed events during a successful RESUME.",
          @resume_replay_buckets,
          state.resume_replay_size
        ) ++
        [
          "# HELP gateway_ws_close_codes_total WebSocket close codes recorded.",
          "# TYPE gateway_ws_close_codes_total counter" | close_code_lines
        ] ++
        [
          "# HELP gateway_erlang_processes Number of BEAM processes.",
          "# TYPE gateway_erlang_processes gauge",
          "gateway_erlang_processes #{:erlang.system_info(:process_count)}",
          "# HELP gateway_erlang_memory_bytes Total BEAM memory in bytes.",
          "# TYPE gateway_erlang_memory_bytes gauge",
          "gateway_erlang_memory_bytes{kind=\"total\"} #{:erlang.memory(:total)}"
        ]

    Enum.join(lines, "\n") <> "\n"
  end

  defp histogram_lines(name, help, buckets, %{sum: sum, count: count, buckets: counts}) do
    bucket_lines =
      Enum.map(buckets, fn b ->
        val = Map.get(counts, b, 0)
        ~s(#{name}_bucket{le="#{b}"} #{val})
      end) ++ [~s(#{name}_bucket{le="+Inf"} #{count})]

    [
      "# HELP #{name} #{help}",
      "# TYPE #{name} histogram"
      | bucket_lines
    ] ++ [
      "#{name}_sum #{sum}",
      "#{name}_count #{count}"
    ]
  end

  defp counter_lines(name, counts, labeler) do
    counts
    |> Enum.map(fn {key, value} -> {labeler.(key), value} end)
    |> Enum.sort()
    |> Enum.map(fn {label, value} -> "#{name}#{label} #{value}" end)
  end

  defp cache_warm_lines(warms) do
    warms
    |> Enum.sort()
    |> Enum.map(fn {kind, count} -> "gateway_cache_warms_total{kind=\"#{kind}\"} #{count}" end)
  end

  defp sfu_flip_lines(flips) do
    flips
    |> Enum.sort()
    |> Enum.map(fn {direction, count} -> "gateway_sfu_flips_total{direction=\"#{direction}\"} #{count}" end)
  end

  defp voice_intent_drop_lines(drops) do
    drops
    |> Enum.sort()
    |> Enum.map(fn {reason, count} -> "gateway_voice_intent_drops_total{reason=\"#{reason}\"} #{count}" end)
  end

  defp uptime(state) do
    us = System.convert_time_unit(System.monotonic_time() - state.booted_at, :native, :microsecond)
    Float.round(us / 1_000_000, 3)
  end

  defp init do
    %{
      requests: %{},
      child_starts: %{},
      events_consumed: 0,
      event_redeliveries: 0,
      consumer_lag: 0,
      connections_active: 0,
      sessions_active: 0,
      guild_actors_active: 0,
      slow_consumer_drops: 0,
      dedup_drops: 0,
      lease_drops: 0,
      lease_acquired: 0,
      lease_lost: 0,
      resubscribes: 0,
      # Phase 7d (Issue #87): pre-seeded so gateway_sfu_flips_total exists
      # from boot for the Grafana/alerting series.
      sfu_flips: %{"up" => 0, "down" => 0},
      sfu_failovers: 0,
      voice_intent_applies: 0,
      voice_intent_drops: %{},
      voice_placement_exclusions: 0,
      sfu_notifies: 0,
      # Pre-seeded so the series exists from boot (else the Grafana panel
      # shows "no data" until the first cross-node miss — which is exactly
      # the healthy steady state).
      cache_warms: %{"guild_shape" => 0, "member_roles" => 0},
      identifies: 0,
      resumes: 0,
      typing_broadcasts: 0,
      members_requests: 0,
      members_chunks: 0,
      voice_state_updates: 0,
      voice_server_updates: 0,
      voice_connections_active: 0,
      close_codes: %{},
      fanout_latency: %{sum: 0.0, count: 0, buckets: %{}},
      send_queue_depth: %{sum: 0, count: 0, buckets: %{}},
      resume_replay_size: %{sum: 0, count: 0, buckets: %{}},
      booted_at: System.monotonic_time()
    }
  end
end

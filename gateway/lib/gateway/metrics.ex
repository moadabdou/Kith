defmodule Gateway.Metrics do
  use Agent

  def start_link(_opts) do
    Agent.start_link(fn -> init() end, name: __MODULE__)
  end

  def incr_request(method, route) do
    Agent.update(__MODULE__, fn state ->
      %{state | requests: Map.update(state.requests, {method, route}, 1, &(&1 + 1))}
    end)
  end

  def child_started(child) do
    Agent.update(__MODULE__, fn state ->
      child = Gateway.Application.child_label(child)
      %{state | child_starts: Map.update(state.child_starts, child, 1, &(&1 + 1))}
    end)
  end

  def incr_event_consumed do
    Agent.update(__MODULE__, fn state ->
      %{state | events_consumed: state.events_consumed + 1}
    end)
  end

  def incr_event_redelivered do
    Agent.update(__MODULE__, fn state ->
      %{state | event_redeliveries: state.event_redeliveries + 1}
    end)
  end

  def set_consumer_lag(lag) when is_integer(lag) do
    Agent.update(__MODULE__, fn state ->
      %{state | consumer_lag: lag}
    end)
  end

  def incr_connection do
    Agent.update(__MODULE__, fn state ->
      %{state | connections_active: state.connections_active + 1}
    end)
  end

  def decr_connection do
    Agent.update(__MODULE__, fn state ->
      %{state | connections_active: max(0, state.connections_active - 1)}
    end)
  end

  def incr_identify do
    Agent.update(__MODULE__, fn state ->
      %{state | identifies: state.identifies + 1}
    end)
  end

  def incr_resume do
    Agent.update(__MODULE__, fn state ->
      %{state | resumes: state.resumes + 1}
    end)
  end

  def incr_typing_broadcast do
    Agent.update(__MODULE__, fn state ->
      %{state | typing_broadcasts: state.typing_broadcasts + 1}
    end)
  end

  def incr_members_request do
    Agent.update(__MODULE__, fn state ->
      %{state | members_requests: state.members_requests + 1}
    end)
  end

  def incr_members_chunk do
    Agent.update(__MODULE__, fn state ->
      %{state | members_chunks: state.members_chunks + 1}
    end)
  end

  def get_resumes do
    Agent.get(__MODULE__, fn state -> state.resumes end)
  end

  def incr_close_code(code) do
    code_str = to_string(code)

    Agent.update(__MODULE__, fn state ->
      %{state | close_codes: Map.update(state.close_codes, code_str, 1, &(&1 + 1))}
    end)
  end

  def incr_guild_actor do
    Agent.update(__MODULE__, fn state ->
      %{state | guild_actors_active: state.guild_actors_active + 1}
    end)
  end

  def decr_guild_actor do
    Agent.update(__MODULE__, fn state ->
      %{state | guild_actors_active: max(0, state.guild_actors_active - 1)}
    end)
  end

  def get_guild_actors_active do
    Agent.get(__MODULE__, fn state -> state.guild_actors_active end)
  end

  def incr_session do
    Agent.update(__MODULE__, fn state ->
      %{state | sessions_active: state.sessions_active + 1}
    end)
  end

  def decr_session do
    Agent.update(__MODULE__, fn state ->
      %{state | sessions_active: max(0, state.sessions_active - 1)}
    end)
  end

  def get_sessions_active do
    Agent.get(__MODULE__, fn state -> state.sessions_active end)
  end

  def incr_slow_consumer_drop do
    Agent.update(__MODULE__, fn state ->
      %{state | slow_consumer_drops: state.slow_consumer_drops + 1}
    end)
  end

  def get_slow_consumer_drops do
    Agent.get(__MODULE__, fn state -> state.slow_consumer_drops end)
  end

  @fanout_buckets [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]

  def record_fanout_latency(seconds) when is_number(seconds) do
    Agent.update(__MODULE__, fn state ->
      hist = state.fanout_latency
      new_sum = hist.sum + seconds
      new_count = hist.count + 1

      new_buckets =
        Enum.reduce(@fanout_buckets, hist.buckets, fn b, acc ->
          if seconds <= b do
            Map.update(acc, b, 1, &(&1 + 1))
          else
            acc
          end
        end)

      %{state | fanout_latency: %{hist | sum: new_sum, count: new_count, buckets: new_buckets}}
    end)
  end

  @queue_buckets [0, 1, 5, 10, 50, 100, 250, 500, 1000, 2048]

  def record_send_queue_depth(depth) when is_integer(depth) do
    Agent.update(__MODULE__, fn state ->
      hist = state.send_queue_depth
      new_sum = hist.sum + depth
      new_count = hist.count + 1

      new_buckets =
        Enum.reduce(@queue_buckets, hist.buckets, fn b, acc ->
          if depth <= b do
            Map.update(acc, b, 1, &(&1 + 1))
          else
            acc
          end
        end)

      %{state | send_queue_depth: %{hist | sum: new_sum, count: new_count, buckets: new_buckets}}
    end)
  end

  @resume_replay_buckets [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000]

  def record_resume_replay_size(count) when is_integer(count) do
    Agent.update(__MODULE__, fn state ->
      hist = state.resume_replay_size
      new_sum = hist.sum + count
      new_count = hist.count + 1

      new_buckets =
        Enum.reduce(@resume_replay_buckets, hist.buckets, fn b, acc ->
          if count <= b do
            Map.update(acc, b, 1, &(&1 + 1))
          else
            acc
          end
        end)

      %{state | resume_replay_size: %{hist | sum: new_sum, count: new_count, buckets: new_buckets}}
    end)
  end

  def render do
    state = Agent.get(__MODULE__, & &1)

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
      identifies: 0,
      resumes: 0,
      typing_broadcasts: 0,
      members_requests: 0,
      members_chunks: 0,
      close_codes: %{},
      fanout_latency: %{sum: 0.0, count: 0, buckets: %{}},
      send_queue_depth: %{sum: 0, count: 0, buckets: %{}},
      resume_replay_size: %{sum: 0, count: 0, buckets: %{}},
      booted_at: System.monotonic_time()
    }
  end
end

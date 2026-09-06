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
          "# HELP gateway_erlang_processes Number of BEAM processes.",
          "# TYPE gateway_erlang_processes gauge",
          "gateway_erlang_processes #{:erlang.system_info(:process_count)}",
          "# HELP gateway_erlang_memory_bytes Total BEAM memory in bytes.",
          "# TYPE gateway_erlang_memory_bytes gauge",
          "gateway_erlang_memory_bytes{kind=\"total\"} #{:erlang.memory(:total)}"
        ]

    Enum.join(lines, "\n") <> "\n"
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
    %{requests: %{}, child_starts: %{}, booted_at: System.monotonic_time()}
  end
end

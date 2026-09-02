defmodule Gateway.Metrics do
  use Agent

  def start_link(_opts) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  def incr(method, path) do
    Agent.get_and_update(__MODULE__, fn counts ->
      key = {method, path}
      {counts, Map.update(counts, key, 1, &(&1 + 1))}
    end)
  end

  def render do
    counters =
      Agent.get(__MODULE__, fn counts ->
        Enum.map(counts, fn {{method, path}, value} ->
          "gateway_http_requests_total{method=\"#{method}\",path=\"#{path}\"} #{value}"
        end)
      end)
      |> Enum.sort()

    lines =
      ["# TYPE gateway_http_requests_total counter" | counters] ++
        [
          "# TYPE gateway_erlang_process_count gauge",
          "gateway_erlang_process_count #{:erlang.system_info(:process_count)}",
          "# TYPE gateway_erlang_memory_bytes gauge",
          "gateway_erlang_memory_bytes{kind=\"total\"} #{:erlang.memory(:total)}"
        ]

    Enum.join(lines, "\n") <> "\n"
  end
end

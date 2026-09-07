defmodule Gateway.MetricsTest do
  use ExUnit.Case, async: false

  alias Gateway.Metrics

  test "request counters increment per method and route" do
    Metrics.incr_request("GET", "/probe")
    Metrics.incr_request("GET", "/probe")
    Metrics.incr_request("POST", "/probe")

    out = Metrics.render()

    assert out =~ ~s(gateway_http_requests_total{method="GET",route="/probe"} 2)
    assert out =~ ~s(gateway_http_requests_total{method="POST",route="/probe"} 1)
  end

  test "child_started accumulates per child" do
    Metrics.child_started(ProbeChild)
    Metrics.child_started(ProbeChild)

    assert Metrics.render() =~
             ~s(gateway_supervisor_child_starts_total{child="ProbeChild"} 2)
  end

  test "render emits typed, sorted exposition series" do
    Metrics.incr_request("GET", "/probe-b")
    Metrics.incr_request("GET", "/probe-a")

    out = Metrics.render()

    assert out =~ "# HELP gateway_http_requests_total "
    assert out =~ "# TYPE gateway_http_requests_total counter"
    assert out =~ "# HELP gateway_supervisor_child_starts_total "
    assert out =~ "# TYPE gateway_supervisor_child_starts_total counter"
    assert out =~ "# TYPE gateway_ready gauge\n"
    assert out =~ "gateway_ready 1"
    assert out =~ "# TYPE gateway_uptime_seconds gauge\n"
    assert out =~ ~r/gateway_uptime_seconds \d+(\.\d+)?/
    assert out =~ "gateway_erlang_processes "
    assert out =~ ~s(gateway_erlang_memory_bytes{kind="total"} )

    a_index =
      out |> String.split("\n") |> Enum.find_index(&String.contains?(&1, ~s(route="/probe-a")))

    b_index =
      out |> String.split("\n") |> Enum.find_index(&String.contains?(&1, ~s(route="/probe-b")))

    assert a_index != nil and b_index != nil and a_index < b_index
  end

  test "render lists a series per supervised child" do
    out = Metrics.render()

    for child <- ["Gateway.Metrics", "Gateway.Health", "Gateway.GuildSupervisor", "Gateway.ConnSupervisor"] do
      assert out =~ ~r{gateway_supervisor_child_starts_total\{child="#{child}"\} \d+}
    end
  end

  test "websocket metrics increment and render properly" do
    Metrics.incr_connection()
    Metrics.incr_connection()
    Metrics.decr_connection()

    Metrics.incr_identify()
    Metrics.incr_close_code(4001)
    Metrics.incr_close_code("4004")

    out = Metrics.render()

    assert out =~ "# HELP gateway_connections_active "
    assert out =~ "# TYPE gateway_connections_active gauge"
    assert out =~ "gateway_connections_active 1"

    assert out =~ "# HELP gateway_identifies_total "
    assert out =~ "# TYPE gateway_identifies_total counter"
    assert out =~ "gateway_identifies_total 1"

    assert out =~ "# HELP gateway_ws_close_codes_total "
    assert out =~ "# TYPE gateway_ws_close_codes_total counter"
    assert out =~ ~s(gateway_ws_close_codes_total{code="4001"} 1)
    assert out =~ ~s(gateway_ws_close_codes_total{code="4004"} 1)
  end
end

defmodule Gateway.RouterTest do
  use ExUnit.Case, async: false

  alias Gateway.Test.Wait

  test "GET / returns service info" do
    conn = request("GET", "/")

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["service"] == "gateway"
  end

  test "healthz, readyz and metrics respond" do
    Wait.wait_until(fn -> Gateway.Health.ready?() end)

    conn = request("GET", "/healthz")
    assert conn.status == 200
    assert conn.resp_body == "ok"

    conn = request("GET", "/readyz")
    assert conn.status == 200
    assert conn.resp_body == "ok"

    conn = request("GET", "/metrics")
    assert conn.status == 200
    assert conn.resp_body =~ "# TYPE gateway_http_requests_total counter"
    assert conn.resp_body =~ "gateway_ready 1"
  end

  test "unknown routes get 404 without leaking the path into labels" do
    conn = request("GET", "/nope-#{System.unique_integer()}")

    assert conn.status == 404
    assert Gateway.Metrics.render() =~ "gateway_http_requests_total{"
    refute Gateway.Metrics.render() =~ "nope-"
  end

  test "chaos routes are 404 when disabled" do
    System.put_env("CHAOS_ENABLED", "false")
    on_exit(fn -> System.delete_env("CHAOS_ENABLED") end)

    assert request("POST", "/chaos/kill/health").status == 404
    assert request("GET", "/chaos/children").status == 404
  end

  test "chaos children lists the supervision tree when enabled" do
    with_chaos(fn ->
      conn = request("GET", "/chaos/children")

      assert conn.status == 200

      ids =
        conn.resp_body
        |> Jason.decode!()
        |> get_in(["children"])
        |> Enum.map(& &1["id"])

      assert "Gateway.Metrics" in ids
      assert "Gateway.Health" in ids
    end)
  end

  test "chaos kill restarts the child when enabled" do
    with_chaos(fn ->
      old = Process.whereis(Gateway.Health)
      conn = request("POST", "/chaos/kill/health")

      assert conn.status == 200

      body = Jason.decode!(conn.resp_body)
      assert body["killed"] == "Gateway.Health"
      assert body["pid"] == inspect(old)

      Wait.wait_until(fn ->
        new = Process.whereis(Gateway.Health)
        is_pid(new) and new != old and Gateway.Health.ready?()
      end)
    end)
  end

  defp with_chaos(fun) do
    System.put_env("CHAOS_ENABLED", "true")
    on_exit(fn -> System.delete_env("CHAOS_ENABLED") end)
    fun.()
  end

  defp request(method, path) do
    conn = Plug.Test.conn(method, path)
    Gateway.Router.call(conn, [])
  end
end

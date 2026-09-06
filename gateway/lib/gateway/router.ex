defmodule Gateway.Router do
  use Plug.Router

  alias Gateway.Health
  alias Gateway.Metrics

  plug(Plug.Logger)
  plug(:match)
  plug(:count_request)
  plug(:dispatch)

  get "/" do
    send_json(conn, 200, %{service: "gateway", status: "ok"})
  end

  get "/healthz" do
    send_resp(conn, 200, "ok")
  end

  get "/readyz" do
    if Health.ready?() do
      send_resp(conn, 200, "ok")
    else
      send_resp(conn, 503, "not ready")
    end
  end

  get "/metrics" do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(200, Metrics.render())
  end

  get "/chaos/children" do
    with_chaos(conn, fn ->
      send_json(conn, 200, %{children: children()})
    end)
  end

  post "/chaos/kill/health" do
    with_chaos(conn, fn -> kill(conn, Gateway.Health) end)
  end

  post "/chaos/kill/metrics" do
    with_chaos(conn, fn -> kill(conn, Gateway.Metrics) end)
  end

  match _ do
    send_resp(conn, 404, "not found")
  end

  defp count_request(conn, _opts) do
    Metrics.incr_request(conn.method, route_label(conn))
    conn
  end

  defp route_label(conn) do
    case conn.private[:plug_route] do
      {route, _fun} when is_binary(route) -> route
      _ -> "unmatched"
    end
  end

  defp with_chaos(conn, fun) do
    if chaos_enabled?() do
      fun.()
    else
      send_resp(conn, 404, "not found")
    end
  end

  defp chaos_enabled? do
    System.get_env("CHAOS_ENABLED", "false") == "true"
  end

  defp kill(conn, child) do
    case Process.whereis(child) do
      nil ->
        send_json(conn, 409, %{error: "not running", child: Gateway.Application.child_label(child)})

      pid ->
        response =
          send_json(conn, 200, %{killed: Gateway.Application.child_label(child), pid: inspect(pid)})

        spawn(fn ->
          ref = Process.monitor(pid)
          Process.exit(pid, :kill)

          receive do
            {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
          after
            1_000 -> :ok
          end
        end)

        response
    end
  end

  defp children do
    Gateway.Supervisor
    |> Supervisor.which_children()
    |> Enum.map(fn {id, pid, type, _modules} ->
      %{id: Gateway.Application.child_label(id), pid: describe(pid), type: to_string(type)}
    end)
  end

  defp describe(pid) when is_pid(pid), do: inspect(pid)
  defp describe(other), do: to_string(other)

  defp send_json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(body))
  end
end

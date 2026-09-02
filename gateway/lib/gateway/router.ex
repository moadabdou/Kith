defmodule Gateway.Router do
  use Plug.Router

  alias Gateway.Metrics

  plug(Plug.Logger)
  plug(:count_request)
  plug(:match)
  plug(:dispatch)

  get "/" do
    send_json(conn, 200, %{service: "gateway", status: "ok"})
  end

  get "/healthz" do
    send_resp(conn, 200, "ok")
  end

  get "/readyz" do
    send_resp(conn, 200, "ok")
  end

  get "/metrics" do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(200, Metrics.render())
  end

  match _ do
    send_resp(conn, 404, "not found")
  end

  defp count_request(conn, _opts) do
    Metrics.incr(conn.method, conn.request_path)
    conn
  end

  defp send_json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(body))
  end
end

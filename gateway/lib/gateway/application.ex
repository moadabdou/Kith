defmodule Gateway.Application do
  use Application

  @supervisor Gateway.Supervisor

  @impl true
  def start(_type, _args) do
    Supervisor.start_link(
      Enum.map(children(), &report/1),
      strategy: :rest_for_one,
      max_restarts: 50,
      max_seconds: 5,
      name: @supervisor
    )
  end

  def child_ids do
    children() |> Enum.map(&Supervisor.child_spec(&1, []).id)
  end

  def child_label(id), do: inspect(id)

  def start_and_report(id, {module, fun, args}) do
    case apply(module, fun, args) do
      {:ok, _pid} = ok ->
        Gateway.Metrics.child_started(id)
        ok

      other ->
        other
    end
  end

  defp children do
    [
      Gateway.Metrics,
      Gateway.Health,
      {Registry, keys: :unique, name: Gateway.Registry},
      Gateway.Presence.Store,
      Gateway.GuildSupervisor,
      Gateway.ConnSupervisor,
      Gateway.Guild.Cache,
      Supervisor.child_spec({Postgrex, parse_db_url(database_url())}, id: Gateway.DB),
      Gateway.Presence.Broadcaster,
      Gateway.Typing.RateLimiter,
      bus_consumer(),
      Supervisor.child_spec({Bandit, plug: Gateway.Router, port: port()}, id: Bandit)
    ]
  end

  defp bus_consumer do
    case System.get_env("BUS_TYPE", "nats") do
      "redis" -> Gateway.Bus.Consumer
      _ -> Gateway.Bus.NatsConsumer
    end
  end

  defp report(child) do
    spec = Supervisor.child_spec(child, [])
    %{spec | start: {__MODULE__, :start_and_report, [spec.id, spec.start]}}
  end

  defp database_url do
    System.get_env("DATABASE_URL") ||
      "postgres://discord:discord@127.0.0.1:5432/discord?sslmode=disable"
  end

  defp parse_db_url(url) when is_binary(url) do
    uri = URI.parse(url)

    [username, password] =
      case uri.userinfo do
        nil -> [nil, nil]
        userinfo ->
          case String.split(userinfo, ":") do
            [u, p] -> [u, p]
            [u] -> [u, nil]
          end
      end

    database =
      case uri.path do
        "/" <> db -> db
        db when is_binary(db) and db != "" -> db
        _ -> "discord"
      end

    opts = [
      name: Gateway.DB,
      hostname: uri.host || "127.0.0.1",
      port: uri.port || 5432,
      database: database
    ]

    opts = if username, do: Keyword.put(opts, :username, username), else: opts
    opts = if password, do: Keyword.put(opts, :password, password), else: opts
    opts
  end

  defp port do
    System.get_env("PORT", "4000") |> String.to_integer()
  end
end

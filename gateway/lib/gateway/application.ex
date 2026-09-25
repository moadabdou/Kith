defmodule Gateway.Application do
  use Application

  @supervisor Gateway.Supervisor

  @impl true
  def start(_type, _args) do
    # Phase 7d (Issue #87): :inets for SfuHealth's :httpc /healthz probes.
    # Started explicitly (not via extra_applications) so mix.exs stays
    # untouched and the docker deps layer keeps its cache.
    {:ok, _} = Application.ensure_all_started(:inets)

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
      # Bounded shutdown: a nested supervisor defaults to :infinity, which
      # would wedge the whole tree if a Horde child ever hung in terminate.
      Supervisor.child_spec({Gateway.ClusterFoundation, []}, shutdown: 10_000),
      {Registry, keys: :unique, name: Gateway.Registry},
      {Gateway.Presence.Store, [idle_threshold_ms: idle_threshold_ms()]},
      Gateway.ConnSupervisor,
      Gateway.Guild.Cache,
      Supervisor.child_spec({Postgrex, parse_db_url(database_url())}, id: Gateway.DB),
      Gateway.Presence.Broadcaster,
      Gateway.Typing.RateLimiter,
      bus_consumer(),
      # Phase 7d (Issue #87): out-of-band SFU liveness. Placed after the bus
      # consumer so voice placement has a live list as early as possible, and
      # before TaskSupervisor/Bandit so neither can serve traffic unobserved.
      Gateway.Voice.SfuHealth,
      # Supervised streaming tasks (op 8 GUILD_MEMBERS_CHUNK) — after the bus
      # consumer so a bus restart cannot orphan in-flight streams.
      {Task.Supervisor, name: Gateway.TaskSupervisor},
      Supervisor.child_spec({Bandit, plug: Gateway.Router, port: port()}, id: Bandit)
    ]
  end

  defp bus_consumer do
    case System.get_env("BUS_TYPE", "nats") do
      "redis" -> Gateway.Bus.Consumer
      _ -> Gateway.Bus.NatsConsumer
    end
  end

  # plan/05 §1 specifies a 10-minute idle threshold (Discord parity).
  # PRESENCE_IDLE_THRESHOLD_MS (epoch ms) overrides it for observation/dev
  # stacks — compose sets 120000 so idle transitions are observable in ~2 min.
  @default_idle_threshold_ms 600_000

  defp idle_threshold_ms do
    case System.get_env("PRESENCE_IDLE_THRESHOLD_MS") do
      nil ->
        @default_idle_threshold_ms

      raw ->
        case Integer.parse(raw) do
          {ms, ""} when ms > 0 -> ms
          _ -> @default_idle_threshold_ms
        end
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
      database: database,
      # Issue #88 birth bottleneck: default pool_size is 10; 6 sequential
      # warm queries per IDENTIFY need headroom under birth bursts.
      # Overridable via PG_POOL_SIZE (tests default it lower if needed).
      pool_size: pg_pool_size()
    ]

    opts = if username, do: Keyword.put(opts, :username, username), else: opts
    opts = if password, do: Keyword.put(opts, :password, password), else: opts
    opts
  end

  defp port do
    System.get_env("PORT", "4000") |> String.to_integer()
  end

  defp pg_pool_size do
    case System.get_env("PG_POOL_SIZE") do
      nil -> 50
      raw -> case Integer.parse(raw) do
        {n, ""} when n > 0 -> n
        _ -> 50
      end
    end
  end
end

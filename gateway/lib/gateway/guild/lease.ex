defmodule Gateway.Guild.Lease do
  @moduledoc """
  Per-guild single-dispatcher lease over Redis (Phase 7c, Issue #86).

  Split-brain remedy: when a node is SIGSTOPped (not dead), Horde may run
  two actors for the same guild. Only the lease holder dispatches; the
  other stays silent. `SET key owner NX PX ttl` is atomic (single-threaded
  Redis); the TTL bounds the confusion window when a holder freezes.

  Key: `kith:guild-lease:<guild_id>`, value: node name, TTL 10s by default.
  Actors renew every 3s. On Redis errors the caller decides the fallback
  (actors fail OPEN: availability over perfect silence — see Actor).
  """

  use GenServer
  require Logger

  @default_ttl_ms 10_000
  @reconnect_ms 1_000

  @renew_script """
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  else
    return 0
  end
  """

  @release_script """
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
  """

  # ── Public API ────────────────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Claim the lease. `:ok` | `{:error, :taken | :unavailable}`."
  def acquire(guild_id, owner \\ owner_id(), ttl_ms \\ @default_ttl_ms) do
    with {:ok, conn} <- conn() do
      case Redix.command(conn, ["SET", key(guild_id), owner, "NX", "PX", ttl_ms]) do
        {:ok, "OK"} -> :ok
        {:ok, nil} -> {:error, :taken}
        {:error, err} -> log_and_unavailable("acquire", guild_id, err)
      end
    end
  end

  @doc "Renew an owned lease. `:ok` | `{:error, :lost | :unavailable}`."
  def renew(guild_id, owner \\ owner_id(), ttl_ms \\ @default_ttl_ms) do
    with {:ok, conn} <- conn() do
      case Redix.command(conn, ["EVAL", @renew_script, 1, key(guild_id), owner, ttl_ms]) do
        {:ok, 1} -> :ok
        {:ok, 0} -> {:error, :lost}
        {:error, err} -> log_and_unavailable("renew", guild_id, err)
      end
    end
  end

  @doc "Best-effort release of an owned lease. Always `:ok`."
  def release(guild_id, owner \\ owner_id()) do
    case conn() do
      {:ok, conn} ->
        _ = Redix.command(conn, ["EVAL", @release_script, 1, key(guild_id), owner])
        :ok

      {:error, _} ->
        :ok
    end
  end

  def owner_id, do: to_string(node())
  def key(guild_id), do: "kith:guild-lease:#{guild_id}"

  # ── GenServer (owns the single shared Redix connection) ───────────────

  @impl true
  def init(opts) do
    url =
      Keyword.get(opts, :redis_url) ||
        System.get_env("REDIS_URL") ||
        "redis://127.0.0.1:6379"

    send(self(), :connect)
    {:ok, %{url: url, conn: nil}}
  end

  @impl true
  def handle_call(:conn, _from, %{conn: nil} = state), do: {:reply, {:error, :unavailable}, state}
  def handle_call(:conn, _from, %{conn: conn} = state), do: {:reply, {:ok, conn}, state}

  @impl true
  def handle_info(:connect, %{conn: nil} = state) do
    case Redix.start_link(state.url) do
      {:ok, conn} ->
        Logger.info("Gateway.Guild.Lease connected to Redis at #{state.url}")
        Process.monitor(conn)
        {:noreply, %{state | conn: conn}}

      {:error, reason} ->
        Logger.warning("Gateway.Guild.Lease Redis connect failed (#{inspect(reason)}); retrying in #{@reconnect_ms}ms")
        Process.send_after(self(), :connect, @reconnect_ms)
        {:noreply, state}
    end
  end

  def handle_info(:connect, state), do: {:noreply, state}

  def handle_info({:DOWN, _ref, :process, pid, reason}, %{conn: pid} = state) do
    Logger.warning("Gateway.Guild.Lease Redis connection down (#{inspect(reason)}); reconnecting")
    Process.send_after(self(), :connect, @reconnect_ms)
    {:noreply, %{state | conn: nil}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ── Helpers ───────────────────────────────────────────────────────────

  defp conn do
    case GenServer.whereis(__MODULE__) do
      nil -> {:error, :unavailable}
      _pid -> GenServer.call(__MODULE__, :conn)
    end
  catch
    :exit, _ -> {:error, :unavailable}
  end

  defp log_and_unavailable(op, guild_id, err) do
    Logger.warning("Gateway.Guild.Lease #{op} failed for guild #{guild_id}: #{inspect(err)}")
    {:error, :unavailable}
  end
end

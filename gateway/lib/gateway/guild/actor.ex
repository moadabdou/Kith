defmodule Gateway.Guild.Actor do
  @moduledoc """
  One GenServer per guild (plan/01 §2).
  Owns subscriber connection map, process monitors, and reaps itself after TTL with 0 subscribers.
  """

  use GenServer, restart: :transient
  require Logger

  @default_ttl_ms 300_000 # 5 minutes

  # ── Public API ──────────────────────────────────────────────────────────────

  def start_link(opts) do
    guild_id = Keyword.fetch!(opts, :guild_id) |> to_string()
    GenServer.start_link(__MODULE__, opts, name: via_tuple(guild_id))
  end

  def via_tuple(guild_id) do
    {:via, Registry, {Gateway.Registry, to_string(guild_id)}}
  end

  @doc """
  Finds existing guild actor in Registry or lazily spawns a new one under Gateway.GuildSupervisor.
  """
  def get_or_spawn(guild_id, opts \\ []) do
    gid = to_string(guild_id)

    case whereis(gid) do
      pid when is_pid(pid) ->
        {:ok, pid}

      nil ->
        child_opts = Keyword.merge(opts, [guild_id: gid])

        case DynamicSupervisor.start_child(Gateway.GuildSupervisor, {__MODULE__, child_opts}) do
          {:ok, pid} ->
            {:ok, pid}

          {:error, {:already_started, pid}} ->
            {:ok, pid}

          {:error, reason} ->
            {:error, reason}
        end
    end
  end

  @doc """
  Returns the PID of the guild actor if registered and alive, else nil.
  """
  def whereis(guild_id) do
    case Registry.lookup(Gateway.Registry, to_string(guild_id)) do
      [{pid, _}] ->
        if Process.alive?(pid), do: pid, else: nil

      [] ->
        nil
    end
  end

  @doc """
  Subscribes a connection session to the guild actor.
  """
  def subscribe(guild_id, session_id, pid \\ nil) do
    target_pid = pid || self()

    case get_or_spawn(guild_id) do
      {:ok, actor_pid} ->
        GenServer.call(actor_pid, {:subscribe, session_id, target_pid})

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Unsubscribes a session from the guild actor.
  """
  def unsubscribe(guild_id, session_id) do
    case whereis(guild_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, {:unsubscribe, session_id})

      nil ->
        :ok
    end
  end

  @doc """
  Returns list of `{session_id, pid}` currently subscribed to the guild.
  """
  def subscribers(guild_id) do
    case whereis(guild_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, :subscribers)

      nil ->
        []
    end
  end

  @doc """
  Returns current subscriber count for the guild.
  """
  def subscriber_count(guild_id) do
    case whereis(guild_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, :subscriber_count)

      nil ->
        0
    end
  end

  @doc """
  Dispatches an event asynchronously to all subscriber processes of the guild.
  """
  def dispatch_event(guild_id, event, bus_received_at \\ nil) do
    case whereis(guild_id) do
      pid when is_pid(pid) ->
        GenServer.cast(pid, {:dispatch_event, event, bus_received_at})

      nil ->
        :ok
    end
  end

  # ── GenServer Callbacks ─────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    guild_id = Keyword.fetch!(opts, :guild_id) |> to_string()
    ttl_ms = Keyword.get(opts, :ttl_ms, @default_ttl_ms)

    Gateway.Metrics.incr_guild_actor()

    # Start TTL timer since initial subscriber count is 0
    ttl_timer = Process.send_after(self(), :ttl_check, ttl_ms)

    state = %{
      guild_id: guild_id,
      subscribers: %{},
      subscriber_refs: %{},
      ttl_ms: ttl_ms,
      ttl_timer: ttl_timer
    }

    Logger.debug("Gateway.Guild.Actor [#{guild_id}] started")
    {:ok, state}
  end

  @impl true
  def handle_call({:subscribe, session_id, pid}, _from, state) do
    cancel_timer(state.ttl_timer)

    subscriber_refs =
      case Enum.find(state.subscriber_refs, fn {_ref, sid} -> sid == session_id end) do
        {old_ref, _} ->
          Process.demonitor(old_ref, [:flush])
          Map.delete(state.subscriber_refs, old_ref)

        nil ->
          state.subscriber_refs
      end

    ref = Process.monitor(pid)

    subscribers = Map.put(state.subscribers, session_id, pid)
    subscriber_refs = Map.put(subscriber_refs, ref, session_id)

    {:reply, :ok, %{state | subscribers: subscribers, subscriber_refs: subscriber_refs, ttl_timer: nil}}
  end

  def handle_call({:unsubscribe, session_id}, _from, state) do
    # Demonitor existing ref for this session
    subscriber_refs =
      case Enum.find(state.subscriber_refs, fn {_ref, sid} -> sid == session_id end) do
        {ref, _} ->
          Process.demonitor(ref, [:flush])
          Map.delete(state.subscriber_refs, ref)

        nil ->
          state.subscriber_refs
      end

    subscribers = Map.delete(state.subscribers, session_id)

    ttl_timer =
      if map_size(subscribers) == 0 do
        Process.send_after(self(), :ttl_check, state.ttl_ms)
      else
        nil
      end

    {:reply, :ok, %{state | subscribers: subscribers, subscriber_refs: subscriber_refs, ttl_timer: ttl_timer}}
  end

  def handle_call(:subscribers, _from, state) do
    {:reply, Map.to_list(state.subscribers), state}
  end

  def handle_call(:subscriber_count, _from, state) do
    {:reply, map_size(state.subscribers), state}
  end

  @impl true
  def handle_cast({:dispatch_event, event, bus_received_at}, state) do
    Enum.each(state.subscribers, fn {_session_id, pid} ->
      send(pid, {:dispatch, event, bus_received_at})
    end)

    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Map.pop(state.subscriber_refs, ref) do
      {nil, _refs} ->
        {:noreply, state}

      {session_id, new_refs} ->
        new_subscribers = Map.delete(state.subscribers, session_id)

        ttl_timer =
          if map_size(new_subscribers) == 0 do
            Process.send_after(self(), :ttl_check, state.ttl_ms)
          else
            state.ttl_timer
          end

        {:noreply, %{state | subscribers: new_subscribers, subscriber_refs: new_refs, ttl_timer: ttl_timer}}
    end
  end

  def handle_info(:ttl_check, state) do
    if map_size(state.subscribers) == 0 do
      Logger.debug("Gateway.Guild.Actor [#{state.guild_id}] stopping: 0 subscribers after TTL")
      {:stop, :normal, state}
    else
      {:noreply, %{state | ttl_timer: nil}}
    end
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    Gateway.Metrics.decr_guild_actor()
    cancel_timer(state.ttl_timer)
    Logger.debug("Gateway.Guild.Actor [#{state.guild_id}] terminated")
    :ok
  end

  # ── Internal Helpers ────────────────────────────────────────────────────────

  defp cancel_timer(nil), do: :ok

  defp cancel_timer(timer) when is_reference(timer) do
    if Process.read_timer(timer) do
      Process.cancel_timer(timer)
    end

    :ok
  end
end

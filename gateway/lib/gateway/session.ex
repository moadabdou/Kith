defmodule Gateway.Session do
  @moduledoc """
  Session Actor GenServer (plan/01 §2, §4–6).
  One process per active user session, managed under `Gateway.ConnSupervisor`.
  Owns per-session monotonic sequence numbering (`seq`), replay ring buffer,
  outbound backpressure monitoring, and disconnect TTL timer.
  """

  use GenServer, restart: :transient
  require Logger

  @default_disconnect_ttl_ms 60_000
  @default_max_queue_len 2048

  # ── Public API ──────────────────────────────────────────────────────────────

  def start_link(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    GenServer.start_link(__MODULE__, opts, name: via_tuple(session_id))
  end

  def via_tuple(session_id) do
    {:via, Registry, {Gateway.Registry, "session:#{session_id}"}}
  end

  @doc """
  Finds the Session Actor PID by session_id in Gateway.Registry.
  """
  def whereis(session_id) do
    case Registry.lookup(Gateway.Registry, "session:#{session_id}") do
      [{pid, _}] ->
        if Process.alive?(pid), do: pid, else: nil

      [] ->
        nil
    end
  end

  @doc """
  Spawns or retrieves an existing Session Actor under Gateway.ConnSupervisor.
  """
  def get_or_spawn(opts) do
    session_id = Keyword.fetch!(opts, :session_id)

    case whereis(session_id) do
      pid when is_pid(pid) ->
        {:ok, pid}

      nil ->
        case DynamicSupervisor.start_child(Gateway.ConnSupervisor, {__MODULE__, opts}) do
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
  Attaches a new WebSocket connection process to an existing session.
  """
  def attach(session_id, new_ws_pid) do
    case whereis(session_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, {:attach, new_ws_pid})

      nil ->
        {:error, :session_not_found}
    end
  end

  @doc """
  Resumes an existing session for a reconnecting WebSocket connection.
  Validates requesting_user_id against session owner.
  Returns {:ok, current_seq, missed_events} or {:error, reason}.
  """
  def resume(session_id, new_ws_pid, client_seq, requesting_user_id) do
    case whereis(session_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, {:resume, new_ws_pid, client_seq, requesting_user_id})

      nil ->
        {:error, :session_not_found}
    end
  end

  @doc """
  Returns diagnostic information about the session actor.
  """
  def info(session_id) do
    case whereis(session_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, :info)

      nil ->
        {:error, :session_not_found}
    end
  end

  @doc """
  Retrieves replayed events between `from_seq` and `to_seq` (inclusive).
  """
  def get_replay(session_id, from_seq, to_seq) do
    case whereis(session_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, {:get_replay, from_seq, to_seq})

      nil ->
        {:error, :session_not_found}
    end
  end

  @doc """
  Terminates the session actor and unsubscribes from all guilds.
  """
  def close(session_id) do
    case whereis(session_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, :close)

      nil ->
        :ok
    end
  end

  # ── GenServer Callbacks ─────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    session_id = Keyword.fetch!(opts, :session_id)
    user_id = Keyword.get(opts, :user_id)
    guild_ids = Keyword.get(opts, :guild_ids, [])
    ws_pid = Keyword.get(opts, :ws_pid)
    disconnect_ttl_ms = Keyword.get(opts, :disconnect_ttl_ms, @default_disconnect_ttl_ms)
    ring_capacity = Keyword.get(opts, :ring_capacity, 1000)
    max_queue_len = Keyword.get(opts, :max_queue_len, @default_max_queue_len)

    Gateway.Metrics.incr_session()

    ws_ref =
      if ws_pid && Process.alive?(ws_pid) do
        Process.monitor(ws_pid)
      else
        nil
      end

    # Subscribe self to all member guilds
    Enum.each(guild_ids, fn gid ->
      Gateway.Guild.Actor.subscribe(gid, session_id, self())
    end)

    # Register presence in Gateway.Presence.Store if user_id is provided (plan/05 §1 & #31)
    if user_id do
      Gateway.Presence.Store.session_connected(
        user_id,
        session_id,
        ws_pid,
        :online,
        %{},
        self()
      )
    end

    ttl_timer =
      if ws_pid == nil do
        Process.send_after(self(), :session_timeout, disconnect_ttl_ms)
      else
        nil
      end

    state = %{
      session_id: session_id,
      user_id: user_id,
      guild_ids: guild_ids,
      ws_pid: ws_pid,
      ws_ref: ws_ref,
      seq: 0,
      replay: Gateway.RingBuffer.new(ring_capacity),
      disconnect_ttl_ms: disconnect_ttl_ms,
      max_queue_len: max_queue_len,
      ttl_timer: ttl_timer
    }

    Logger.debug("Gateway.Session [#{session_id}] started with #{length(guild_ids)} guilds")
    {:ok, state}
  end

  @impl true
  def handle_call({:attach, new_ws_pid}, _from, state) do
    cancel_timer(state.ttl_timer)

    if state.ws_ref do
      Process.demonitor(state.ws_ref, [:flush])
    end

    ref = Process.monitor(new_ws_pid)

    if state.user_id do
      {initial_status, client_status} =
        case Gateway.Presence.Store.get_presence(state.user_id) do
          {:ok, %{sessions: sessions}} ->
            case Map.get(sessions, state.session_id) do
              %{declared_status: ds, client_status: cs} when ds not in [nil, :offline] ->
                {ds, cs || %{}}

              %{status: s, client_status: cs} when s not in [nil, :offline] ->
                {s, cs || %{}}

              %{client_status: cs} ->
                {:online, cs || %{}}

              _ ->
                {:online, %{}}
            end

          _ ->
            {:online, %{}}
        end

      Gateway.Presence.Store.session_connected(
        state.user_id,
        state.session_id,
        new_ws_pid,
        initial_status,
        client_status,
        self()
      )
    end

    {:reply, {:ok, state.seq},
     %{state | ws_pid: new_ws_pid, ws_ref: ref, ttl_timer: nil}}
  end

  def handle_call({:resume, new_ws_pid, client_seq, requesting_user_id}, _from, state) do
    cond do
      requesting_user_id != state.user_id ->
        Logger.warning(
          "Gateway.Session [#{state.session_id}]: unauthorized resume attempt by user #{inspect(requesting_user_id)} (owner is #{inspect(state.user_id)})"
        )

        {:reply, {:error, :unauthorized}, state}

      not is_integer(client_seq) or client_seq < 0 or client_seq > state.seq ->
        Logger.warning(
          "Gateway.Session [#{state.session_id}]: invalid resume sequence #{inspect(client_seq)} (current server seq is #{state.seq})"
        )

        {:reply, {:error, :invalid_seq}, state}

      true ->
        from_seq = client_seq + 1
        to_seq = state.seq

        case Gateway.RingBuffer.range_with_seq(state.replay, from_seq, to_seq) do
          {:ok, missed_frames} ->
            cancel_timer(state.ttl_timer)

            if state.ws_ref do
              Process.demonitor(state.ws_ref, [:flush])
            end

            ref = Process.monitor(new_ws_pid)

            if state.user_id do
              {initial_status, client_status} =
                case Gateway.Presence.Store.get_presence(state.user_id) do
                  {:ok, %{sessions: sessions}} ->
                    case Map.get(sessions, state.session_id) do
                      %{declared_status: ds, client_status: cs} when ds not in [nil, :offline] ->
                        {ds, cs || %{}}

                      %{status: s, client_status: cs} when s not in [nil, :offline] ->
                        {s, cs || %{}}

                      %{client_status: cs} ->
                        {:online, cs || %{}}

                      _ ->
                        {:online, %{}}
                    end

                  _ ->
                    {:online, %{}}
                end

              Gateway.Presence.Store.session_connected(
                state.user_id,
                state.session_id,
                new_ws_pid,
                initial_status,
                client_status,
                self()
              )
            end

            Logger.info(
              "Gateway.Session [#{state.session_id}]: resumed by user #{state.user_id} with #{length(missed_frames)} replayed frames (client_seq=#{client_seq}, current_seq=#{state.seq})"
            )

            new_state = %{state | ws_pid: new_ws_pid, ws_ref: ref, ttl_timer: nil}
            {:reply, {:ok, state.seq, missed_frames}, new_state}

          {:error, :gap_unbufferable} = err ->
            Logger.warning(
              "Gateway.Session [#{state.session_id}]: unbufferable gap for seq #{client_seq} (oldest buffered seq is #{state.replay.min_seq})"
            )

            {:reply, err, state}
        end
    end
  end

  def handle_call(:info, _from, state) do
    info = %{
      session_id: state.session_id,
      user_id: state.user_id,
      seq: state.seq,
      replay_size: Gateway.RingBuffer.size(state.replay),
      ws_pid: state.ws_pid,
      guild_ids: state.guild_ids
    }

    {:reply, {:ok, info}, state}
  end

  def handle_call({:get_replay, from_seq, to_seq}, _from, state) do
    reply = Gateway.RingBuffer.range(state.replay, from_seq, to_seq)
    {:reply, reply, state}
  end

  def handle_call(:close, _from, state) do
    {:stop, :normal, :ok, state}
  end

  @impl true
  def handle_info({:dispatch, event, bus_received_at}, state) do
    # 1. Monotonic seq assigned FIRST per plan/01 §4-5
    seq = state.seq + 1

    # 2. Append to replay ring buffer
    replay = Gateway.RingBuffer.put(state.replay, seq, event)

    # 3. Check backpressure and forward to socket writer
    new_state =
      if state.ws_pid && Process.alive?(state.ws_pid) do
        case Process.info(state.ws_pid, :message_queue_len) do
          {:message_queue_len, len} when len > state.max_queue_len ->
            Logger.warning(
              "Gateway.Session [#{state.session_id}]: slow consumer queue depth #{len} > #{state.max_queue_len}, dropping with 4008"
            )

            Gateway.Metrics.incr_slow_consumer_drop()

            # Signal close with code 4008
            send(state.ws_pid, {:close, 4008, "Slow consumer dropped"})

            if state.ws_ref do
              Process.demonitor(state.ws_ref, [:flush])
            end

            timer = Process.send_after(self(), :session_timeout, state.disconnect_ttl_ms)

            %{state | seq: seq, replay: replay, ws_pid: nil, ws_ref: nil, ttl_timer: timer}

          {:message_queue_len, len} ->
            Gateway.Metrics.record_send_queue_depth(len)
            send(state.ws_pid, {:send_frame, event, seq, bus_received_at})
            %{state | seq: seq, replay: replay}

          nil ->
            timer = Process.send_after(self(), :session_timeout, state.disconnect_ttl_ms)
            %{state | seq: seq, replay: replay, ws_pid: nil, ws_ref: nil, ttl_timer: timer}
        end
      else
        # ws_pid is nil (disconnected state): event captured in replay buffer!
        %{state | seq: seq, replay: replay}
      end

    {:noreply, new_state}
  end

  def handle_info({:DOWN, ref, :process, pid, reason}, %{ws_ref: ref} = state) do
    Logger.debug("Gateway.Session [#{state.session_id}]: socket #{inspect(pid)} down (#{inspect(reason)}); arming disconnect TTL timer")
    timer = Process.send_after(self(), :session_timeout, state.disconnect_ttl_ms)

    if state.user_id do
      Gateway.Presence.Store.session_disconnected(state.user_id, state.session_id)
    end

    {:noreply, %{state | ws_pid: nil, ws_ref: nil, ttl_timer: timer}}
  end

  def handle_info(:session_timeout, state) do
    Logger.info("Gateway.Session [#{state.session_id}]: expired after disconnect timeout; stopping")
    {:stop, :normal, state}
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    Gateway.Metrics.decr_session()
    cancel_timer(state.ttl_timer)

    Enum.each(state.guild_ids, fn gid ->
      Gateway.Guild.Actor.unsubscribe(gid, state.session_id)
    end)

    if state.user_id do
      Gateway.Presence.Store.session_disconnected(state.user_id, state.session_id)
    end

    Logger.debug("Gateway.Session [#{state.session_id}] terminated")
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

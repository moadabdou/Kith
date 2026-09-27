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
  The supervisor is partitioned (one DynamicSupervisor per scheduler
  slice); routing by session_id keeps birth bursts from serializing on a
  single mailbox while staying fully synchronous (no spawn race).
  """
  def get_or_spawn(opts) do
    session_id = Keyword.fetch!(opts, :session_id)

    case whereis(session_id) do
      pid when is_pid(pid) ->
        {:ok, pid}

      nil ->
        case Gateway.ConnSupervisor.start_child(session_id, {__MODULE__, opts}) do
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
  Mirrors acknowledged voice intent into the session (Phase 7d Step 5a,
  Tier 1). Called by the WS handler after `update_voice_state` returns
  `{:ok, _}`. `intent` carries `channel_id` (`nil` = leave, clears that
  guild), `self_mute`, `self_deaf`. Fire-and-forget cast; no-op when the
  session is gone.
  """
  def note_voice_intent(session_id, guild_id, intent) do
    case whereis(session_id) do
      pid when is_pid(pid) ->
        GenServer.cast(pid, {:voice_intent, to_string(guild_id), intent})

      nil ->
        :ok
    end
  catch
    :exit, _ -> :ok
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

    # A live socket is monitored; anything else (nil or an already-dead
    # pid, e.g. a supervisor restart reusing stale args) counts as
    # disconnected. Issue #95: the old `ws_pid == nil` test armed neither
    # monitor nor TTL for restarted sessions handed a dead pid — immortal
    # limbo. This predicate drives both the monitor and the TTL below.
    socket_alive? = is_pid(ws_pid) and Process.alive?(ws_pid)

    ws_ref =
      if socket_alive? do
        Process.monitor(ws_pid)
      else
        nil
      end

    # ETS-only, no IPC: safe to keep in the critical path (<100µs).
    if user_id do
      Gateway.Guild.Cache.put_session_user(session_id, user_id)

      Enum.each(guild_ids, fn gid ->
        case Gateway.Guild.Cache.get_member_roles(user_id, gid) do
          :error -> Gateway.Guild.Cache.put_member_roles(user_id, gid, [])
          _ -> :ok
        end
      end)
    end

    ttl_timer =
      if socket_alive? do
        nil
      else
        Process.send_after(self(), :session_timeout, disconnect_ttl_ms)
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
      ttl_timer: ttl_timer,
      # Phase 7c: %{guild_id => {actor_pid, monitor_ref}} for re-subscribe.
      # Populated in handle_continue (Issue #90): init stays non-blocking.
      actor_monitors: %{},
      # Step 4b: %{guild_id => {lane_key, lane_pid, monitor_ref}} for the
      # message lane (empty while the guild is single).
      lane_monitors: %{},
      # Phase 7d Step 5b (Tier 1): %{guild_id => %{channel_id | nil,
      # self_mute, self_deaf}} — acknowledged voice intent mirrored from
      # Op 4s, pushed to the guild actor on resubscribe after its restart.
      voice_intents: %{}
    }

    Logger.debug("Gateway.Session [#{session_id}] started with #{length(guild_ids)} guilds")
    {:ok, state, {:continue, :subscribe}}
  end

  @impl true
  def handle_continue(:subscribe, state) do
    # Issue #90: subscriptions run OFF the IDENTIFY critical path.
    # Each guild is isolated — a failure schedules the existing
    # :resubscribe backoff (1s, 3s) and never crashes the session.
    lane_monitors =
      Enum.reduce(state.guild_ids, %{}, fn gid, acc ->
        case subscribe_guild(gid, state.session_id, state.user_id, nil, acc) do
          {:ok, monitors} ->
            monitors

          {:error, reason} ->
            Logger.warning(
              "Gateway.Session [#{state.session_id}]: async subscribe to #{gid} failed (#{inspect(reason)}); scheduling resubscribe"
            )

            Process.send_after(self(), {:resubscribe, to_string(gid), 0}, 1_000)
            acc
        end
      end)

    # Non-blocking presence registration (cast, converges in µs-ms).
    if state.user_id do
      Gateway.Presence.Store.session_connected_async(
        state.user_id,
        state.session_id,
        state.ws_pid,
        :online,
        %{},
        self()
      )
    end

    actor_monitors = monitor_actors(state.guild_ids, %{})

    # Phase 7c: Horde registry replicas converge asynchronously (~300ms
    # CRDT sync). Any guild with no monitor yet (actor just created on
    # another node) is rechecked through the resubscribe path, which
    # subscribes (idempotent) and monitors once visible.
    for gid <- state.guild_ids, not Map.has_key?(actor_monitors, to_string(gid)) do
      Process.send_after(self(), {:resubscribe, to_string(gid), 0}, 1_000)
    end

    {:noreply, %{state | lane_monitors: lane_monitors, actor_monitors: actor_monitors}}
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

  # Phase 7d Step 5b: cache acknowledged intent; forward to the actor when
  # already subscribed so a note racing a resubscribe still lands (the
  # actor's accept-if-absent guard makes the forward idempotent — live
  # subscriptions already hold the state, resubscribe piggybacks the rest).
  @impl true
  def handle_cast({:voice_intent, gid, intent}, state) do
    gid = to_string(gid)
    intent = normalize_intent(intent)

    voice_intents =
      if is_nil(intent.channel_id) do
        Map.delete(state.voice_intents, gid)
      else
        Map.put(state.voice_intents, gid, intent)
      end

    state = %{state | voice_intents: voice_intents}

    if Map.has_key?(state.actor_monitors, gid) do
      Gateway.Guild.Actor.push_voice_intent(gid, state.session_id, intent)
    end

    {:noreply, state}
  end

  @impl true
  def handle_info({:dispatch, event, bus_received_at}, state) do
    # Issue #91: session-side permission gate. The guild actor
    # dumb-broadcasts channel-scoped data events to all subscribers; each
    # session filters locally so permission resolution runs in parallel
    # across all scheduler cores instead of serialized in one actor.
    # Filter BEFORE seq assignment: dropped frames must not consume seq or
    # replay space, else RESUME would leak unauthorized content.
    if channel_scoped_denied?(event, state) do
      Gateway.Metrics.incr_permission_filtered()
      {:noreply, state}
    else
      push_dispatch(event, bus_received_at, state)
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, pid, reason}, %{ws_ref: ref} = state) do
    Logger.debug("Gateway.Session [#{state.session_id}]: socket #{inspect(pid)} down (#{inspect(reason)}); arming disconnect TTL timer")
    timer = Process.send_after(self(), :session_timeout, state.disconnect_ttl_ms)

    if state.user_id do
      Gateway.Presence.Store.session_disconnected(state.user_id, state.session_id)
    end

    {:noreply, %{state | ws_pid: nil, ws_ref: nil, ttl_timer: timer}}
  end

  # Phase 7c: a subscribed guild actor died (its node may be gone; Horde
  # restarts it elsewhere). Re-subscribe with backoff so this live session
  # keeps receiving events with seq continuity intact.
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Enum.find(state.actor_monitors, fn {_gid, {_p, r}} -> r == ref end) do
      {gid, _} ->
        Logger.info("Gateway.Session [#{state.session_id}]: guild actor for #{gid} down; scheduling re-subscribe")
        Process.send_after(self(), {:resubscribe, gid, 0}, 500)
        {:noreply, %{state | actor_monitors: Map.delete(state.actor_monitors, gid)}}

      nil ->
        # Step 4b: a message lane died; same backoff, lane-only path.
        case Enum.find(state.lane_monitors, fn {_gid, {_k, _p, r}} -> r == ref end) do
          {gid, {key, _p, _r}} ->
            Logger.info("Gateway.Session [#{state.session_id}]: message lane for #{gid} down; scheduling lane re-subscribe")
            Process.send_after(self(), {:resubscribe_lane, gid, key, 0}, 500)
            {:noreply, %{state | lane_monitors: Map.delete(state.lane_monitors, gid)}}

          nil ->
            {:noreply, state}
        end
    end
  end

  @resubscribe_delays [1_000, 3_000]

  def handle_info({:resubscribe, gid, attempt}, state) do
    # Phase 7d Step 5b: piggyback the cached voice intent (if any) so a
    # restarted actor rebuilds its roster without waiting on the browser.
    # The actor applies it under its guards (absent, lease, perms).
    intent = Map.get(state.voice_intents, to_string(gid))

    case subscribe_guild(gid, state.session_id, state.user_id, intent, state.lane_monitors) do
      {:ok, lane_monitors} ->
        Gateway.Metrics.incr_resubscribe()
        Logger.info("Gateway.Session [#{state.session_id}]: re-subscribed to guild #{gid}")

        {:noreply,
         %{state | actor_monitors: monitor_actors([gid], state.actor_monitors), lane_monitors: lane_monitors}}

      {:error, reason} ->
        case Enum.at(@resubscribe_delays, attempt) do
          nil ->
            Logger.warning("Gateway.Session [#{state.session_id}]: giving up re-subscribe to #{gid} (#{inspect(reason)}); client reconnect will heal")
            {:noreply, state}

          delay ->
            Process.send_after(self(), {:resubscribe, gid, attempt + 1}, delay)
            {:noreply, state}
        end
    end
  end

  # Step 4b: lane-only re-subscribe with the same backoff. get_or_spawn
  # inside subscribe revives a dead lane; order per guild is preserved
  # because the lane key (and its FIFO mailbox) never changes.
  def handle_info({:resubscribe_lane, gid, key, attempt}, state) do
    case try_guild_call(fn ->
           Gateway.Guild.Actor.subscribe(key, state.session_id, self(), state.user_id)
         end) do
      :ok ->
        Logger.info("Gateway.Session [#{state.session_id}]: re-subscribed to lane #{key}")

        {:noreply,
         %{state | lane_monitors: monitor_lane_key(to_string(gid), key, state.lane_monitors)}}

      {:error, reason} ->
        case Enum.at(@resubscribe_delays, attempt) do
          nil ->
            Logger.warning("Gateway.Session [#{state.session_id}]: giving up lane re-subscribe to #{key} (#{inspect(reason)}); client reconnect will heal")
            {:noreply, state}

          delay ->
            Process.send_after(self(), {:resubscribe_lane, gid, key, attempt + 1}, delay)
            {:noreply, state}
        end
    end
  end

  # Step 4b: control announces chat moved to lanes; join ours (idempotent
  # with the post-subscribe join — whichever lands first wins, the other
  # is a no-op re-subscribe).
  def handle_info({:guild_split, gid}, state) do
    lane_monitors =
      join_and_monitor_lane(to_string(gid), state.session_id, state.user_id, state.lane_monitors)

    {:noreply, %{state | lane_monitors: lane_monitors}}
  end

  def handle_info(:session_timeout, state) do
    Logger.info("Gateway.Session [#{state.session_id}]: expired after disconnect timeout; stopping")
    {:stop, :normal, state}
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  # Issue #95: every guild-actor call site in this module funnels through
  # here. GenServer.call exits (timeouts under burst, Horde races) become
  # plain errors feeding the resubscribe backoff. A lone slow guild must
  # never crash the session: a crash restarts it with a stale dead ws_pid
  # that arms neither monitor nor TTL (limbo). Never raises.
  defp try_guild_call(fun) do
    case fun.() do
      :ok -> :ok
      {:error, reason} -> {:error, reason}
      other -> {:error, {:unexpected_reply, other}}
    end
  catch
    kind, reason -> {:error, {kind, reason}}
  end

  # Full per-guild subscription (control + lane join) that never raises.
  # Lane-join failures schedule a lane-only retry; the resubscribe loop
  # heals anything left over.
  defp subscribe_guild(gid, session_id, user_id, intent, lane_monitors) do
    case try_guild_call(fn ->
           Gateway.Guild.Actor.subscribe(gid, session_id, self(), user_id, intent)
         end) do
      :ok ->
        {:ok, join_and_monitor_lane(to_string(gid), session_id, user_id, lane_monitors)}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @impl true
  def terminate(_reason, state) do
    Gateway.Metrics.decr_session()
    cancel_timer(state.ttl_timer)

    # Fire-and-forget (Issue #88 teardown flood): terminate must never
    # block on a backlogged guild actor — the :DOWN monitor path converges
    # to the same cleanup.
    Enum.each(state.guild_ids, fn gid ->
      Gateway.Guild.Actor.unsubscribe_async(gid, state.session_id)
    end)

    # Step 4b: leave message lanes too (same fire-and-forget discipline).
    Enum.each(state.lane_monitors, fn {_gid, {key, _p, _r}} ->
      Gateway.Guild.Actor.unsubscribe_async(key, state.session_id)
    end)

    if state.user_id do
      Gateway.Presence.Store.session_disconnected(state.user_id, state.session_id)
    end

    Logger.debug("Gateway.Session [#{state.session_id}] terminated")
    :ok
  end

  # ── Internal Helpers ────────────────────────────────────────────────────────

  defp normalize_intent(intent) when is_map(intent) do
    channel_id =
      case intent[:channel_id] || intent["channel_id"] do
        nil -> nil
        "" -> nil
        cid -> to_string(cid)
      end

    %{
      channel_id: channel_id,
      self_mute: intent[:self_mute] == true or intent["self_mute"] == true,
      self_deaf: intent[:self_deaf] == true or intent["self_deaf"] == true
    }
  end

  defp normalize_intent(_), do: %{channel_id: nil, self_mute: false, self_deaf: false}

  # Issue #91: session-side permission gate helpers. Returns true when the
  # event rides the dumb-broadcast path AND this session may not view its
  # channel. Only dumb-path types are checked — lifecycle/synthetic types
  # (CHANNEL_*, MEMBER/ROLE_*) stay actor-gated (the actor computes
  # per-subscriber visibility for those, including synthetic
  # CHANNEL_DELETE notices a revoked session must still receive).
  defp channel_scoped_denied?(event, state) do
    type = event["type"] || "UNKNOWN"

    if type in Gateway.Guild.Actor.lane_family() or type == "TYPING_START" do
      channel_id = dispatch_channel_id(event)
      guild_id = event["guild_id"] || (is_map(event["payload"]) && event["payload"]["guild_id"])

      not is_nil(channel_id) and not is_nil(guild_id) and
        not Gateway.Permissions.can_view?(state.user_id, channel_id, guild_id)
    else
      false
    end
  end

  # Subset of the actor's channel extraction covering data-event shapes
  # (message payloads carry channel_id directly or nested under message).
  defp dispatch_channel_id(event) do
    payload = Map.get(event, "payload") || %{}
    message = Map.get(payload, "message") || %{}

    cid =
      event["channel_id"] ||
        payload["channel_id"] ||
        message["channel_id"]

    case cid do
      nil -> nil
      "" -> nil
      id -> to_string(id)
    end
  end

  # Original dispatch pipeline (seq, replay, backpressure, forward),
  # now behind the Issue #91 permission gate in handle_info/2 above.
  defp push_dispatch(event, bus_received_at, state) do
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

  # Step 4b: join the message lane when the guild is split (sync call,
  # confirmed), then flag migrated on control (join-then-flag: zero-loss
  # cutover). Idempotent: safe to run on every (re)subscribe and on the
  # control's split announcement. Never raises (Issue #95): a failed lane
  # join schedules a lane-only retry and the resubscribe loop heals the
  # rest — this runs inside handle_continue, resubscribe, and guild_split
  # handlers, none of which may crash on a slow actor.
  defp join_and_monitor_lane(gid, session_id, user_id, lane_monitors) do
    case Gateway.Guild.Actor.message_lane(gid, session_id) do
      {:lane, key} ->
        case try_guild_call(fn ->
               Gateway.Guild.Actor.subscribe(key, session_id, self(), user_id)
             end) do
          :ok ->
            Gateway.Guild.Actor.note_migrated(gid, session_id)
            monitor_lane_key(gid, key, lane_monitors)

          {:error, reason} ->
            Logger.warning(
              "Gateway.Session [#{session_id}]: lane join #{key} failed (#{inspect(reason)}); scheduling lane resubscribe"
            )

            Process.send_after(self(), {:resubscribe_lane, to_string(gid), key, 0}, 1_000)
            lane_monitors
        end

      :single ->
        lane_monitors
    end
  catch
    kind, reason ->
      Logger.warning(
        "Gateway.Session [#{session_id}]: lane join for #{gid} #{kind} (#{inspect(reason)}); scheduling resubscribe"
      )

      Process.send_after(self(), {:resubscribe, to_string(gid), 0}, 1_000)
      lane_monitors
  end

  defp monitor_lane_key(gid, key, lane_monitors) do
    case Gateway.Guild.Actor.whereis(key) do
      pid when is_pid(pid) ->
        case Map.get(lane_monitors, to_string(gid)) do
          {_k, _old_pid, old_ref} -> Process.demonitor(old_ref, [:flush])
          nil -> :ok
        end

        Map.put(lane_monitors, to_string(gid), {key, pid, Process.monitor(pid)})

      nil ->
        lane_monitors
    end
  end

  # Phase 7c: monitor the current actor pid for each guild (cluster-wide
  # lookup — the actor may live on another node). Idempotent. Keys are
  # strings; missing entries mean "not visible yet", never "absent".
  # NOTE: Process.alive?/1 raises on remote pids; remote entries are
  # trusted to Horde lifecycle (see Actor.whereis/1).
  defp monitor_actors(guild_ids, monitors) do
    Enum.reduce(guild_ids, monitors, fn gid, acc ->
      key = to_string(gid)

      case Map.get(acc, key) do
        {pid, _ref} when is_pid(pid) ->
          if node(pid) == node() do
            if Process.alive?(pid), do: acc, else: Map.delete(acc, key)
          else
            acc
          end

        nil ->
          case Gateway.Guild.Actor.whereis(key) do
            pid when is_pid(pid) -> Map.put(acc, key, {pid, Process.monitor(pid)})
            nil -> acc
          end
      end
    end)
  end

  defp cancel_timer(nil), do: :ok

  defp cancel_timer(timer) when is_reference(timer) do
    if Process.read_timer(timer) do
      Process.cancel_timer(timer)
    end

    :ok
  end
end

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
    # Phase 7c (Issue #86): cluster-wide registry. The actor for a guild
    # lives on exactly one node; Horde routes lookups and calls there.
    {:via, Horde.Registry, {Gateway.HordeRegistry, to_string(guild_id)}}
  end

  @doc """
  Finds existing guild actor in the cluster or lazily spawns one via the
  distributed supervisor (Horde places it on some node).
  """
  def get_or_spawn(guild_id, opts \\ []) do
    gid = to_string(guild_id)

    case whereis(gid) do
      pid when is_pid(pid) ->
        {:ok, pid}

      nil ->
        child_opts = Keyword.merge(opts, [guild_id: gid])

        case Horde.DynamicSupervisor.start_child(Gateway.GuildSupervisor, {__MODULE__, child_opts}) do
          {:ok, pid} ->
            {:ok, pid}

          {:error, {:already_started, pid}} ->
            {:ok, pid}

          {:error, reason} ->
            # Lost a placement race or the cluster is settling: one fresh
            # lookup before giving up.
            case whereis(gid) do
              pid when is_pid(pid) -> {:ok, pid}
              nil -> {:error, reason}
            end
        end
    end
  end

  @doc """
  Returns the PID of the guild actor if registered and alive anywhere in
  the cluster, else nil.

  NOTE: `Process.alive?/1` raises on remote pids, so liveness is only
  checked locally. For remote entries, Horde owns lifecycle: entries from
  departed nodes are removed on re-sync, and a stale pid fails safe
  (casts drop; `get_or_spawn` retries via lookup).
  """
  def whereis(guild_id) do
    case Horde.Registry.lookup(Gateway.HordeRegistry, to_string(guild_id)) do
      [{pid, _}] when is_pid(pid) ->
        if node(pid) == node() do
          if Process.alive?(pid), do: pid, else: nil
        else
          pid
        end

      [] ->
        nil
    end
  end

  @doc """
  Subscribes a connection session to the guild actor.

  `voice_intent` (Phase 7d Step 5c, Tier 1) is the session's cached
  `%{channel_id | nil, self_mute, self_deaf}` — applied under the guarded
  rules in `apply_voice_intent/4` (absent, lease, perms, stamp). `nil`
  (default) subscribes bare, preserving all existing call sites.
  """
  def subscribe(guild_id, session_id, pid \\ nil, user_id \\ nil, voice_intent \\ nil) do
    target_pid = pid || self()

    case get_or_spawn(guild_id) do
      {:ok, actor_pid} ->
        GenServer.call(actor_pid, {:subscribe, session_id, target_pid, user_id, voice_intent})

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

  `opts[:bus_seq]` carries the NATS JetStream stream sequence for cross-node
  duplicate suppression (Phase 7c). Callers without a bus position (legacy
  Redis bus, synthesized events) pass none and always dispatch.
  """
  def dispatch_event(guild_id, event, bus_received_at \\ nil, opts \\ []) do
    case whereis(guild_id) do
      pid when is_pid(pid) ->
        GenServer.cast(pid, {:dispatch_event, event, bus_received_at, opts})

      nil ->
        :ok
    end
  end

  @doc """
  Bus-only dispatch: like `dispatch_event/4`, but only when the actor lives
  on THIS node (Phase 7c follow-up).

  Every gateway node consumes every NATS event; without this gate, each
  node's consumer casts a full copy across distribution to the actor's node,
  and the receiving actor drops it in dedup. That doubles actor mailbox
  traffic and distribution chatter per event. With the gate, exactly the
  hosting node dispatches — the mirror copy is dropped before crossing the
  wire. `Cache.handle_event` still runs on every node (cache convergence).

  Dedup and the lease stay as safety nets: split-brain (each node sees a
  local actor) and handover windows are unaffected by this gate.
  """
  def dispatch_bus_event(guild_id, event, bus_received_at \\ nil, opts \\ []) do
    case whereis(guild_id) do
      pid when is_pid(pid) ->
        if node(pid) == node() do
          GenServer.cast(pid, {:dispatch_event, event, bus_received_at, opts})
        else
          Gateway.Metrics.incr_dedup_drop()
          :ok
        end

      nil ->
        :ok
    end
  end

  @doc """
  Pushes a session's cached voice intent to the guild actor outside of
  subscribe (Phase 7d Step 5c). Used by sessions forwarding notes that raced
  their resubscribe. Same guarded apply as the subscribe piggyback.
  Fire-and-forget cast; safe against a dead/restarting actor.
  """
  def push_voice_intent(guild_id, session_id, intent) do
    case whereis(guild_id) do
      pid when is_pid(pid) ->
        GenServer.cast(pid, {:push_voice_intent, to_string(session_id), intent})

      nil ->
        :ok
    end
  catch
    :exit, _ -> :ok
  end

  @doc """
  Updates or clears the voice state for a user in this guild.
  """
  def update_voice_state(guild_id, user_id, session_id, params) do
    case get_or_spawn(guild_id) do
      {:ok, pid} ->
        GenServer.call(pid, {:update_voice_state, user_id, session_id, params})

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Returns all active voice states in this guild.
  """
  def get_voice_states(guild_id) do
    case whereis(guild_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, :get_voice_states)

      nil ->
        %{}
    end
  end

  @doc """
  Returns all active voice states in this guild visible to `user_id`.
  """
  def get_visible_voice_states(guild_id, user_id) do
    get_voice_states(guild_id)
    |> Map.values()
    |> Enum.filter(fn vs ->
      vs.channel_id != nil and
        Gateway.Permissions.can_view?(user_id, vs.channel_id, guild_id)
    end)
    |> Enum.map(&Gateway.Voice.VoiceState.to_map/1)
  end

  # ── GenServer Callbacks ─────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    guild_id = Keyword.fetch!(opts, :guild_id) |> to_string()
    ttl_ms = Keyword.get(opts, :ttl_ms, @default_ttl_ms)

    Gateway.Metrics.incr_guild_actor()

    # Start TTL timer since initial subscriber count is 0
    ttl_timer = Process.send_after(self(), :ttl_check, ttl_ms)

    # Phase 7c: claim the dispatch lease immediately so a fresh actor can
    # serve without waiting for the first renewal tick.
    {lease_held, lease_timer} = refresh_lease(guild_id, false)
    if lease_held, do: Gateway.Metrics.incr_lease_acquired()

    state = %{
      guild_id: guild_id,
      subscribers: %{},
      subscriber_refs: %{},
      ttl_ms: ttl_ms,
      ttl_timer: ttl_timer,
      voice_states: %{},
      # Phase 7d Step 5c (Tier 1): %{user_id => {session_id, intent}} stashed
      # while lease-less, flushed on the lease-acquired transition.
      pending_voice_intents: %{},
      last_bus_event: nil,
      lease_held: lease_held,
      lease_timer: lease_timer
    }

    Logger.info("Gateway.Guild.Actor [#{guild_id}] started on #{node()}")
    {:ok, state}
  end

  @impl true
  def handle_call({:subscribe, session_id, pid}, from, state) do
    handle_call({:subscribe, session_id, pid, nil, nil}, from, state)
  end

  def handle_call({:subscribe, session_id, pid, user_id}, from, state) do
    handle_call({:subscribe, session_id, pid, user_id, nil}, from, state)
  end

  def handle_call({:subscribe, session_id, pid, user_id, voice_intent}, _from, state) do
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

    uid =
      if user_id && user_id != "" do
        to_string(user_id)
      else
        case Gateway.Guild.Cache.get_session_user(session_id) do
          {:ok, u} -> to_string(u)
          _ -> nil
        end
      end

    # Phase 7c warm-on-miss: this actor may live on a node whose cache never
    # saw this user's IDENTIFY (which warms only the IDENTIFY node). The bus
    # carries mutations, never baselines, so load the snapshot from PG here.
    # Best-effort: on warm failure we proceed with cached data (old behavior).
    if uid do
      case Gateway.Guild.Cache.ensure_member_view(uid, state.guild_id) do
        :ok ->
          :ok

        {:error, reason} ->
          Logger.debug("Gateway.Guild.Actor [#{state.guild_id}] cache warm missed for #{uid}: #{inspect(reason)}")
      end
    end

    sub_info = %{
      pid: pid,
      user_id: uid,
      channels: if(uid, do: compute_visible_channels(uid, state.guild_id), else: nil)
    }

    subscribers = Map.put(state.subscribers, session_id, sub_info)
    subscriber_refs = Map.put(subscriber_refs, ref, session_id)

    state = %{state | subscribers: subscribers, subscriber_refs: subscriber_refs, ttl_timer: nil}

    # Phase 7d Step 5c (Tier 1): apply the session's cached voice intent
    # under the guarded rules (absent, lease, perms, stamp). The subscriber
    # is registered first so the resulting VOICE_SERVER_UPDATE routes.
    state = apply_voice_intent(state, to_string(session_id), uid, voice_intent)

    {:reply, :ok, state}
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
    state = cleanup_voice_state_for_session(session_id, %{state | subscribers: subscribers, subscriber_refs: subscriber_refs})

    # Phase 7d Step 5c: a gone session's stashed intent dies with it —
    # never apply placement for a socket that no longer exists.
    pending_voice_intents =
      Map.reject(state.pending_voice_intents, fn {_uid, {sid, _}} -> sid == session_id end)

    state = %{state | pending_voice_intents: pending_voice_intents}

    ttl_timer =
      if map_size(subscribers) == 0 do
        Process.send_after(self(), :ttl_check, state.ttl_ms)
      else
        nil
      end

    {:reply, :ok, %{state | ttl_timer: ttl_timer}}
  end

  def handle_call(:subscribers, _from, state) do
    list =
      Enum.map(state.subscribers, fn
        {sid, %{pid: pid}} -> {sid, pid}
        {sid, {pid, _uid}} -> {sid, pid}
        {sid, pid} when is_pid(pid) -> {sid, pid}
      end)

    {:reply, list, state}
  end

  def handle_call(:subscriber_count, _from, state) do
    {:reply, map_size(state.subscribers), state}
  end

  def handle_call({:update_voice_state, user_id, session_id, params}, _from, state) do
    uid = to_string(user_id)
    sid = to_string(session_id)
    channel_id = params["channel_id"] || params[:channel_id]
    cid = if channel_id && channel_id != "", do: to_string(channel_id), else: nil
    self_mute = params["self_mute"] == true or params[:self_mute] == true
    self_deaf = params["self_deaf"] == true or params[:self_deaf] == true

    old_vs = Map.get(state.voice_states, uid)
    old_cid = if old_vs, do: old_vs.channel_id, else: nil

    # Phase 7c warm-on-miss (same rationale as subscribe above): voice joins
    # validate against this node's cache, which may never have seen IDENTIFY.
    _ = Gateway.Guild.Cache.ensure_member_view(uid, state.guild_id)

    cond do
      cid != nil ->
        case Gateway.Guild.Cache.get_channel(cid) do
          {:ok, %{"type" => type}} when type in [2, :voice, "2"] ->
            can_view = can_subscriber_view?(uid, cid, state.guild_id)
            can_connect = Gateway.Permissions.can_connect?(uid, cid, state.guild_id)

            if can_view and can_connect do
              if is_nil(old_vs) or is_nil(old_vs.channel_id) do
                Gateway.Metrics.incr_voice_connection()
              end

              new_vs =
                Gateway.Voice.VoiceState.new(%{
                  guild_id: state.guild_id,
                  channel_id: cid,
                  user_id: uid,
                  session_id: sid,
                  self_mute: self_mute,
                  self_deaf: self_deaf
                })

              new_voice_states = Map.put(state.voice_states, uid, new_vs)
              fan_out_voice_state_update(new_vs, old_cid, state)

              # Phase 7d (Issue #87): ALWAYS re-emit on join/move. Placement
              # is time-varying now (health poller excludes dead SFUs), so a
              # client re-requesting the same channel may need a DIFFERENT
              # endpoint than last time — the old same-session/same-channel
              # dedupe would hand back silence instead. The client's
              # transport dedupe (VoiceContext lastVoiceServerRef) still
              # protects healthy sessions from rebuilds.
              #
              # Step 6a: re-requests (client already placed: old_vs present)
              # confirm the candidate on the demand path, so a kill between
              # poller cycles is excluded within milliseconds instead of one
              # poll interval. Initial joins trust the poller (no extra
              # probe in steady state).
              rerequest? = not is_nil(old_vs) and not is_nil(old_vs.channel_id)
              dispatch_voice_server_update(sid, cid, state, rerequest?)

              {:reply, {:ok, new_vs}, %{state | voice_states: new_voice_states}}
            else
              {:reply, {:error, :missing_permissions}, state}
            end

          _ ->
            {:reply, {:error, :not_a_voice_channel}, state}
        end

      true ->
        # Leaving voice channel
        if old_vs do
          if not is_nil(old_vs.channel_id) do
            Gateway.Metrics.decr_voice_connection()
          end

          new_voice_states = Map.delete(state.voice_states, uid)

          leave_vs = %Gateway.Voice.VoiceState{
            guild_id: state.guild_id,
            channel_id: nil,
            user_id: uid,
            session_id: sid,
            self_mute: self_mute,
            self_deaf: self_deaf
          }

          fan_out_voice_state_update(leave_vs, old_cid, state)
          {:reply, {:ok, leave_vs}, %{state | voice_states: new_voice_states}}
        else
          {:reply, {:ok, nil}, state}
        end
    end
  end

  def handle_call(:get_voice_states, _from, state) do
    {:reply, state.voice_states, state}
  end




  @channel_scoped_events [
    "MESSAGE_CREATE",
    "MESSAGE_UPDATE",
    "MESSAGE_DELETE",
    "TYPING_START",
    "CHANNEL_CREATE",
    "CHANNEL_UPDATE",
    "MESSAGE_REACTION_ADD",
    "MESSAGE_REACTION_REMOVE",
    "MESSAGE_REACTION_REMOVE_ALL",
    "MESSAGE_REACTION_REMOVE_EMOJI"
  ]

  @impl true
  def handle_cast({:dispatch_event, event, bus_received_at}, state) do
    handle_cast({:dispatch_event, event, bus_received_at, []}, state)
  end

  # Phase 7c: every node consumes every bus event, but only one actor per
  # guild may fan out. Exact {bus_seq, type} match = the other node's copy
  # of the same stream message → drop. Then the lease gate: a non-holder
  # (e.g. a SIGSTOPped node's stale actor) stays silent.
  def handle_cast({:dispatch_event, event, bus_received_at, opts}, state) do
    bus_seq = Keyword.get(opts, :bus_seq)
    type = event["type"] || "UNKNOWN"
    {state, duplicate?} = track_bus_event(state, bus_seq, type)

    cond do
      duplicate? ->
        Gateway.Metrics.incr_dedup_drop()
        {:noreply, state}

      not state.lease_held ->
        Gateway.Metrics.incr_lease_drop()
        {:noreply, state}

      true ->
        route_dispatch(event, bus_received_at, state)
    end
  end

  # Phase 7d Step 5c: out-of-subscribe intent push (session forwarding a note
  # that raced its resubscribe). The subscribing session id rides along —
  # the actor verifies it is still registered before applying (liveness).
  def handle_cast({:push_voice_intent, session_id, intent}, state) do
    uid =
      case Map.get(state.subscribers, session_id) do
        %{user_id: found} when not is_nil(found) -> found
        _ -> nil
      end

    {:noreply, apply_voice_intent(state, session_id, uid, intent)}
  end

  # Exact {seq, type} match against the last routed event. Stream sequences
  # are unique per message, so only a true cross-node duplicate matches.
  # Events without a bus position (legacy bus, synthesized) always route.
  defp track_bus_event(state, nil, _type), do: {state, false}

  defp track_bus_event(state, bus_seq, type) do
    if state.last_bus_event == {bus_seq, type} do
      {state, true}
    else
      {%{state | last_bus_event: {bus_seq, type}}, false}
    end
  end

  # Original broadcast/channel routing, unchanged.
  defp route_dispatch(event, bus_received_at, state) do
    type = event["type"] || "UNKNOWN"

    state =
      case type do
        "CHANNEL_UPDATE" ->
          handle_channel_update_dispatch(event, bus_received_at, state)

        "CHANNEL_CREATE" ->
          handle_channel_create_dispatch(event, bus_received_at, state)

        "CHANNEL_DELETE" ->
          handle_channel_delete_dispatch(event, bus_received_at, state)

        "GUILD_MEMBER_UPDATE" ->
          handle_guild_member_update_dispatch(event, bus_received_at, state)

        "GUILD_ROLE_CREATE" ->
          handle_guild_role_change_dispatch(event, bus_received_at, state)

        "GUILD_ROLE_UPDATE" ->
          handle_guild_role_change_dispatch(event, bus_received_at, state)

        "GUILD_ROLE_DELETE" ->
          handle_guild_role_change_dispatch(event, bus_received_at, state)

        type when type in ["VOICE_PEER_LEFT", "voice.peer_left"] ->
          handle_voice_peer_left_dispatch(event, bus_received_at, state)

        type when type in ["VOICE_PEER_JOINED", "voice.peer_joined"] ->
          handle_voice_peer_joined_dispatch(event, bus_received_at, state)

        _ ->
          if type in @channel_scoped_events do
            handle_channel_scoped_dispatch(event, bus_received_at, state)
          else
            handle_broadcast_dispatch(event, bus_received_at, state)
          end

          state
      end

    {:noreply, state}
  end

  defp handle_channel_update_dispatch(event, bus_received_at, state) do
    channel_id = extract_channel_id(event)

    # Snapshot existing visible channels before mutating ETS cache
    normalized_subscribers =
      Enum.map(state.subscribers, fn {session_id, sub} ->
        {session_id, normalize_subscriber(session_id, sub, state.guild_id)}
      end)

    # Update ETS cache with the channel update (including new permission overwrites)
    Gateway.Guild.Cache.handle_event(event)

    new_subscribers =
      Enum.reduce(normalized_subscribers, state.subscribers, fn {session_id, {pid, user_id, visible_channels}}, acc ->
        if channel_id do
          was_visible = MapSet.member?(visible_channels, channel_id)
          is_visible_now = can_subscriber_view?(user_id, channel_id, state.guild_id)

          cond do
            was_visible and not is_visible_now ->
              # Revoked: dispatch synthetic CHANNEL_DELETE
              synthetic_delete = %{
                "type" => "CHANNEL_DELETE",
                "guild_id" => state.guild_id,
                "payload" => %{
                  "id" => channel_id,
                  "guild_id" => state.guild_id
                }
              }

              send(pid, {:dispatch, synthetic_delete, bus_received_at})

              updated_sub = %{
                pid: pid,
                user_id: user_id,
                channels: MapSet.delete(visible_channels, channel_id)
              }

              Map.put(acc, session_id, updated_sub)

            not was_visible and is_visible_now ->
              # Gained: dispatch synthetic CHANNEL_CREATE
              synthetic_create = build_synthetic_channel_create(channel_id, state.guild_id, event)
              send(pid, {:dispatch, synthetic_create, bus_received_at})

              updated_sub = %{
                pid: pid,
                user_id: user_id,
                channels: MapSet.put(visible_channels, channel_id)
              }

              Map.put(acc, session_id, updated_sub)

            was_visible and is_visible_now ->
              # Maintained access: dispatch standard CHANNEL_UPDATE
              send(pid, {:dispatch, event, bus_received_at})
              acc

            true ->
              # Neither visible before nor now: suppress
              acc
          end
        else
          send(pid, {:dispatch, event, bus_received_at})
          acc
        end
      end)

    %{state | subscribers: new_subscribers}
  end

  defp handle_channel_create_dispatch(event, bus_received_at, state) do
    Gateway.Guild.Cache.handle_event(event)
    channel_id = extract_channel_id(event)

    new_subscribers =
      Enum.reduce(state.subscribers, state.subscribers, fn {session_id, sub}, acc ->
        {pid, user_id, visible_channels} = normalize_subscriber(session_id, sub, state.guild_id)

        if can_subscriber_view?(user_id, channel_id, state.guild_id) do
          send(pid, {:dispatch, event, bus_received_at})

          updated_sub = %{
            pid: pid,
            user_id: user_id,
            channels: if(channel_id, do: MapSet.put(visible_channels, channel_id), else: visible_channels)
          }

          Map.put(acc, session_id, updated_sub)
        else
          acc
        end
      end)

    %{state | subscribers: new_subscribers}
  end

  defp handle_channel_delete_dispatch(event, bus_received_at, state) do
    channel_id = extract_channel_id(event)

    new_subscribers =
      Enum.reduce(state.subscribers, state.subscribers, fn {session_id, sub}, acc ->
        {pid, user_id, visible_channels} = normalize_subscriber(session_id, sub, state.guild_id)

        if MapSet.member?(visible_channels, channel_id) or
             can_subscriber_view?(user_id, channel_id, state.guild_id) do
          send(pid, {:dispatch, event, bus_received_at})

          updated_sub = %{
            pid: pid,
            user_id: user_id,
            channels: if(channel_id, do: MapSet.delete(visible_channels, channel_id), else: visible_channels)
          }

          Map.put(acc, session_id, updated_sub)
        else
          acc
        end
      end)

    Gateway.Guild.Cache.handle_event(event)
    %{state | subscribers: new_subscribers}
  end

  defp handle_guild_member_update_dispatch(event, bus_received_at, state) do
    target_uid = extract_user_id(event)

    normalized_subscribers =
      Enum.map(state.subscribers, fn {session_id, sub} ->
        {session_id, normalize_subscriber(session_id, sub, state.guild_id)}
      end)

    Gateway.Guild.Cache.handle_event(event)
    guild_channels = Gateway.Guild.Cache.list_guild_channels(state.guild_id)

    new_subscribers =
      Enum.reduce(normalized_subscribers, state.subscribers, fn {session_id, {pid, user_id, visible_channels}}, acc ->
        # Non-channel event: dispatch to all subscribers
        send(pid, {:dispatch, event, bus_received_at})

        if user_id == target_uid and target_uid != "" do
          updated_channels =
            Enum.reduce(guild_channels, visible_channels, fn chan, chans_acc ->
              cid = to_string(chan["id"] || chan[:id])
              was_visible = MapSet.member?(chans_acc, cid)
              is_visible_now = can_subscriber_view?(user_id, cid, state.guild_id)

              cond do
                was_visible and not is_visible_now ->
                  synthetic_delete = %{
                    "type" => "CHANNEL_DELETE",
                    "guild_id" => state.guild_id,
                    "payload" => %{
                      "id" => cid,
                      "guild_id" => state.guild_id
                    }
                  }

                  send(pid, {:dispatch, synthetic_delete, bus_received_at})
                  MapSet.delete(chans_acc, cid)

                not was_visible and is_visible_now ->
                  synthetic_create = build_synthetic_channel_create(cid, state.guild_id, nil)
                  send(pid, {:dispatch, synthetic_create, bus_received_at})
                  MapSet.put(chans_acc, cid)

                true ->
                  chans_acc
              end
            end)

          updated_sub = %{
            pid: pid,
            user_id: user_id,
            channels: updated_channels
          }

          Map.put(acc, session_id, updated_sub)
        else
          acc
        end
      end)

    %{state | subscribers: new_subscribers}
  end

  defp handle_guild_role_change_dispatch(event, bus_received_at, state) do
    normalized_subscribers =
      Enum.map(state.subscribers, fn {session_id, sub} ->
        {session_id, normalize_subscriber(session_id, sub, state.guild_id)}
      end)

    Gateway.Guild.Cache.handle_event(event)
    guild_channels = Gateway.Guild.Cache.list_guild_channels(state.guild_id)

    new_subscribers =
      Enum.reduce(normalized_subscribers, state.subscribers, fn {session_id, {pid, user_id, visible_channels}}, acc ->
        # Broadcast role event to subscriber
        send(pid, {:dispatch, event, bus_received_at})

        if user_id do
          updated_channels =
            Enum.reduce(guild_channels, visible_channels, fn chan, chans_acc ->
              cid = to_string(chan["id"] || chan[:id])
              was_visible = MapSet.member?(chans_acc, cid)
              is_visible_now = can_subscriber_view?(user_id, cid, state.guild_id)

              cond do
                was_visible and not is_visible_now ->
                  synthetic_delete = %{
                    "type" => "CHANNEL_DELETE",
                    "guild_id" => state.guild_id,
                    "payload" => %{
                      "id" => cid,
                      "guild_id" => state.guild_id
                    }
                  }

                  send(pid, {:dispatch, synthetic_delete, bus_received_at})
                  MapSet.delete(chans_acc, cid)

                not was_visible and is_visible_now ->
                  synthetic_create = build_synthetic_channel_create(cid, state.guild_id, nil)
                  send(pid, {:dispatch, synthetic_create, bus_received_at})
                  MapSet.put(chans_acc, cid)

                true ->
                  chans_acc
              end
            end)

          updated_sub = %{
            pid: pid,
            user_id: user_id,
            channels: updated_channels
          }

          Map.put(acc, session_id, updated_sub)
        else
          acc
        end
      end)

    %{state | subscribers: new_subscribers}
  end

  defp handle_voice_peer_left_dispatch(event, _bus_received_at, state) do
    payload = event["payload"] || event
    uid = to_string(payload["user_id"] || "")
    leaving_cid = payload["channel_id"]

    case Map.get(state.voice_states, uid) do
      nil ->
        state

      vs ->
        if is_nil(leaving_cid) or to_string(leaving_cid) == to_string(vs.channel_id) do
          if not is_nil(vs.channel_id) do
            Gateway.Metrics.decr_voice_connection()
          end

          new_voice_states = Map.delete(state.voice_states, uid)

          leave_vs = %Gateway.Voice.VoiceState{
            guild_id: state.guild_id,
            channel_id: nil,
            user_id: uid,
            session_id: vs.session_id,
            self_mute: vs.self_mute,
            self_deaf: vs.self_deaf
          }

          fan_out_voice_state_update(leave_vs, vs.channel_id, state)
          %{state | voice_states: new_voice_states}
        else
          state
        end
    end
  end

  defp handle_voice_peer_joined_dispatch(event, _bus_received_at, state) do
    payload = event["payload"] || event
    uid = to_string(payload["user_id"] || "")
    cid = payload["channel_id"]
    sid = payload["session_id"] || ""

    if uid != "" and cid && cid != "" do
      old_vs = Map.get(state.voice_states, uid)
      old_cid = if old_vs, do: old_vs.channel_id, else: nil

      if is_nil(old_cid) do
        Gateway.Metrics.incr_voice_connection()
      end

      new_vs =
        Gateway.Voice.VoiceState.new(%{
          "guild_id" => state.guild_id,
          "channel_id" => to_string(cid),
          "user_id" => uid,
          "session_id" => if(sid != "", do: to_string(sid), else: (old_vs && old_vs.session_id) || ""),
          "self_mute" => (old_vs && old_vs.self_mute) || false,
          "self_deaf" => (old_vs && old_vs.self_deaf) || false
        })

      new_voice_states = Map.put(state.voice_states, uid, new_vs)
      fan_out_voice_state_update(new_vs, old_cid, state)
      %{state | voice_states: new_voice_states}
    else
      state
    end
  end

  defp handle_channel_scoped_dispatch(event, bus_received_at, state) do
    channel_id = extract_channel_id(event)

    Enum.each(state.subscribers, fn {session_id, sub} ->
      {pid, user_id, _visible_channels} = normalize_subscriber(session_id, sub, state.guild_id)

      if can_subscriber_view?(user_id, channel_id, state.guild_id) do
        send(pid, {:dispatch, event, bus_received_at})
      end
    end)
  end

  defp handle_broadcast_dispatch(event, bus_received_at, state) do
    Enum.each(state.subscribers, fn {_session_id, sub} ->
      pid =
        case sub do
          %{pid: p} -> p
          {p, _uid} -> p
          p when is_pid(p) -> p
        end

      send(pid, {:dispatch, event, bus_received_at})
    end)
  end

  defp build_synthetic_channel_create(channel_id, guild_id, fallback_event) do
    cid = to_string(channel_id)
    gid = to_string(guild_id)

    channel_data =
      case Gateway.Guild.Cache.get_channel(cid) do
        {:ok, chan} ->
          chan

        _ ->
          event_payload =
            if fallback_event do
              payload = Map.get(fallback_event, "payload") || %{}
              payload["channel"] || fallback_event["channel"] || payload
            else
              %{}
            end

          %{
            "id" => cid,
            "guild_id" => gid,
            "name" => to_string(event_payload["name"] || event_payload[:name] || "channel"),
            "type" => event_payload["type"] || event_payload[:type] || 0,
            "position" => event_payload["position"] || event_payload[:position] || 0
          }
      end

    overwrites =
      case Gateway.Guild.Cache.get_channel_overwrites(cid) do
        {:ok, ow} -> ow
        _ -> []
      end

    payload =
      channel_data
      |> Map.put("id", cid)
      |> Map.put("guild_id", gid)
      |> Map.put("permission_overwrites", overwrites)

    %{
      "type" => "CHANNEL_CREATE",
      "guild_id" => gid,
      "payload" => payload
    }
  end

  defp extract_channel_id(event) do
    payload = Map.get(event, "payload") || %{}
    message = Map.get(payload, "message") || Map.get(event, "message") || %{}
    channel = Map.get(payload, "channel") || Map.get(event, "channel") || %{}
    type = event["type"] || ""

    cid =
      event["channel_id"] ||
        payload["channel_id"] ||
        message["channel_id"] ||
        channel["id"] ||
        channel[:id] ||
        get_in(event, ["d", "channel_id"]) ||
        if(type in ["CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE"],
          do: payload["id"] || payload[:id] || event["id"] || event[:id],
          else: nil
        )

    case cid do
      nil -> nil
      "" -> nil
      id -> to_string(id)
    end
  end

  defp extract_user_id(event) do
    payload = Map.get(event, "payload") || %{}
    user = payload["user"] || event["user"] || %{}
    uid = user["id"] || user[:id] || payload["user_id"] || event["user_id"]
    if uid, do: to_string(uid), else: ""
  end

  defp normalize_subscriber(session_id, %{pid: pid, user_id: user_id, channels: channels}, guild_id) do
    uid =
      if user_id && user_id != "" do
        to_string(user_id)
      else
        case Gateway.Guild.Cache.get_session_user(session_id) do
          {:ok, u} -> to_string(u)
          _ -> nil
        end
      end

    chans =
      cond do
        channels != nil ->
          channels

        uid != nil ->
          compute_visible_channels(uid, guild_id)

        true ->
          MapSet.new()
      end

    {pid, uid, chans}
  end

  defp normalize_subscriber(session_id, {pid, user_id}, guild_id) do
    normalize_subscriber(session_id, %{pid: pid, user_id: user_id, channels: nil}, guild_id)
  end

  defp normalize_subscriber(session_id, pid, guild_id) when is_pid(pid) do
    normalize_subscriber(session_id, %{pid: pid, user_id: nil, channels: nil}, guild_id)
  end

  defp compute_visible_channels(nil, _guild_id), do: MapSet.new()

  defp compute_visible_channels(user_id, guild_id) do
    guild_id
    |> Gateway.Guild.Cache.list_guild_channels()
    |> Enum.filter(fn chan ->
      cid = to_string(chan["id"] || chan[:id])
      can_subscriber_view?(user_id, cid, guild_id)
    end)
    |> Enum.map(fn chan -> to_string(chan["id"] || chan[:id]) end)
    |> MapSet.new()
  end

  defp can_subscriber_view?(nil, _channel_id, _guild_id), do: false
  defp can_subscriber_view?(_user_id, nil, _guild_id), do: false

  defp can_subscriber_view?(user_id, channel_id, guild_id) do
    Gateway.Permissions.can_view?(user_id, channel_id, guild_id)
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Map.pop(state.subscriber_refs, ref) do
      {nil, _refs} ->
        {:noreply, state}

      {session_id, new_refs} ->
        new_subscribers = Map.delete(state.subscribers, session_id)
        state = cleanup_voice_state_for_session(session_id, %{state | subscribers: new_subscribers, subscriber_refs: new_refs})

        # Phase 7d Step 5c: same pending cleanup as explicit unsubscribe.
        pending_voice_intents =
          Map.reject(state.pending_voice_intents, fn {_uid, {sid, _}} -> sid == session_id end)

        state = %{state | pending_voice_intents: pending_voice_intents}

        ttl_timer =
          if map_size(new_subscribers) == 0 do
            Process.send_after(self(), :ttl_check, state.ttl_ms)
          else
            state.ttl_timer
          end

        {:noreply, %{state | ttl_timer: ttl_timer}}
    end
  end

  def handle_info(:lease_renew, state) do
    {lease_held, lease_timer} = refresh_lease(state.guild_id, state.lease_held)

    if lease_held != state.lease_held do
      if lease_held do
        Gateway.Metrics.incr_lease_acquired()
        Logger.info("Gateway.Guild.Actor [#{state.guild_id}] acquired dispatch lease")
      else
        Gateway.Metrics.incr_lease_lost()
        Logger.warning("Gateway.Guild.Actor [#{state.guild_id}] lost dispatch lease; dispatch paused")
      end
    end

    state = %{state | lease_held: lease_held, lease_timer: lease_timer}

    # Phase 7d Step 5c: flush stashed Tier 1 intents the moment the lease is
    # acquired. Guards re-run at apply time (absent/perms/liveness), so a
    # browser Op 4 or unsubscribe that landed meanwhile wins.
    state =
      if lease_held and map_size(state.pending_voice_intents) > 0 do
        pending = state.pending_voice_intents
        state = %{state | pending_voice_intents: %{}}

        Enum.reduce(pending, state, fn {uid, {session_id, intent}}, acc ->
          apply_voice_intent(acc, session_id, uid, intent)
        end)
      else
        state
      end

    {:noreply, state}
  end

  def handle_info(:ttl_check, state) do
    if map_size(state.subscribers) == 0 do
      Logger.debug("Gateway.Guild.Actor [#{state.guild_id}] stopping: 0 subscribers after TTL")
      {:stop, :normal, state}
    else
      {:noreply, %{state | ttl_timer: nil}}
    end
  end

  # Phase 7d Step 4: SFU liveness transition from the local SfuHealth poller.
  # Null-then-reallocate, scoped to sessions whose channel was placed on the
  # dead endpoint. Lease-gated like dispatch: a stale (SIGSTOPped) actor must
  # not park healthy clients. Late flips (poller declaring death for an SFU
  # the channel already left via the confirm fast lane) still push — the
  # null carries dead_endpoint so already-moved clients ignore it (Step 4
  # stale-null guard, client side).
  def handle_info({:sfu_down, endpoint}, state) do
    Logger.info("Gateway.Guild.Actor [#{state.guild_id}] received :sfu_down for #{endpoint} (lease_held=#{state.lease_held}, voice_sessions=#{map_size(state.voice_states)})")

    if state.lease_held do
      {:noreply, failover_sfu(state, endpoint)}
    else
      Gateway.Metrics.incr_lease_drop()
      {:noreply, state}
    end
  end

  # Recovery needs no push: the endpoint is live again, and any client that
  # failed over already re-requested onto it (or is parked waiting — its
  # Step 4 timeout solicits). A fresh Op 4 always answers from the live
  # list, so :sfu_up is informational only.
  def handle_info({:sfu_up, _endpoint}, state) do
    {:noreply, state}
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    Gateway.Metrics.decr_guild_actor()
    active_voice_count = Enum.count(state.voice_states, fn {_uid, vs} -> not is_nil(vs.channel_id) end)
    if active_voice_count > 0 do
      Gateway.Metrics.decr_voice_connection(active_voice_count)
    end
    cancel_timer(state.ttl_timer)
    if state[:lease_timer], do: cancel_timer(state.lease_timer)
    # Best-effort: let the next holder claim immediately instead of
    # waiting out the TTL.
    Gateway.Guild.Lease.release(state.guild_id)
    Logger.debug("Gateway.Guild.Actor [#{state.guild_id}] terminated")
    :ok
  end

  # ── Lease lifecycle (Phase 7c) ─────────────────────────────────────────

  @lease_renew_ms 3_000

  # Try renew-then-acquire so both fresh actors and losers converge.
  # Redis unreachable → hold (fail-open): duplicates during a joint
  # Redis+split-brain outage beat a silent guild; logged loudly.
  defp refresh_lease(guild_id, _previously_held) do
    held =
      case Gateway.Guild.Lease.renew(guild_id) do
        :ok ->
          true

        {:error, :lost} ->
          case Gateway.Guild.Lease.acquire(guild_id) do
            :ok ->
              true

            {:error, :taken} ->
              Logger.debug("Gateway.Guild.Actor [#{guild_id}] lease held elsewhere; waiting")
              false

            {:error, :unavailable} ->
              Logger.warning("Gateway.Guild.Actor [#{guild_id}] lease store unavailable; dispatching fail-open")
              true
          end

        {:error, :unavailable} ->
          Logger.warning("Gateway.Guild.Actor [#{guild_id}] lease store unavailable; dispatching fail-open")
          true
      end

    {held, Process.send_after(self(), :lease_renew, @lease_renew_ms)}
  end

  # ── Internal Helpers ────────────────────────────────────────────────────────

  # Phase 7d Step 5c (Tier 1): guarded voice-intent apply. Rules:
  #
  # 1. Absent — only when the actor holds no entry for this user. A browser
  #    Op 4 arriving first wins automatically (map keyed by user_id).
  # 2. Lease — only while holding the dispatch lease. Otherwise the intent
  #    is STASHED as pending and applied on the lease-acquired transition
  #    (a fresh post-kill actor resubscribes at +0.7s but holds the lease
  #    only at ~+9s — dropping here would neuter Tier 1 in exactly the
  #    scenario it was built for).
  # 3. Perms — same can_view/can_connect re-check as a fresh Op 4.
  # 4. Stamp — session_id comes from the subscribing call, never the push.
  # 5. Liveness — the subscribing session must still be registered (a dead
  #    session's pending entry is dropped, never applied).
  defp apply_voice_intent(state, session_id, uid, intent) do
    with intent when not is_nil(intent) <- normalize_push_intent(intent),
         uid when not is_nil(uid) <- uid,
         false <- intent_present?(state, uid) do
      if state.lease_held do
        do_apply_voice_intent(state, session_id, uid, intent)
      else
        %{state | pending_voice_intents: Map.put(state.pending_voice_intents, uid, {session_id, intent})}
      end
    else
      _ -> state
    end
  end

  defp intent_present?(state, uid), do: Map.has_key?(state.voice_states, uid)

  defp normalize_push_intent(intent) when is_map(intent) do
    case intent[:channel_id] || intent["channel_id"] do
      nil -> nil
      "" -> nil
      cid ->
        %{
          channel_id: to_string(cid),
          self_mute: intent[:self_mute] == true or intent["self_mute"] == true,
          self_deaf: intent[:self_deaf] == true or intent["self_deaf"] == true
        }
    end
  end

  defp normalize_push_intent(_), do: nil

  defp do_apply_voice_intent(state, session_id, uid, intent) do
    cid = intent.channel_id

    with {:channel, {:ok, %{"type" => type}}} when type in [2, :voice, "2"] <-
           {:channel, Gateway.Guild.Cache.get_channel(cid)},
         true <- can_subscriber_view?(uid, cid, state.guild_id),
         true <- Gateway.Permissions.can_connect?(uid, cid, state.guild_id),
         {:subscriber, %{}} <- {:subscriber, Map.get(state.subscribers, session_id)} do
      new_vs =
        Gateway.Voice.VoiceState.new(%{
          guild_id: state.guild_id,
          channel_id: cid,
          user_id: uid,
          session_id: session_id,
          self_mute: intent.self_mute,
          self_deaf: intent.self_deaf
        })

      Gateway.Metrics.incr_voice_connection()
      Gateway.Metrics.incr_voice_intent_apply()

      new_voice_states = Map.put(state.voice_states, uid, new_vs)
      fan_out_voice_state_update(new_vs, nil, %{state | voice_states: new_voice_states})
      dispatch_voice_server_update(session_id, cid, %{state | voice_states: new_voice_states})

      %{state | voice_states: new_voice_states}
    else
      _ ->
        Gateway.Metrics.incr_voice_intent_drop(drop_reason(state, session_id, uid, cid))
        state
    end
  end

  defp drop_reason(state, session_id, uid, cid) do
    cond do
      not Map.has_key?(state.subscribers, session_id) -> "gone"
      match?({:ok, _}, Gateway.Guild.Cache.get_channel(cid)) == false -> "no_channel"
      not can_subscriber_view?(uid, cid, state.guild_id) -> "denied"
      not Gateway.Permissions.can_connect?(uid, cid, state.guild_id) -> "denied"
      true -> "denied"
    end
  end

  defp fan_out_voice_state_update(vs, old_cid, state) do
    now = System.monotonic_time(:microsecond)
    new_cid = vs.channel_id

    Enum.each(state.subscribers, fn {session_id, sub} ->
      {pid, user_id, _visible_channels} = normalize_subscriber(session_id, sub, state.guild_id)

      cond do
        new_cid != nil and can_subscriber_view?(user_id, new_cid, state.guild_id) ->
          event = %{
            "type" => "VOICE_STATE_UPDATE",
            "guild_id" => state.guild_id,
            "payload" => Gateway.Voice.VoiceState.to_map(vs)
          }

          send(pid, {:dispatch, event, now})

        old_cid != nil and can_subscriber_view?(user_id, old_cid, state.guild_id) ->
          payload =
            vs
            |> Gateway.Voice.VoiceState.to_map()
            |> Map.put("channel_id", nil)

          synthetic_disconnect = %{
            "type" => "VOICE_STATE_UPDATE",
            "guild_id" => state.guild_id,
            "payload" => payload
          }

          send(pid, {:dispatch, synthetic_disconnect, now})

        true ->
          :ok
      end
    end)
  end

  defp cleanup_voice_state_for_session(session_id, state) do
    case Enum.find(state.voice_states, fn {_uid, vs} -> vs.session_id == session_id end) do
      {uid, vs} ->
        if not is_nil(vs.channel_id) do
          Gateway.Metrics.decr_voice_connection()
        end

        new_voice_states = Map.delete(state.voice_states, uid)

        leave_vs = %Gateway.Voice.VoiceState{
          guild_id: state.guild_id,
          channel_id: nil,
          user_id: uid,
          session_id: session_id,
          self_mute: vs.self_mute,
          self_deaf: vs.self_deaf
        }

        fan_out_voice_state_update(leave_vs, vs.channel_id, state)
        %{state | voice_states: new_voice_states}

      nil ->
        state
    end
  end


  # Phase 7d Step 4: null-then-reallocate for one dead SFU endpoint.
  #
  # A session is affected when its channel hashes onto `dead_endpoint` under
  # the FULL configured pool. The comparison uses the static pool (not the
  # live list): the live list already excludes the dead node, so hashing over
  # it could never identify the victims. Reallocation hashes over the live
  # list, which is where the survivors are.
  #
  # Ordering per session is null first, then the fresh allocation — the
  # client tears down on null and rebuilds on the real endpoint (Step 4b).
  # Both go through the session process (`{:dispatch, ...}`), so a
  # disconnected client replays them in order from its resume buffer.
  defp failover_sfu(state, dead_endpoint) do
    full_pool = Gateway.Voice.Placement.endpoints()
    live = Gateway.Voice.Placement.live_endpoints()

    affected =
      state.voice_states
      |> Enum.filter(fn {_uid, vs} ->
        not is_nil(vs.channel_id) and
          Gateway.Voice.Placement.select(vs.channel_id, full_pool) == dead_endpoint
      end)

    if affected == [] do
      state
    else
      Logger.info(
        "Gateway.Guild.Actor [#{state.guild_id}] failing over #{length(affected)} voice session(s) off dead SFU #{dead_endpoint}"
      )

      Gateway.Metrics.incr_sfu_failover(length(affected))

      for {_uid, vs} <- affected do
        push_voice_server_update(state, vs.session_id, vs.channel_id, nil, dead_endpoint)

        new_endpoint = Gateway.Voice.Placement.select(vs.channel_id, live)
        push_voice_server_update(state, vs.session_id, vs.channel_id, new_endpoint)
      end

      state
    end
  end

  # Shared emitter: `endpoint == nil` is the Discord-shaped "tear down and
  # wait" signal; any other value is a (re)allocation. Token is minted fresh
  # per push (5-min TTL — a reallocation arriving a minute after the null
  # must still verify at the SFU).
  #
  # Null pushes carry `dead_endpoint` so a client that already failed over
  # via the confirm fast lane can tell a STALE null ("the SFU you left
  # died") from an ACTIONABLE one ("the SFU you're on died") and ignore
  # the former instead of flapping a healthy transport. Absent on
  # (re)allocations and legacy pushes — clients treat a missing field as
  # actionable (park), preserving old behavior.
  defp push_voice_server_update(state, session_id, channel_id, endpoint, dead_endpoint \\ nil) do
    Gateway.Metrics.incr_voice_server_update()

    case Map.get(state.subscribers, session_id) do
      sub when not is_nil(sub) ->
        {pid, user_id, _visible} = normalize_subscriber(session_id, sub, state.guild_id)

        jwt_secret =
          Application.get_env(
            :gateway,
            :jwt_secret,
            System.get_env("JWT_SECRET", "dev-jwt-secret-change-me")
          )

        token = Gateway.Auth.JWT.issue_voice_token(user_id, state.guild_id, channel_id, jwt_secret)

        payload =
          %{
            "guild_id" => state.guild_id,
            "channel_id" => channel_id,
            "endpoint" => endpoint,
            "token" => token
          }
          |> maybe_put_dead_endpoint(endpoint, dead_endpoint)

        event = %{
          "type" => "VOICE_SERVER_UPDATE",
          "guild_id" => state.guild_id,
          "payload" => payload
        }

        send(pid, {:dispatch, event, System.monotonic_time(:microsecond)})

      nil ->
        :ok
    end
  end

  defp maybe_put_dead_endpoint(payload, nil, dead) when is_binary(dead) do
    Map.put(payload, "dead_endpoint", dead)
  end

  defp maybe_put_dead_endpoint(payload, _endpoint, _dead), do: payload

  defp dispatch_voice_server_update(session_id, channel_id, state, confirm? \\ false) do
    # Phase 7d: placement over the LIVE list (SfuHealth excludes dead nodes
    # out-of-band). Falls back to the static pool — and thence to the legacy
    # single endpoint — when the poller isn't running.
    live = Gateway.Voice.Placement.live_endpoints()
    candidate = Gateway.Voice.Placement.select(channel_id, live)

    endpoint =
      if confirm? do
        confirm_candidate(channel_id, candidate, live)
      else
        candidate
      end

    push_voice_server_update(state, session_id, channel_id, endpoint)
  end

  # Step 6a: demand-path confirmation for re-requests. Asks the poller for a
  # fresh verdict on the candidate; a confirmed-dead candidate is excluded
  # for THIS answer (the threshold machinery + Step 4 null-push proceed
  # independently for everyone else). Bounded (~1.5s probe + margin) and
  # fail-open: any poller trouble answers the candidate (today's behavior).
  @confirm_timeout_ms 2_500

  defp confirm_candidate(channel_id, candidate, live) do
    case Gateway.Voice.SfuHealth.confirm(Gateway.Voice.SfuHealth, candidate, @confirm_timeout_ms) do
      {:ok, true} ->
        candidate

      {:ok, false} ->
        Gateway.Metrics.incr_voice_placement_exclusion()
        Gateway.Voice.Placement.exclude(channel_id, candidate, live)

      {:error, _} ->
        candidate
    end
  catch
    :exit, _ -> candidate
  end

  defp cancel_timer(nil), do: :ok

  defp cancel_timer(timer) when is_reference(timer) do
    if Process.read_timer(timer) do
      Process.cancel_timer(timer)
    end

    :ok
  end
end


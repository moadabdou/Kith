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
  def subscribe(guild_id, session_id, pid \\ nil, user_id \\ nil) do
    target_pid = pid || self()

    case get_or_spawn(guild_id) do
      {:ok, actor_pid} ->
        GenServer.call(actor_pid, {:subscribe, session_id, target_pid, user_id})

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

  @doc """
  Relays a voice signaling packet (offer, answer, or candidate) to a peer in the same voice channel.
  """
  def voice_signaling(guild_id, from_user_id, data) do
    case whereis(guild_id) do
      pid when is_pid(pid) ->
        GenServer.call(pid, {:voice_signaling, from_user_id, data})

      nil ->
        {:error, :guild_not_found}
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
      ttl_timer: ttl_timer,
      voice_states: %{}
    }

    Logger.debug("Gateway.Guild.Actor [#{guild_id}] started")
    {:ok, state}
  end

  @impl true
  def handle_call({:subscribe, session_id, pid}, from, state) do
    handle_call({:subscribe, session_id, pid, nil}, from, state)
  end

  def handle_call({:subscribe, session_id, pid, user_id}, _from, state) do
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

    sub_info = %{
      pid: pid,
      user_id: uid,
      channels: if(uid, do: compute_visible_channels(uid, state.guild_id), else: nil)
    }

    subscribers = Map.put(state.subscribers, session_id, sub_info)
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
    state = cleanup_voice_state_for_session(session_id, %{state | subscribers: subscribers, subscriber_refs: subscriber_refs})

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

    cond do
      cid != nil ->
        case Gateway.Guild.Cache.get_channel(cid) do
          {:ok, %{"type" => type}} when type in [2, :voice, "2"] ->
            can_view = can_subscriber_view?(uid, cid, state.guild_id)
            can_connect = Gateway.Permissions.can_connect?(uid, cid, state.guild_id)

            if can_view and can_connect do
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
              dispatch_voice_server_update(sid, cid, state)
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
          {:reply, :ok, state}
        end
    end
  end

  def handle_call(:get_voice_states, _from, state) do
    {:reply, state.voice_states, state}
  end

  def handle_call({:voice_signaling, from_user_id, data}, _from, state) do
    sender_uid = to_string(from_user_id)
    target_uid = to_string(data["to_user_id"] || data[:to_user_id])
    target_cid = to_string(data["channel_id"] || data[:channel_id])

    sender_vs = Map.get(state.voice_states, sender_uid)
    target_vs = Map.get(state.voice_states, target_uid)

    cond do
      is_nil(sender_vs) or sender_vs.channel_id != target_cid ->
        {:reply, {:error, :sender_not_in_channel}, state}

      is_nil(target_vs) or target_vs.channel_id != target_cid ->
        {:reply, {:error, :target_not_in_channel}, state}

      true ->
        recipient_sid = target_vs.session_id

        case Map.get(state.subscribers, recipient_sid) do
          sub when not is_nil(sub) ->
            {pid, _uid, _vis} = normalize_subscriber(recipient_sid, sub, state.guild_id)

            sig_event = %{
              "type" => "VOICE_SIGNALING",
              "op" => 12,
              "guild_id" => state.guild_id,
              "payload" => %{
                "guild_id" => state.guild_id,
                "channel_id" => target_cid,
                "from_user_id" => sender_uid,
                "type" => data["type"] || data[:type],
                "payload" => data["payload"] || data[:payload] || data["signal"] || data[:signal]
              }
            }

            send(pid, {:dispatch, sig_event, System.monotonic_time(:microsecond)})
            {:reply, :ok, state}

          _ ->
            {:reply, {:error, :recipient_session_not_found}, state}
        end
    end
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

        ttl_timer =
          if map_size(new_subscribers) == 0 do
            Process.send_after(self(), :ttl_check, state.ttl_ms)
          else
            state.ttl_timer
          end

        {:noreply, %{state | ttl_timer: ttl_timer}}
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
          synthetic_disconnect = %{
            "type" => "VOICE_STATE_UPDATE",
            "guild_id" => state.guild_id,
            "payload" => %{
              "guild_id" => state.guild_id,
              "channel_id" => nil,
              "user_id" => vs.user_id,
              "session_id" => vs.session_id
            }
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


  defp dispatch_voice_server_update(session_id, channel_id, state) do
    case Map.get(state.subscribers, session_id) do
      sub when not is_nil(sub) ->
        {pid, _user_id, _visible} = normalize_subscriber(session_id, sub, state.guild_id)

        endpoint =
          Application.get_env(
            :gateway,
            :voice_endpoint,
            System.get_env("VOICE_ENDPOINT", "127.0.0.1:5000")
          )

        token = :crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower)

        event = %{
          "type" => "VOICE_SERVER_UPDATE",
          "guild_id" => state.guild_id,
          "payload" => %{
            "guild_id" => state.guild_id,
            "channel_id" => channel_id,
            "endpoint" => endpoint,
            "token" => token
          }
        }

        send(pid, {:dispatch, event, System.monotonic_time(:microsecond)})

      nil ->
        :ok
    end
  end

  defp cancel_timer(nil), do: :ok

  defp cancel_timer(timer) when is_reference(timer) do
    if Process.read_timer(timer) do
      Process.cancel_timer(timer)
    end

    :ok
  end
end


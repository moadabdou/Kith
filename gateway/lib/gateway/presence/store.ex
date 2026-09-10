defmodule Gateway.Presence.Store do
  @moduledoc """
  In-memory ETS presence store for gateway nodes (plan/05 §1 & #30).

  Presence is strictly ephemeral and node-local. This GenServer owns the
  `:gateway_presence_store` ETS table and supervises session process monitors.
  Read APIs (`get_presence`, `get_presences`, `list_online`) execute directly
  against ETS in the caller process with `read_concurrency: true`, achieving
  linear scaling across scheduler cores without mailbox bottlenecks.
  """

  use GenServer
  require Logger

  @table :gateway_presence_store
  @default_idle_threshold_ms 10 * 60 * 1000
  @default_sweep_interval_ms 30 * 1000

  # ── Client API ─────────────────────────────────────────────────────────────

  @doc """
  Starts the Presence.Store GenServer.
  """
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Registers or updates a user session presence.
  `session_pid` is optionally monitored to automatically clean up the session
  when the Gateway.Session actor terminates.
  """
  def put_presence(user_id, status, client_status, session_id, ws_pid, session_pid \\ nil) do
    case GenServer.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        uid = to_string(user_id)
        sid = to_string(session_id)
        GenServer.call(__MODULE__, {:put_presence, uid, status, client_status, sid, ws_pid, session_pid})

      nil ->
        {:error, :not_running}
    end
  end

  @doc """
  Lifecycle callback invoked when a new session connects or attaches (plan/05 §1 & #31).
  Registers the session in `Presence.Store` with its initial status, client platform details,
  and optionally monitors `session_pid` (the `Gateway.Session` actor).
  """
  def session_connected(user_id, session_id, ws_pid, initial_status \\ :online, client_status \\ %{}, session_pid \\ nil) do
    put_presence(user_id, initial_status, client_status, session_id, ws_pid, session_pid)
  end

  @doc """
  Lifecycle callback invoked when a session disconnects or terminates (plan/05 §1 & #31).
  Removes the session from the user's active session map in `Presence.Store`.
  If no sessions remain, transitions the user to `:offline`.
  """
  def session_disconnected(user_id, session_id) do
    drop_session(user_id, session_id)
  end

  @doc """
  Direct ETS point lookup for a single user's presence.
  Executed in caller process.
  """
  def get_presence(user_id) do
    uid = to_string(user_id)

    case :ets.lookup(@table, uid) do
      [{^uid, status, client_status, last_activity_at, sessions_map}] ->
        agg_activities =
          sessions_map
          |> Map.values()
          |> Enum.flat_map(fn s -> Map.get(s, :activities, []) end)

        {:ok,
         %{
           user_id: uid,
           status: status,
           client_status: client_status,
           last_activity_at: last_activity_at,
           sessions: sessions_map,
           activities: agg_activities
         }}

      [] ->
        {:error, :not_found}
    end
  end

  @doc """
  Direct ETS batched point lookups for multiple users (e.g. guild chunks).
  Executed in caller process, returning `%{user_id => presence_map}`.
  """
  def get_presences(user_ids) when is_list(user_ids) do
    Enum.reduce(user_ids, %{}, fn user_id, acc ->
      case get_presence(user_id) do
        {:ok, presence} -> Map.put(acc, presence.user_id, presence)
        {:error, :not_found} -> acc
      end
    end)
  end

  @doc """
  Returns all online/idle/dnd users currently present in the store.
  Executed directly against ETS via `:ets.select/2`.
  Used for sweepers (idle/zombie eviction) and metrics.
  """
  def list_online do
    match_spec = [
      {{:"$1", :"$2", :"$3", :"$4", :"$5"},
       [{:"/=", :"$2", :offline}, {:"/=", :"$2", "offline"}],
       [{{:"$1", :"$2", :"$3", :"$4", :"$5"}}]}
    ]

    :ets.select(@table, match_spec)
    |> Enum.map(fn {uid, status, client_status, last_activity, sessions} ->
      %{
        user_id: uid,
        status: status,
        client_status: client_status,
        last_activity_at: last_activity,
        sessions: sessions
      }
    end)
  end

  @doc """
  Updates `last_activity_at` for a given user and session (e.g. on heartbeat).
  """
  def touch_activity(user_id, session_id, timestamp \\ nil) do
    case GenServer.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        uid = to_string(user_id)
        sid = to_string(session_id)
        ts = timestamp || System.system_time(:millisecond)
        GenServer.call(__MODULE__, {:touch_activity, uid, sid, ts})

      nil ->
        {:error, :not_running}
    end
  end

  @doc """
  Explicitly updates a session's declared presence status, activities, and AFK flag (plan/01 §3 & #33).
  Status `"invisible"` is mapped to `:offline` for public visibility while retaining actual session state.
  """
  def update_status(user_id, session_id, status, activities \\ [], afk \\ false, since \\ nil) do
    case GenServer.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        uid = to_string(user_id)
        sid = to_string(session_id)
        GenServer.call(__MODULE__, {:update_status, uid, sid, status, activities, afk, since})

      nil ->
        {:error, :not_running}
    end
  end

  @doc """
  Explicitly removes a session from a user's active session map.
  If no sessions remain, user status transitions to `:offline`.
  """
  def drop_session(user_id, session_id) do
    case GenServer.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        uid = to_string(user_id)
        sid = to_string(session_id)
        GenServer.call(__MODULE__, {:drop_session, uid, sid})

      nil ->
        :ok
    end
  end

  @doc """
  Triggers a synchronous idle sweep over active sessions.
  Marks sessions inactive for longer than `threshold_ms` (defaults to configured idle_threshold_ms)
  as `:idle`. Used by periodic sweeper and unit tests.
  """
  def sweep_idle(threshold_ms \\ nil) do
    case GenServer.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        GenServer.call(__MODULE__, {:sweep_idle, threshold_ms})

      nil ->
        {:error, :not_running}
    end
  end

  @doc """
  Returns the name of the managed ETS table.
  """
  def table_name, do: @table

  # ── GenServer Callbacks ─────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    table =
      :ets.new(@table, [
        :named_table,
        :set,
        :public,
        read_concurrency: true,
        write_concurrency: true
      ])

    idle_threshold_ms = Keyword.get(opts, :idle_threshold_ms, @default_idle_threshold_ms)
    sweep_interval_ms = Keyword.get(opts, :sweep_interval_ms, @default_sweep_interval_ms)

    sweep_timer =
      if sweep_interval_ms > 0 do
        Process.send_after(self(), :sweep_idle, sweep_interval_ms)
      else
        nil
      end

    state = %{
      table: table,
      # monitor_ref => {user_id, session_id}
      monitors: %{},
      # {user_id, session_id} => monitor_ref
      session_monitors: %{},
      idle_threshold_ms: idle_threshold_ms,
      sweep_interval_ms: sweep_interval_ms,
      sweep_timer: sweep_timer
    }

    Logger.info("Gateway.Presence.Store initialized with ETS table #{@table}")
    {:ok, state}
  end

  @impl true
  def handle_call({:put_presence, uid, status, client_status, sid, ws_pid, session_pid}, _from, state) do
    now = System.system_time(:millisecond)
    norm_status = to_status_atom(status)

    # Manage process monitor if session_pid is supplied and alive
    state =
      if is_pid(session_pid) and Process.alive?(session_pid) do
        # Demonitor previous ref for this session if existing
        state = demonitor_session(state, uid, sid)
        ref = Process.monitor(session_pid)
        %{
          state
          | monitors: Map.put(state.monitors, ref, {uid, sid}),
            session_monitors: Map.put(state.session_monitors, {uid, sid}, ref)
        }
      else
        state
      end

    session_entry = %{
      session_id: sid,
      session_pid: session_pid,
      ws_pid: ws_pid,
      status: norm_status,
      declared_status: norm_status,
      activities: [],
      afk: false,
      client_status: client_status || %{},
      last_activity_at: now
    }

    {prev_status, prev_activities, prev_client_status, updated_sessions, agg_status, agg_client_status} =
      case :ets.lookup(@table, uid) do
        [{^uid, prev_s, prev_cs, _prev_ts, sessions_map}] ->
          up_sessions = Map.put(sessions_map, sid, session_entry)
          a_status = resolve_status(up_sessions, norm_status)
          a_cs = resolve_client_status(up_sessions, client_status || %{})
          {prev_s, extract_activities(sessions_map), prev_cs, up_sessions, a_status, a_cs}

        [] ->
          up_sessions = %{sid => session_entry}
          {:offline, [], %{}, up_sessions, norm_status, client_status || %{}}
      end

    :ets.insert(@table, {uid, agg_status, agg_client_status, now, updated_sessions})
    new_activities = extract_activities(updated_sessions)

    maybe_broadcast_change(
      uid,
      {prev_status, prev_activities, prev_client_status},
      {agg_status, new_activities, agg_client_status}
    )

    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:touch_activity, uid, sid, ts}, _from, state) do
    now = System.system_time(:millisecond)

    case :ets.lookup(@table, uid) do
      [{^uid, prev_status, client_status, _last_activity, sessions_map}] ->
        prev_activities = extract_activities(sessions_map)

        updated_sessions =
          case Map.get(sessions_map, sid) do
            nil ->
              sessions_map

            entry ->
              # If session was automatically marked :idle and touch is fresh, wake back up to :online.
              # If user manually declared :idle, do not auto-wake.
              new_status =
                if entry.status == :idle and Map.get(entry, :declared_status, :online) != :idle and
                     now - ts < state.idle_threshold_ms do
                  :online
                else
                  entry.status
                end

              Map.put(sessions_map, sid, %{entry | last_activity_at: ts, status: new_status})
          end

        agg_status = resolve_status(updated_sessions, prev_status)
        :ets.insert(@table, {uid, agg_status, client_status, ts, updated_sessions})
        new_activities = extract_activities(updated_sessions)

        maybe_broadcast_change(
          uid,
          {prev_status, prev_activities, client_status},
          {agg_status, new_activities, client_status}
        )

        {:reply, :ok, state}

      [] ->
        {:reply, {:error, :not_found}, state}
    end
  end

  def handle_call({:sweep_idle, custom_threshold_ms}, _from, state) do
    threshold = custom_threshold_ms || state.idle_threshold_ms
    swept_count = do_sweep_idle(state.table, threshold)
    {:reply, {:ok, swept_count}, state}
  end

  @impl true
  def handle_call({:update_status, uid, sid, status, activities, afk, since}, _from, state) do
    declared_atom = to_status_atom(status)
    effective_status = if declared_atom == :invisible, do: :offline, else: declared_atom
    activity_ts = since || System.system_time(:millisecond)

    case :ets.lookup(@table, uid) do
      [{^uid, prev_status, client_status, _prev_ts, sessions_map}] ->
        prev_activities = extract_activities(sessions_map)

        updated_sessions =
          case Map.get(sessions_map, sid) do
            nil ->
              sessions_map

            entry ->
              updated_entry = %{
                entry
                | status: effective_status,
                  declared_status: declared_atom,
                  activities: if(is_list(activities), do: activities, else: []),
                  afk: afk == true,
                  last_activity_at: activity_ts
              }

              Map.put(sessions_map, sid, updated_entry)
          end

        agg_status = resolve_status(updated_sessions, :offline)
        :ets.insert(@table, {uid, agg_status, client_status, activity_ts, updated_sessions})
        new_activities = extract_activities(updated_sessions)

        maybe_broadcast_change(
          uid,
          {prev_status, prev_activities, client_status},
          {agg_status, new_activities, client_status}
        )

        {:reply, :ok, state}

      [] ->
        {:reply, {:error, :not_found}, state}
    end
  end

  @impl true
  def handle_call({:drop_session, uid, sid}, _from, state) do
    state = demonitor_session(state, uid, sid)
    do_drop_session(uid, sid)
    {:reply, :ok, state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Map.pop(state.monitors, ref) do
      {{uid, sid}, remaining_monitors} ->
        remaining_session_monitors = Map.delete(state.session_monitors, {uid, sid})
        do_drop_session(uid, sid)
        {:noreply, %{state | monitors: remaining_monitors, session_monitors: remaining_session_monitors}}

      {nil, _} ->
        {:noreply, state}
    end
  end

  def handle_info(:sweep_idle, state) do
    do_sweep_idle(state.table, state.idle_threshold_ms)

    sweep_timer =
      if state.sweep_interval_ms > 0 do
        Process.send_after(self(), :sweep_idle, state.sweep_interval_ms)
      else
        nil
      end

    {:noreply, %{state | sweep_timer: sweep_timer}}
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  # ── Private Helpers ─────────────────────────────────────────────────────────

  defp do_sweep_idle(table, threshold_ms) do
    now = System.system_time(:millisecond)

    match_spec = [
      {{:"$1", :"$2", :"$3", :"$4", :"$5"},
       [{:"/=", :"$2", :offline}, {:"/=", :"$2", "offline"}],
       [{{:"$1", :"$2", :"$3", :"$4", :"$5"}}]}
    ]

    records = :ets.select(table, match_spec)

    Enum.reduce(records, 0, fn {uid, prev_status, client_status, last_activity, sessions_map}, acc ->
      prev_activities = extract_activities(sessions_map)

      {any_updated?, updated_sessions, newly_idle} =
        Enum.reduce(sessions_map, {false, %{}, 0}, fn {sid, session}, {changed, acc_sessions, idle_acc} ->
          if session.status == :online and (now - session.last_activity_at >= threshold_ms) do
            updated_session = %{session | status: :idle}
            {true, Map.put(acc_sessions, sid, updated_session), idle_acc + 1}
          else
            {changed, Map.put(acc_sessions, sid, session), idle_acc}
          end
        end)

      if any_updated? do
        agg_status = resolve_status(updated_sessions, :idle)
        :ets.insert(table, {uid, agg_status, client_status, last_activity, updated_sessions})
        new_activities = extract_activities(updated_sessions)

        maybe_broadcast_change(
          uid,
          {prev_status, prev_activities, client_status},
          {agg_status, new_activities, client_status}
        )

        acc + newly_idle
      else
        acc
      end
    end)
  end

  defp do_drop_session(uid, sid) do
    case :ets.lookup(@table, uid) do
      [{^uid, prev_status, prev_client_status, last_activity, sessions_map}] ->
        prev_activities = extract_activities(sessions_map)
        updated_sessions = Map.delete(sessions_map, sid)

        {new_status, new_activities, new_client_status} =
          if map_size(updated_sessions) == 0 do
            # No remaining sessions -> transition to offline
            :ets.insert(@table, {uid, :offline, %{}, last_activity, %{}})
            {:offline, [], %{}}
          else
            # Re-resolve status across remaining sessions
            agg_status = resolve_status(updated_sessions, :offline)
            agg_client_status = resolve_client_status(updated_sessions, %{})
            :ets.insert(@table, {uid, agg_status, agg_client_status, last_activity, updated_sessions})
            {agg_status, extract_activities(updated_sessions), agg_client_status}
          end

        maybe_broadcast_change(
          uid,
          {prev_status, prev_activities, prev_client_status},
          {new_status, new_activities, new_client_status}
        )

      [] ->
        :ok
    end
  end

  defp maybe_broadcast_change(uid, prev_tuple, new_tuple) do
    if prev_tuple != new_tuple do
      {new_status, new_activities, new_client_status} = new_tuple
      Gateway.Presence.Broadcaster.broadcast(uid, new_status, new_activities, new_client_status)
    end
  end

  defp extract_activities(sessions_map) when is_map(sessions_map) do
    sessions_map
    |> Map.values()
    |> Enum.flat_map(fn s -> Map.get(s, :activities, []) end)
  end

  defp extract_activities(_), do: []

  defp demonitor_session(state, uid, sid) do
    case Map.pop(state.session_monitors, {uid, sid}) do
      {nil, _} ->
        state

      {ref, remaining_session_monitors} ->
        Process.demonitor(ref, [:flush])
        remaining_monitors = Map.delete(state.monitors, ref)
        %{state | monitors: remaining_monitors, session_monitors: remaining_session_monitors}
    end
  end

  # Resolves aggregated status by precedence: dnd > online > idle > offline
  defp resolve_status(sessions_map, fallback) when map_size(sessions_map) == 0, do: fallback

  defp resolve_status(sessions_map, _fallback) do
    statuses =
      sessions_map
      |> Map.values()
      |> Enum.map(&to_status_atom(&1.status))

    cond do
      :dnd in statuses -> :dnd
      :online in statuses -> :online
      :idle in statuses -> :idle
      true -> :offline
    end
  end

  defp to_status_atom(s) when is_atom(s), do: s
  defp to_status_atom("dnd"), do: :dnd
  defp to_status_atom("online"), do: :online
  defp to_status_atom("idle"), do: :idle
  defp to_status_atom("invisible"), do: :invisible
  defp to_status_atom("offline"), do: :offline
  defp to_status_atom(_), do: :offline

  defp resolve_client_status(sessions_map, fallback) when map_size(sessions_map) == 0, do: fallback

  defp resolve_client_status(sessions_map, _fallback) do
    Enum.reduce(Map.values(sessions_map), %{}, fn session, acc ->
      case session.client_status do
        cs when is_map(cs) -> Map.merge(acc, cs)
        _ -> acc
      end
    end)
  end
end

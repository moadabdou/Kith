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
    uid = to_string(user_id)
    sid = to_string(session_id)

    GenServer.call(__MODULE__, {:put_presence, uid, status, client_status, sid, ws_pid, session_pid})
  end

  @doc """
  Direct ETS point lookup for a single user's presence.
  Executed in caller process.
  """
  def get_presence(user_id) do
    uid = to_string(user_id)

    case :ets.lookup(@table, uid) do
      [{^uid, status, client_status, last_activity_at, sessions_map}] ->
        {:ok,
         %{
           user_id: uid,
           status: status,
           client_status: client_status,
           last_activity_at: last_activity_at,
           sessions: sessions_map
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
    uid = to_string(user_id)
    sid = to_string(session_id)
    ts = timestamp || System.system_time(:millisecond)

    GenServer.call(__MODULE__, {:touch_activity, uid, sid, ts})
  end

  @doc """
  Explicitly removes a session from a user's active session map.
  If no sessions remain, user status transitions to `:offline`.
  """
  def drop_session(user_id, session_id) do
    uid = to_string(user_id)
    sid = to_string(session_id)

    GenServer.call(__MODULE__, {:drop_session, uid, sid})
  end

  @doc """
  Returns the name of the managed ETS table.
  """
  def table_name, do: @table

  # ── GenServer Callbacks ─────────────────────────────────────────────────────

  @impl true
  def init(_opts) do
    table =
      :ets.new(@table, [
        :named_table,
        :set,
        :public,
        read_concurrency: true,
        write_concurrency: true
      ])

    state = %{
      table: table,
      # monitor_ref => {user_id, session_id}
      monitors: %{},
      # {user_id, session_id} => monitor_ref
      session_monitors: %{}
    }

    Logger.info("Gateway.Presence.Store initialized with ETS table #{@table}")
    {:ok, state}
  end

  @impl true
  def handle_call({:put_presence, uid, status, client_status, sid, ws_pid, session_pid}, _from, state) do
    now = System.system_time(:millisecond)

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
      status: status,
      client_status: client_status,
      last_activity_at: now
    }

    case :ets.lookup(@table, uid) do
      [{^uid, _prev_status, _prev_client_status, _prev_ts, sessions_map}] ->
        updated_sessions = Map.put(sessions_map, sid, session_entry)
        # Determine aggregate status
        agg_status = resolve_status(updated_sessions, status)
        agg_client_status = resolve_client_status(updated_sessions, client_status)
        :ets.insert(@table, {uid, agg_status, agg_client_status, now, updated_sessions})

      [] ->
        sessions_map = %{sid => session_entry}
        :ets.insert(@table, {uid, status, client_status, now, sessions_map})
    end

    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:touch_activity, uid, sid, ts}, _from, state) do
    case :ets.lookup(@table, uid) do
      [{^uid, status, client_status, _last_activity, sessions_map}] ->
        updated_sessions =
          case Map.get(sessions_map, sid) do
            nil ->
              sessions_map

            entry ->
              Map.put(sessions_map, sid, %{entry | last_activity_at: ts})
          end

        :ets.insert(@table, {uid, status, client_status, ts, updated_sessions})
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

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  # ── Private Helpers ─────────────────────────────────────────────────────────

  defp do_drop_session(uid, sid) do
    case :ets.lookup(@table, uid) do
      [{^uid, _status, _client_status, last_activity, sessions_map}] ->
        updated_sessions = Map.delete(sessions_map, sid)

        if map_size(updated_sessions) == 0 do
          # No remaining sessions -> transition to offline
          :ets.insert(@table, {uid, :offline, %{}, last_activity, %{}})
        else
          # Re-resolve status across remaining sessions
          agg_status = resolve_status(updated_sessions, :offline)
          agg_client_status = resolve_client_status(updated_sessions, %{})
          :ets.insert(@table, {uid, agg_status, agg_client_status, last_activity, updated_sessions})
        end

      [] ->
        :ok
    end
  end

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

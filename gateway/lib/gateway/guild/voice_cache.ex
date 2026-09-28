defmodule Gateway.Guild.VoiceCache do
  @moduledoc """
  Shared ETS read path for guild voice states (Issue #90).

  Guild actors (`Gateway.Guild.Actor`, control role only) are the writers:
  every mutation of `state.voice_states` mirrors into this table. WS
  `IDENTIFY` (`Gateway.WS.Handler`) hydrates `READY.voice_states` via direct
  memory lookups instead of N sequential `GenServer.call(:get_voice_states)`
  round-trips.

  Table: `:gateway_voice_states`, `:set`, `:public`,
  `read_concurrency: true, write_concurrency: true`.
  Key: `{guild_id_string, user_id_string}`, value: voice-state map
  (string keys, `VoiceState.to_map/1` shape).
  """

  use GenServer
  require Logger

  @table :gateway_voice_states

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def table_name, do: @table

  @impl true
  def init(_opts) do
    table =
      case :ets.whereis(@table) do
        :undefined ->
          :ets.new(@table, [:named_table, :set, :public, read_concurrency: true, write_concurrency: true])

        _tid ->
          @table
      end

    {:ok, %{table: table}}
  end

  @doc """
  Upserts a voice state. Accepts a `VoiceState` struct or a string-keyed map.
  No-op when `channel_id` is nil (use `delete/2` for leaves).
  """
  def put(guild_id, user_id, vs) do
    do_put(guild_id, user_id, vs)
    replicate(:do_put, [guild_id, user_id, vs])
    :ok
  end

  @doc """
  Removes a user's voice entry for a guild (leave / cleanup).
  """
  def delete(guild_id, user_id) do
    do_delete(guild_id, user_id)
    replicate(:do_delete, [guild_id, user_id])
    :ok
  end

  @doc """
  Clears all voice entries for a guild (actor terminate).
  """
  def clear_guild(guild_id) do
    do_clear_guild(guild_id)
    replicate(:do_clear_guild, [guild_id])
    :ok
  end

  @doc """
  Locally writes an entry into the node's ETS table.
  """
  def do_put(guild_id, user_id, vs) do
    gid = to_string(guild_id)
    uid = to_string(user_id)
    map = to_voice_map(gid, uid, vs)

    if map["channel_id"] do
      ensure_table()
      :ets.insert(@table, {{gid, uid}, map})
    else
      do_delete(gid, uid)
    end

    :ok
  rescue
    _ -> :ok
  end

  @doc """
  Locally removes an entry from the node's ETS table.
  """
  def do_delete(guild_id, user_id) do
    ensure_table()
    :ets.delete(@table, {to_string(guild_id), to_string(user_id)})
    :ok
  rescue
    _ -> :ok
  end

  @doc """
  Locally clears all voice entries for a guild from the node's ETS table.
  """
  def do_clear_guild(guild_id) do
    ensure_table()
    gid = to_string(guild_id)
    :ets.match_delete(@table, {{gid, :_}, :_})
    :ok
  rescue
    _ -> :ok
  end

  defp replicate(func, args) do
    case Node.list() do
      [] ->
        :ok

      peers ->
        Task.start(fn ->
          try do
            :erpc.multicall(peers, __MODULE__, func, args, 1000)
          rescue
            _ -> :ok
          catch
            _, _ -> :ok
          end
        end)

        :ok
    end
  end

  @doc """
  Returns `%{user_id => vs_map}` for a guild, direct ETS read in caller.
  """
  def get_guild_states(guild_id) do
    gid = to_string(guild_id)

    case :ets.whereis(@table) do
      :undefined ->
        %{}

      _ ->
        :ets.match_object(@table, {{gid, :_}, :_})
        |> Enum.reduce(%{}, fn {{_g, uid}, vs}, acc -> Map.put(acc, uid, vs) end)
    end
  rescue
    _ -> %{}
  end

  @doc """
  Returns all active voice states in a guild visible to `user_id`,
  matching `Guild.Actor.get_visible_voice_states/2` semantics but lock-free.
  Falls back to warming from the cluster Horde actor if local ETS is empty.
  """
  def get_visible_states(guild_id, user_id) do
    gid = to_string(guild_id)

    states =
      case get_guild_states(gid) do
        map when map_size(map) > 0 ->
          map

        _empty ->
          warm_from_actor(gid)
      end

    states
    |> Map.values()
    |> Enum.filter(fn vs ->
      cid = vs["channel_id"] || vs[:channel_id]
      cid != nil and cid != "" and Gateway.Permissions.can_view?(user_id, to_string(cid), gid)
    end)
    |> Enum.map(&Gateway.Voice.VoiceState.to_map/1)
  rescue
    _ -> []
  end

  defp warm_from_actor(gid) do
    case Gateway.Guild.Actor.whereis(gid) do
      pid when is_pid(pid) and node(pid) != node() ->
        try do
          actor_states = GenServer.call(pid, :get_voice_states, 2000)

          if is_map(actor_states) and map_size(actor_states) > 0 do
            Enum.each(actor_states, fn {uid, vs} ->
              do_put(gid, uid, vs)
            end)

            get_guild_states(gid)
          else
            %{}
          end
        rescue
          _ -> %{}
        catch
          _, _ -> %{}
        end

      _ ->
        %{}
    end
  end

  defp to_voice_map(gid, uid, %Gateway.Voice.VoiceState{} = vs) do
    vs
    |> Gateway.Voice.VoiceState.to_map()
    |> Map.put("guild_id", gid)
    |> Map.put("user_id", uid)
  end

  defp to_voice_map(gid, uid, vs) when is_map(vs) do
    %{
      "guild_id" => gid,
      "channel_id" =>
        case vs[:channel_id] || vs["channel_id"] do
          nil -> nil
          "" -> nil
          cid -> to_string(cid)
        end,
      "user_id" => uid,
      "session_id" => to_string(vs[:session_id] || vs["session_id"] || ""),
      "self_mute" => vs[:self_mute] == true or vs["self_mute"] == true,
      "self_deaf" => vs[:self_deaf] == true or vs["self_deaf"] == true
    }
  end

  defp ensure_table do
    case :ets.whereis(@table) do
      :undefined ->
        try do
          :ets.new(@table, [:named_table, :set, :public, read_concurrency: true, write_concurrency: true])
        rescue
          _ -> @table
        catch
          _, _ -> @table
        end

      _ ->
        @table
    end
  end
end

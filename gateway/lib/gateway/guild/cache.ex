defmodule Gateway.Guild.Cache do
  @moduledoc """
  Read-only ETS cache for guild and channel metadata warmed at IDENTIFY.
  Invalidated/updated via event bus in subsequent issues (plan/01 §7).
  """

  use GenServer
  require Logger

  @table :gateway_guild_cache

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    table = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{table: table}}
  end

  @doc """
  Queries Postgres for the user, member's guilds, and channels,
  warms the local ETS cache, and returns `{:ok, user_map, guilds_list}`.
  """
  def warm_member(user_id) when is_integer(user_id) or is_binary(user_id) do
    uid = if is_binary(user_id), do: String.to_integer(user_id), else: user_id

    case fetch_from_db(uid) do
      {:ok, user, guilds, roles, member_roles, overwrites} ->
        # Cache in ETS
        Enum.each(guilds, fn guild ->
          :ets.insert(@table, {{:guild, guild["id"]}, guild})
          index_guild_channels(guild)

          if guild["nickname"] != nil do
            :ets.insert(@table, {{:member_nick, to_string(user["id"]), guild["id"]}, guild["nickname"]})
          end
        end)

        :ets.insert(@table, {{:user, to_string(user["id"])}, user})

        guild_ids = Enum.map(guilds, & &1["id"])
        :ets.insert(@table, {{:member_guilds, uid}, guild_ids})
        :ets.insert(@table, {{:member_guilds, to_string(uid)}, guild_ids})

        # Cache roles in ETS
        Enum.each(roles, fn r ->
          :ets.insert(@table, {{:role, r["id"]}, r})
        end)

        roles_by_guild = Enum.group_by(roles, & &1["guild_id"])
        Enum.each(roles_by_guild, fn {gid, r_list} ->
          :ets.insert(@table, {{:guild_roles, gid}, r_list})
        end)

        # Cache member roles in ETS
        Enum.each(member_roles, fn {gid, rids} ->
          put_member_roles(to_string(user["id"]), gid, rids)
        end)

        # Cache channel overwrites in ETS
        Enum.each(overwrites, fn {cid, ow_list} ->
          put_channel_overwrites(cid, ow_list)
        end)

        {:ok, user, guilds}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Retrieves cached list of guild_ids for a user.
  Checks ETS by both integer and string key representation.
  Falls back to warm_member/1 if user is numeric but not yet cached in ETS.
  """
  def get_member_guilds(user_id) do
    case lookup_member_guilds(user_id) do
      {:ok, guild_ids} ->
        {:ok, guild_ids}

      :error ->
        case Integer.parse(to_string(user_id)) do
          {int_id, ""} ->
            case warm_member(int_id) do
              {:ok, _user, guilds} -> {:ok, Enum.map(guilds, & &1["id"])}
              {:error, reason} -> {:error, reason}
            end

          _ ->
            {:error, :not_found}
        end
    end
  end

  @doc """
  Directly caches or overrides a user's member guild_ids in ETS.
  Useful for tests and fast updates.
  """
  def put_member_guilds(user_id, guild_ids) when is_list(guild_ids) do
    normalized_guilds = Enum.map(guild_ids, &to_string/1)
    :ets.insert(@table, {{:member_guilds, user_id}, normalized_guilds})

    if is_integer(user_id) do
      :ets.insert(@table, {{:member_guilds, to_string(user_id)}, normalized_guilds})
    else
      case Integer.parse(user_id) do
        {int, ""} -> :ets.insert(@table, {{:member_guilds, int}, normalized_guilds})
        _ -> :ok
      end
    end

    :ok
  end

  defp lookup_member_guilds(user_id) do
    case :ets.lookup(@table, {:member_guilds, user_id}) do
      [{{:member_guilds, _}, guild_ids}] ->
        {:ok, guild_ids}

      [] ->
        alt_key =
          cond do
            is_integer(user_id) -> to_string(user_id)
            is_binary(user_id) ->
              case Integer.parse(user_id) do
                {int, ""} -> int
                _ -> nil
              end
            true -> nil
          end

        if alt_key do
          case :ets.lookup(@table, {:member_guilds, alt_key}) do
            [{{:member_guilds, _}, guild_ids}] -> {:ok, guild_ids}
            [] -> :error
          end
        else
          :error
        end
    end
  end

  @doc """
  Returns true when `user_id` is a member of `guild_id` per cached member guild
  lists (with the usual warm-on-miss fallback).
  """
  def member_of?(user_id, guild_id) do
    case get_member_guilds(user_id) do
      {:ok, guild_ids} -> to_string(guild_id) in Enum.map(guild_ids, &to_string/1)
      _other -> false
    end
  end

  @doc """
  Retrieves cached guild metadata by guild_id.
  """
  def get_guild(guild_id) when is_binary(guild_id) do
    case :ets.lookup(@table, {:guild, guild_id}) do
      [{{:guild, ^guild_id}, guild}] -> {:ok, guild}
      [] -> :error
    end
  end

  def get_guild(guild_id) when is_integer(guild_id), do: get_guild(to_string(guild_id))

  @doc """
  Stores or updates guild metadata in ETS cache.
  """
  def put_guild(%{"id" => guild_id} = guild) do
    :ets.insert(@table, {{:guild, to_string(guild_id)}, guild})
    index_guild_channels(guild)
    :ok
  end

  @doc """
  Resolves the owning guild_id for a channel_id from the ETS channel index.
  Returns `{:ok, guild_id}` or `:error` when the channel is not cached.
  """
  def get_channel_guild(channel_id) when is_binary(channel_id) do
    case :ets.lookup(@table, {:channel, channel_id}) do
      [{{:channel, ^channel_id}, guild_id}] -> {:ok, guild_id}
      [] -> :error
    end
  end

  def get_channel_guild(channel_id) when is_integer(channel_id), do: get_channel_guild(to_string(channel_id))

  @doc """
  Retrieves channel metadata map from ETS cache.
  Returns `{:ok, channel_map}` or `:error`.
  """
  def get_channel(channel_id) do
    cid = to_string(channel_id)

    case :ets.lookup(@table, {:channel_meta, cid}) do
      [{{:channel_meta, ^cid}, chan}] ->
        {:ok, chan}

      [] ->
        case get_channel_guild(cid) do
          {:ok, gid} ->
            case get_guild(gid) do
              {:ok, %{"channels" => channels}} when is_list(channels) ->
                case Enum.find(channels, fn c -> to_string(c["id"]) == cid end) do
                  nil ->
                    :error

                  chan ->
                    chan_with_gid = Map.put(chan, "guild_id", gid)
                    :ets.insert(@table, {{:channel_meta, cid}, chan_with_gid})
                    {:ok, chan_with_gid}
                end

              _ ->
                :error
            end

          _ ->
            :error
        end
    end
  end

  @doc """
  Stores or updates channel metadata in ETS cache.
  """
  def put_channel(%{"id" => channel_id, "guild_id" => guild_id} = channel) do
    cid = to_string(channel_id)
    gid = to_string(guild_id)
    :ets.insert(@table, {{:channel, cid}, gid})
    :ets.insert(@table, {{:channel_meta, cid}, channel})
    :ok
  end

  @doc """
  Returns all channels for a guild from cached guild metadata.
  """
  def list_guild_channels(guild_id) do
    gid = to_string(guild_id)

    guild_chans =
      case get_guild(gid) do
        {:ok, %{"channels" => channels}} when is_list(channels) -> channels
        _ -> []
      end

    meta_chans =
      case :ets.match_object(@table, {{:channel_meta, :_}, :_}) do
        list when is_list(list) ->
          list
          |> Enum.map(fn {{:channel_meta, _}, c} -> c end)
          |> Enum.filter(fn c -> to_string(c["guild_id"] || c[:guild_id]) == gid end)

        _ ->
          []
      end

    (guild_chans ++ meta_chans)
    |> Enum.uniq_by(fn c -> to_string(c["id"] || c[:id]) end)
  end

  @doc """
  Retrieves a cached user map (`%{"id", "username", "discriminator"}`) by
  user_id, warm from IDENTIFY. Returns `{:ok, user}` or `:error`.
  """
  def get_user(user_id) do
    case :ets.lookup(@table, {:user, to_string(user_id)}) do
      [{{:user, _uid}, user}] -> {:ok, user}
      [] -> :error
    end
  end

  @doc """
  Retrieves the user's nickname in a specific guild from cache, or nil.
  Returns `{:ok, nick | nil}` (nil = member has no nickname) or `:error` when
  the user/guild combination is unknown to the cache.
  """
  def get_member_nick(user_id, guild_id) do
    uid = to_string(user_id)
    gid = to_string(guild_id)

    case :ets.lookup(@table, {:member_nick, uid, gid}) do
      [{{:member_nick, _, _}, nick}] ->
        {:ok, nick}

      [] ->
        case :ets.lookup(@table, {:user, uid}) do
          [{_user_key, _}] -> {:ok, nil}
          [] -> :error
        end
    end
  end

  @doc """
  Retrieves cached list of roles for a guild.
  Returns `{:ok, roles_list}`.
  """
  def get_guild_roles(guild_id) do
    gid = to_string(guild_id)

    case :ets.lookup(@table, {:guild_roles, gid}) do
      [{{:guild_roles, ^gid}, roles}] -> {:ok, roles}
      [] -> {:ok, []}
    end
  end

  @doc """
  Stores or updates the list of roles for a guild in ETS cache.
  """
  def put_guild_roles(guild_id, roles) when is_list(roles) do
    gid = to_string(guild_id)

    normalized =
      Enum.map(roles, fn r ->
        %{
          "id" => to_string(Map.get(r, "id") || Map.get(r, :id)),
          "guild_id" => gid,
          "name" => to_string(Map.get(r, "name") || Map.get(r, :name) || ""),
          "position" => Map.get(r, "position") || Map.get(r, :position) || 0,
          "permissions" => Map.get(r, "permissions") || Map.get(r, :permissions) || 0
        }
      end)

    :ets.insert(@table, {{:guild_roles, gid}, normalized})

    Enum.each(normalized, fn r ->
      :ets.insert(@table, {{:role, r["id"]}, r})
    end)

    :ok
  end

  @doc """
  Retrieves cached assigned role IDs for a member in a guild.
  Returns `{:ok, [role_id]}`.
  """
  def get_member_roles(user_id, guild_id) do
    uid = to_string(user_id)
    gid = to_string(guild_id)

    case :ets.lookup(@table, {:member_roles, uid, gid}) do
      [{{:member_roles, ^uid, ^gid}, role_ids}] ->
        {:ok, role_ids}

      [] ->
        case :ets.lookup(@table, {:member_roles, user_id, guild_id}) do
          [{{:member_roles, _, _}, role_ids}] -> {:ok, role_ids}
          [] -> :error
        end
    end
  end

  @doc """
  Stores or updates a member's assigned role IDs in a guild in ETS cache.
  """
  def put_member_roles(user_id, guild_id, role_ids) when is_list(role_ids) do
    uid = to_string(user_id)
    gid = to_string(guild_id)
    normalized = Enum.map(role_ids, &to_string/1)

    :ets.insert(@table, {{:member_roles, uid, gid}, normalized})
    :ets.insert(@table, {{:member_roles, user_id, guild_id}, normalized})
    :ok
  end

  @doc """
  Retrieves cached permission overwrites for a channel.
  Returns `{:ok, overwrites_list}`.
  """
  def get_channel_overwrites(channel_id) do
    cid = to_string(channel_id)

    case :ets.lookup(@table, {:channel_overwrites, cid}) do
      [{{:channel_overwrites, ^cid}, overwrites}] -> {:ok, overwrites}
      [] -> {:ok, []}
    end
  end

  @doc """
  Stores or updates channel permission overwrites in ETS cache.
  """
  def put_channel_overwrites(channel_id, overwrites) when is_list(overwrites) do
    cid = to_string(channel_id)

    normalized =
      Enum.map(overwrites, fn ow ->
        target_id =
          to_string(
            Map.get(ow, "target_id") || Map.get(ow, :target_id) ||
              Map.get(ow, "id") || Map.get(ow, :id) || ""
          )

        target_type =
          Map.get(ow, "target_type") || Map.get(ow, :target_type) ||
            Map.get(ow, "type") || Map.get(ow, :type) || 0

        allow = Map.get(ow, "allow") || Map.get(ow, :allow) || 0
        deny = Map.get(ow, "deny") || Map.get(ow, :deny) || 0

        %{
          "id" => target_id,
          "type" => target_type,
          "channel_id" => cid,
          "target_id" => target_id,
          "target_type" => target_type,
          "allow" => allow,
          "deny" => deny
        }
      end)

    :ets.insert(@table, {{:channel_overwrites, cid}, normalized})
    :ok
  end

  @doc """
  Maps a session ID to its authenticated user ID in ETS cache.
  """
  def put_session_user(session_id, user_id) do
    sid = to_string(session_id)
    uid = to_string(user_id)
    :ets.insert(@table, {{:session_user, sid}, uid})
    :ok
  end

  @doc """
  Retrieves authenticated user ID for a session from ETS cache.
  """
  def get_session_user(session_id) do
    sid = to_string(session_id)

    case :ets.lookup(@table, {:session_user, sid}) do
      [{{:session_user, ^sid}, uid}] -> {:ok, uid}
      [] -> :error
    end
  end

  @doc """
  Handles real-time permission and entity mutation events from the event bus,
  immediately updating ETS tables to prevent TOCTOU permission leaks.
  """
  def handle_event(%{"type" => type} = event) do
    payload = Map.get(event, "payload") || event

    case type do
      "GUILD_ROLE_CREATE" ->
        handle_role_upsert(event, payload)

      "GUILD_ROLE_UPDATE" ->
        handle_role_upsert(event, payload)

      "GUILD_ROLE_DELETE" ->
        handle_role_delete(event, payload)

      "GUILD_MEMBER_UPDATE" ->
        handle_member_update(event, payload)

      "CHANNEL_CREATE" ->
        handle_channel_create(event, payload)

      "CHANNEL_UPDATE" ->
        handle_channel_update(event, payload)

      "CHANNEL_DELETE" ->
        handle_channel_delete(event, payload)

      "GUILD_MEMBER_REMOVE" ->
        handle_member_remove(event, payload)

      _ ->
        :ok
    end
  end

  def handle_event(_), do: :ok

  defp handle_role_upsert(event, payload) do
    gid = to_string(event["guild_id"] || payload["guild_id"])
    role = payload["role"] || event["role"]

    if role && gid != "" do
      role_id = to_string(role["id"] || role[:id])
      pos = role["position"] || role[:position] || 0
      perms = role["permissions"] || role[:permissions] || 0
      name = to_string(role["name"] || role[:name] || "")

      role_map = %{
        "id" => role_id,
        "guild_id" => gid,
        "name" => name,
        "position" => pos,
        "permissions" => perms
      }

      :ets.insert(@table, {{:role, role_id}, role_map})

      {:ok, existing_roles} = get_guild_roles(gid)

      updated_roles =
        case Enum.find_index(existing_roles, fn r -> r["id"] == role_id end) do
          nil -> existing_roles ++ [role_map]
          idx -> List.replace_at(existing_roles, idx, role_map)
        end
        |> Enum.sort_by(& &1["position"], :asc)

      :ets.insert(@table, {{:guild_roles, gid}, updated_roles})
    end

    :ok
  end

  defp handle_role_delete(event, payload) do
    gid = to_string(event["guild_id"] || payload["guild_id"])
    role_id = to_string(payload["role_id"] || event["role_id"])

    if role_id != "" and gid != "" do
      :ets.delete(@table, {:role, role_id})

      {:ok, existing_roles} = get_guild_roles(gid)
      updated_roles = Enum.reject(existing_roles, fn r -> r["id"] == role_id end)
      :ets.insert(@table, {{:guild_roles, gid}, updated_roles})

      records = :ets.match_object(@table, {{:member_roles, :_, gid}, :_})

      Enum.each(records, fn {{:member_roles, uid, ^gid}, rids} ->
        if is_list(rids) and role_id in rids do
          new_rids = List.delete(rids, role_id)
          :ets.insert(@table, {{:member_roles, uid, gid}, new_rids})
        end
      end)
    end

    :ok
  end

  defp handle_member_update(event, payload) do
    gid = to_string(event["guild_id"] || payload["guild_id"])
    user = payload["user"] || event["user"] || %{}
    uid = to_string(user["id"] || user[:id] || payload["user_id"] || event["user_id"])
    roles = payload["roles"] || event["roles"]
    nick = payload["nick"] || event["nick"]

    if uid != "" and gid != "" do
      if is_list(roles) do
        put_member_roles(uid, gid, roles)
      end

      if nick != nil do
        :ets.insert(@table, {{:member_nick, uid, gid}, nick})
      end
    end

    :ok
  end

  defp handle_channel_create(event, payload) do
    channel = payload["channel"] || event["channel"] || payload
    cid = to_string(channel["id"] || channel[:id])
    gid = to_string(channel["guild_id"] || channel[:guild_id] || event["guild_id"] || payload["guild_id"])

    if cid != "" and gid != "" do
      chan_map = %{
        "id" => cid,
        "guild_id" => gid,
        "name" => to_string(channel["name"] || channel[:name] || ""),
        "type" => channel["type"] || channel[:type] || 0,
        "position" => channel["position"] || channel[:position] || 0
      }
      put_channel(chan_map)

      case get_guild(gid) do
        {:ok, guild} ->
          existing = Map.get(guild, "channels") || []
          updated =
            case Enum.find_index(existing, fn c -> to_string(c["id"]) == cid end) do
              nil -> existing ++ [chan_map]
              idx -> List.replace_at(existing, idx, chan_map)
            end
          put_guild(Map.put(guild, "channels", updated))

        _ -> :ok
      end

      overwrites =
        payload["permission_overwrites"] || event["permission_overwrites"] ||
          payload["overwrites"] || event["overwrites"]

      if is_list(overwrites) do
        put_channel_overwrites(cid, overwrites)
      end
    end

    :ok
  end

  defp handle_channel_update(event, payload) do
    channel = payload["channel"] || event["channel"] || payload
    cid = to_string(channel["id"] || channel[:id])
    gid = to_string(channel["guild_id"] || channel[:guild_id] || event["guild_id"] || payload["guild_id"])

    if cid != "" do
      if gid != "" do
        :ets.insert(@table, {{:channel, cid}, gid})
      end

      case get_channel(cid) do
        {:ok, old_chan} ->
          new_chan =
            old_chan
            |> Map.put("name", channel["name"] || old_chan["name"])
            |> Map.put("type", channel["type"] || old_chan["type"])
            |> Map.put("position", channel["position"] || old_chan["position"])

          put_channel(new_chan)

        _ ->
          if gid != "" do
            put_channel(%{
              "id" => cid,
              "guild_id" => gid,
              "name" => to_string(channel["name"] || ""),
              "type" => channel["type"] || 0,
              "position" => channel["position"] || 0
            })
          end
      end

      overwrites =
        payload["permission_overwrites"] || event["permission_overwrites"] ||
          payload["overwrites"] || event["overwrites"]

      if is_list(overwrites) do
        put_channel_overwrites(cid, overwrites)
      end
    end

    :ok
  end

  defp handle_channel_delete(event, payload) do
    channel = payload["channel"] || event["channel"] || payload
    cid = to_string(channel["id"] || channel[:id] || payload["channel_id"] || event["channel_id"])
    gid = to_string(channel["guild_id"] || event["guild_id"] || payload["guild_id"])

    if cid != "" do
      :ets.delete(@table, {:channel, cid})
      :ets.delete(@table, {:channel_meta, cid})
      :ets.delete(@table, {:channel_overwrites, cid})

      if gid != "" do
        case get_guild(gid) do
          {:ok, guild} ->
            existing = Map.get(guild, "channels") || []
            updated = Enum.reject(existing, fn c -> to_string(c["id"]) == cid end)
            put_guild(Map.put(guild, "channels", updated))

          _ -> :ok
        end
      end
    end

    :ok
  end

  defp handle_member_remove(event, payload) do
    gid = to_string(event["guild_id"] || payload["guild_id"])
    user = payload["user"] || event["user"] || %{}
    uid = to_string(user["id"] || user[:id] || payload["user_id"] || event["user_id"])

    if uid != "" and gid != "" do
      :ets.delete(@table, {:member_roles, uid, gid})
      :ets.delete(@table, {:member_nick, uid, gid})
    end

    :ok
  end

  defp index_guild_channels(%{"id" => guild_id, "channels" => channels}) when is_list(channels) do
    gid = to_string(guild_id)

    Enum.each(channels, fn
      %{"id" => channel_id} = chan ->
        cid = to_string(channel_id)
        :ets.insert(@table, {{:channel, cid}, gid})
        :ets.insert(@table, {{:channel_meta, cid}, Map.put(chan, "guild_id", gid)})

      _other ->
        :ok
    end)
  end

  defp index_guild_channels(_guild), do: :ok

  # ── Private Database Fetching ───────────────────────────────────────────────

  defp fetch_from_db(user_id) do
    with {:ok, user} <- fetch_user(user_id),
         {:ok, guilds} <- fetch_guilds_with_channels(user_id),
         {:ok, roles} <- fetch_roles(user_id),
         {:ok, member_roles} <- fetch_member_roles(user_id),
         {:ok, overwrites} <- fetch_channel_overwrites(user_id) do
      {:ok, user, guilds, roles, member_roles, overwrites}
    end
  end

  defp fetch_user(user_id) do
    query = "SELECT id, username, discriminator FROM users WHERE id = $1"

    case Postgrex.query(Gateway.DB, query, [user_id]) do
      {:ok, %Postgrex.Result{rows: [[id, username, discriminator]]}} ->
        disc_str =
          discriminator
          |> to_string()
          |> String.pad_leading(4, "0")

        user_map = %{
          "id" => to_string(id),
          "username" => username,
          "discriminator" => disc_str
        }

        {:ok, user_map}

      {:ok, %Postgrex.Result{rows: []}} ->
        {:error, :user_not_found}

      {:error, reason} ->
        Logger.error("Gateway.Guild.Cache: failed to query user #{user_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp fetch_guilds_with_channels(user_id) do
    guild_query = """
    SELECT g.id, g.name, g.owner_id, m.nickname
    FROM guilds g
    INNER JOIN members m ON m.guild_id = g.id
    WHERE m.user_id = $1
    ORDER BY g.id ASC
    """
    channel_query = """
    SELECT c.id, c.guild_id, c.type, c.name, c.position
    FROM channels c
    INNER JOIN members m ON m.guild_id = c.guild_id
    WHERE m.user_id = $1
    ORDER BY c.position ASC, c.id ASC
    """

    with {:ok, %Postgrex.Result{rows: guild_rows}} <- Postgrex.query(Gateway.DB, guild_query, [user_id]),
         {:ok, %Postgrex.Result{rows: channel_rows}} <- Postgrex.query(Gateway.DB, channel_query, [user_id]) do
      # Group channels by string guild_id
      channels_by_guild =
        Enum.group_by(
          channel_rows,
          fn [_cid, gid, _type, _name, _pos] -> to_string(gid) end,
          fn [cid, gid, type, name, pos] ->
            %{
              "id" => to_string(cid),
              "guild_id" => to_string(gid),
              "type" => type,
              "name" => name,
              "position" => pos
            }
          end
        )

      guilds =
        Enum.map(guild_rows, fn [gid, name, owner_id, nickname] ->
          gid_str = to_string(gid)

          %{
            "id" => gid_str,
            "name" => name,
            "owner_id" => to_string(owner_id),
            "nickname" => nickname,
            "channels" => Map.get(channels_by_guild, gid_str, [])
          }
        end)

      {:ok, guilds}
    else
      {:error, reason} ->
        Logger.error("Gateway.Guild.Cache: failed to query guilds/channels for #{user_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp fetch_roles(user_id) do
    role_query = """
    SELECT r.id, r.guild_id, r.name, r.position, r.permissions
    FROM roles r
    INNER JOIN members m ON m.guild_id = r.guild_id
    WHERE m.user_id = $1
    ORDER BY r.position ASC
    """

    case Postgrex.query(Gateway.DB, role_query, [user_id]) do
      {:ok, %Postgrex.Result{rows: rows}} ->
        roles =
          Enum.map(rows, fn [id, gid, name, pos, perms] ->
            %{
              "id" => to_string(id),
              "guild_id" => to_string(gid),
              "name" => name,
              "position" => pos,
              "permissions" => perms
            }
          end)

        {:ok, roles}

      {:error, reason} ->
        Logger.error("Gateway.Guild.Cache: failed to query roles for #{user_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp fetch_member_roles(user_id) do
    mr_query = """
    SELECT mr.guild_id, mr.role_id
    FROM member_roles mr
    WHERE mr.user_id = $1
    """

    case Postgrex.query(Gateway.DB, mr_query, [user_id]) do
      {:ok, %Postgrex.Result{rows: rows}} ->
        member_roles_by_guild =
          Enum.group_by(
            rows,
            fn [gid, _rid] -> to_string(gid) end,
            fn [_gid, rid] -> to_string(rid) end
          )

        {:ok, member_roles_by_guild}

      {:error, reason} ->
        Logger.error("Gateway.Guild.Cache: failed to query member_roles for #{user_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp fetch_channel_overwrites(user_id) do
    co_query = """
    SELECT co.channel_id, co.target_id, co.target_type, co.allow, co.deny
    FROM channel_overwrites co
    INNER JOIN channels c ON c.id = co.channel_id
    INNER JOIN members m ON m.guild_id = c.guild_id
    WHERE m.user_id = $1
    """

    case Postgrex.query(Gateway.DB, co_query, [user_id]) do
      {:ok, %Postgrex.Result{rows: rows}} ->
        overwrites_by_channel =
          Enum.group_by(
            rows,
            fn [cid, _tid, _type, _allow, _deny] -> to_string(cid) end,
            fn [cid, tid, type, allow, deny] ->
              %{
                "channel_id" => to_string(cid),
                "target_id" => to_string(tid),
                "target_type" => type,
                "allow" => allow,
                "deny" => deny
              }
            end
          )

        {:ok, overwrites_by_channel}

      {:error, reason} ->
        Logger.error("Gateway.Guild.Cache: failed to query channel_overwrites for #{user_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end
end

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
      {:ok, user, guilds} ->
        # Cache in ETS
        Enum.each(guilds, fn guild ->
          :ets.insert(@table, {{:guild, guild["id"]}, guild})
        end)

        guild_ids = Enum.map(guilds, & &1["id"])
        :ets.insert(@table, {{:member_guilds, uid}, guild_ids})
        :ets.insert(@table, {{:member_guilds, to_string(uid)}, guild_ids})

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
    :ok
  end

  # ── Private Database Fetching ───────────────────────────────────────────────

  defp fetch_from_db(user_id) do
    with {:ok, user} <- fetch_user(user_id),
         {:ok, guilds} <- fetch_guilds_with_channels(user_id) do
      {:ok, user, guilds}
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
    SELECT g.id, g.name, g.owner_id
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
        Enum.map(guild_rows, fn [gid, name, owner_id] ->
          gid_str = to_string(gid)

          %{
            "id" => gid_str,
            "name" => name,
            "owner_id" => to_string(owner_id),
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
end

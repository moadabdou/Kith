defmodule Gateway.Typing.Broadcaster do
  @moduledoc """
  Outbound TYPING_START event broadcaster (plan/05 §2 & #36).

  Typing indicators are fire-and-forget, self-healing ephemeral events:
  if a frame is lost, the world heals in 8 seconds. Zero state, zero
  database or disk persistence, and no cancellation messages.

  Deliberately local-only: events are dispatched directly to the
  `Gateway.Guild.Actor` on this node and never published to the NATS/Redis
  event bus — the bus is file-backed, and persisting ephemeral typing
  events would violate the zero-persistence contract. Stale frames
  replayed on RESUME are likewise harmless: clients compute indicator
  lifetime from the payload `timestamp`, not arrival time. Cross-node
  fan-out is out of scope for Phase 2 (single gateway node).
  """

  require Logger

  @doc """
  Resolves the channel's guild via `Gateway.Guild.Cache`, verifies the user
  is a member of that guild, and dispatches a `TYPING_START` event to the
  guild's channel subscribers via `Gateway.Guild.Actor.dispatch_event/2`.

  Returns `:ok` when dispatched, `{:dropped, reason}` otherwise. Dropped
  requests are silent — the connection is never closed.
  """
  @spec broadcast(user_id :: integer() | binary(), channel_id :: integer() | binary()) ::
          :ok | {:dropped, :unknown_channel | :not_a_member}
  def broadcast(user_id, channel_id) do
    with {:ok, guild_id} <- Gateway.Guild.Cache.get_channel_guild(channel_id),
         :ok <- ensure_member(user_id, guild_id) do
      Gateway.Metrics.incr_typing_broadcast()

      event = %{
        "type" => "TYPING_START",
        "version" => 1,
        "guild_id" => guild_id,
        "payload" =>
          %{
            "channel_id" => to_string(channel_id),
            "user_id" => to_string(user_id),
            "guild_id" => guild_id,
            "timestamp" => System.system_time(:second)
          }
          |> maybe_put_user(user_id, guild_id)
      }

      Gateway.Guild.Actor.dispatch_event(guild_id, event)
    else
      :error ->
        Logger.debug(
          "Gateway.Typing.Broadcaster: unknown channel #{channel_id} for user #{user_id}, dropping"
        )

        {:dropped, :unknown_channel}

      {:error, :not_a_member} ->
        Logger.warning(
          "Gateway.Typing.Broadcaster: user #{user_id} is not a member of the guild owning channel #{channel_id}, dropping"
        )

        {:dropped, :not_a_member}
    end
  end

  defp ensure_member(user_id, guild_id) do
    if Gateway.Guild.Cache.member_of?(user_id, guild_id) do
      :ok
    else
      {:error, :not_a_member}
    end
  end

  # Enriches the payload with the cached user map and per-guild nickname so
  # receivers can render display names without extra lookups (Discord's real
  # TYPING_START carries a member object for the same reason). Two ETS reads,
  # no DB — the user cache is always warm because typing requires IDENTIFY,
  # which warms it. Fields are omitted on a cache miss; clients fall back.
  defp maybe_put_user(payload, user_id, guild_id) do
    case Gateway.Guild.Cache.get_user(user_id) do
      {:ok, user} ->
        payload
        |> Map.put("user", %{
          "id" => to_string(user_id),
          "username" => user["username"],
          "discriminator" => user["discriminator"]
        })
        |> Map.put("nick", Gateway.Guild.Cache.get_member_nick(user_id, guild_id) |> nick_value())

      :error ->
        payload
    end
  end

  defp nick_value({:ok, nick}), do: nick
  defp nick_value(:error), do: nil
end

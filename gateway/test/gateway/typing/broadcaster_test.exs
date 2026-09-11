defmodule Gateway.Typing.BroadcasterTest do
  use ExUnit.Case, async: false

  alias Gateway.Typing.Broadcaster
  alias Gateway.Guild.Cache
  alias Gateway.Session

  setup do
    # Clear ETS caches and lingering sessions/guild actors between tests
    for {_, pid, _, _} <- DynamicSupervisor.which_children(Gateway.ConnSupervisor) do
      DynamicSupervisor.terminate_child(Gateway.ConnSupervisor, pid)
    end

    for {_, pid, _, _} <- DynamicSupervisor.which_children(Gateway.GuildSupervisor) do
      DynamicSupervisor.terminate_child(Gateway.GuildSupervisor, pid)
    end

    if :ets.whereis(:gateway_presence_store) != :undefined do
      :ets.delete_all_objects(:gateway_presence_store)
    end

    if :ets.whereis(:gateway_guild_cache) != :undefined do
      :ets.delete_all_objects(:gateway_guild_cache)
    end

    :ok
  end

  defp seed_guild(guild_id, channel_ids) do
    channels =
      Enum.with_index(channel_ids, fn channel_id, position ->
        %{
          "id" => to_string(channel_id),
          "guild_id" => to_string(guild_id),
          "type" => 0,
          "name" => "chan-#{position}",
          "position" => position
        }
      end)

    Cache.put_guild(%{
      "id" => to_string(guild_id),
      "name" => "Guild #{guild_id}",
      "owner_id" => "owner_#{guild_id}",
      "channels" => channels
    })
  end

  test "put_guild indexes channels for guild_id resolution" do
    seed_guild("guild_idx_1", ["chan_a", "chan_b", 42_424_242])

    assert {:ok, "guild_idx_1"} = Cache.get_channel_guild("chan_a")
    assert {:ok, "guild_idx_1"} = Cache.get_channel_guild("chan_b")
    # Integer channel ids resolve through the string-keyed index
    assert {:ok, "guild_idx_1"} = Cache.get_channel_guild(42_424_242)
    assert :error = Cache.get_channel_guild("chan_unknown")
  end

  test "broadcast dispatches TYPING_START to guild subscribers with valid timestamp and channel id" do
    guild_id = "guild_typing_1"
    channel_id = "chan_typing_1"
    typer_id = "typer_1"

    seed_guild(guild_id, [channel_id])
    Cache.put_member_guilds(typer_id, [guild_id])

    # Subscriber session co-member in the guild
    {:ok, _} =
      Session.get_or_spawn(
        session_id: "sess_typing_listener_1",
        user_id: "listener_1",
        guild_ids: [guild_id],
        ws_pid: self()
      )

    # Outsider session in an unrelated guild must not receive anything
    {:ok, _} =
      Session.get_or_spawn(
        session_id: "sess_typing_listener_2",
        user_id: "listener_2",
        guild_ids: ["guild_unrelated"],
        ws_pid: self()
      )

    before_ts = System.system_time(:second)
    assert :ok = Broadcaster.broadcast(typer_id, channel_id)
    after_ts = System.system_time(:second)

    assert_receive {:send_frame, event, seq, bus_received_at}, 1000

    assert event["type"] == "TYPING_START"
    assert event["version"] == 1
    assert event["guild_id"] == guild_id
    assert is_nil(bus_received_at)
    assert is_integer(seq)

    payload = event["payload"]
    assert payload["channel_id"] == channel_id
    assert payload["user_id"] == typer_id
    assert payload["guild_id"] == guild_id
    assert is_integer(payload["timestamp"])
    assert payload["timestamp"] in before_ts..after_ts

    # No TYPING_START ever reaches the unrelated guild subscriber
    refute_receive {:send_frame, %{"type" => "TYPING_START"}, _, _}, 100
  end

  test "broadcast drops unknown channels and non-members without closing anything" do
    guild_id = "guild_typing_2"
    channel_id = "chan_typing_2"

    seed_guild(guild_id, [channel_id])
    Cache.put_member_guilds("outsider_1", ["guild_other"])

    # Unknown channel
    assert {:dropped, :unknown_channel} = Broadcaster.broadcast("typer_2", "chan_does_not_exist")

    # Known channel but user is not a member of the owning guild
    assert {:dropped, :not_a_member} = Broadcaster.broadcast("outsider_1", channel_id)

    # No subscriber frames emitted
    refute_receive {:send_frame, %{"type" => "TYPING_START"}, _, _}, 100
  end
end

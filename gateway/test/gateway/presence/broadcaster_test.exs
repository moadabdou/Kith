defmodule Gateway.Presence.BroadcasterTest do
  use ExUnit.Case, async: false

  alias Gateway.Presence.Broadcaster
  alias Gateway.Guild.Cache
  alias Gateway.Guild.Actor, as: GuildActor
  alias Gateway.Session

  setup do
    # Clear ETS caches and lingering sessions between tests
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

  test "broadcast fans out PRESENCE_UPDATE to all mutual guilds and scopes correctly" do
    user_id = "test_user_broadcaster_1"
    mutual_g1 = "guild_mutual_1"
    mutual_g2 = "guild_mutual_2"
    unrelated_g3 = "guild_unrelated_3"

    # Seed mutual guilds for target user in Guild Cache
    Cache.put_member_guilds(user_id, [mutual_g1, mutual_g2])

    # Spawn listening sessions:
    # Client 1 in mutual_g1
    s1_id = "sess_listener_1"
    {:ok, _} = Session.get_or_spawn(session_id: s1_id, user_id: "listener_1", guild_ids: [mutual_g1], ws_pid: self())

    # Client 2 in mutual_g2
    s2_id = "sess_listener_2"
    {:ok, _} = Session.get_or_spawn(session_id: s2_id, user_id: "listener_2", guild_ids: [mutual_g2], ws_pid: self())

    # Client 3 in unrelated_g3 (not a mutual guild)
    s3_id = "sess_listener_3"
    {:ok, _} = Session.get_or_spawn(session_id: s3_id, user_id: "listener_3", guild_ids: [unrelated_g3], ws_pid: self())

    activities = [%{"name" => "Visual Studio Code", "type" => 0}]
    client_status = %{"desktop" => "dnd"}

    # Broadcast status change for target user
    Broadcaster.broadcast_sync(user_id, :dnd, activities, client_status)

    # Both mutual sessions should receive the event
    assert_receive {:send_frame, event1, seq1, _bus_ts}, 1000
    assert_receive {:send_frame, event2, seq2, _bus_ts}, 1000

    # Verify per-session monotonic seq assignment
    assert seq1 == 1
    assert seq2 == 1

    received_guild_ids = [event1["guild_id"], event2["guild_id"]]
    assert mutual_g1 in received_guild_ids
    assert mutual_g2 in received_guild_ids
    refute unrelated_g3 in received_guild_ids

    # Verify standard PRESENCE_UPDATE payload format
    assert event1["type"] == "PRESENCE_UPDATE"
    payload1 = event1["payload"]
    assert payload1["user"]["id"] == user_id
    assert payload1["status"] == "dnd"
    assert payload1["activities"] == activities
    assert payload1["client_status"] == client_status

    # Unrelated session in unrelated_g3 must NOT receive anything
    refute_receive {:send_frame, %{"guild_id" => ^unrelated_g3}, _, _}, 100
  end

  test "sequential presence updates preserve monotonic sequence numbering" do
    user_id = "test_user_seq_1"
    guild_id = "guild_seq_1"

    Cache.put_member_guilds(user_id, [guild_id])

    # Spawn listening session
    s_id = "sess_seq_listener"
    {:ok, _} = Session.get_or_spawn(session_id: s_id, user_id: "listener_seq", guild_ids: [guild_id], ws_pid: self())

    # Update 1: online
    Broadcaster.broadcast_sync(user_id, :online)
    assert_receive {:send_frame, e1, 1, _}, 1000
    assert e1["payload"]["status"] == "online"

    # Update 2: idle
    Broadcaster.broadcast_sync(user_id, :idle)
    assert_receive {:send_frame, e2, 2, _}, 1000
    assert e2["payload"]["status"] == "idle"

    # Update 3: offline
    Broadcaster.broadcast_sync(user_id, :offline)
    assert_receive {:send_frame, e3, 3, _}, 1000
    assert e3["payload"]["status"] == "offline"

    # Verify ring buffer replay size
    {:ok, info} = Session.info(s_id)
    assert info.seq == 3
    assert info.replay_size == 3
  end

  test "broadcast with no mutual guilds is safe no-op" do
    user_id = "user_no_guilds_999"
    Cache.put_member_guilds(user_id, [])

    assert :ok = Broadcaster.broadcast_sync(user_id, :online)
    refute_receive {:send_frame, _, _, _}, 100
  end
end

defmodule Gateway.ReactionsFanoutTest do
  @moduledoc """
  Issue #109: Elixir gateway fan-out for MESSAGE_REACTION_* events.
  Validates:
  1. Multi-session reaction fan-out (User A reacts -> User B receives MESSAGE_REACTION_ADD with {channel_id, message_id, user_id, emoji}).
  2. Removal fan-out for MESSAGE_REACTION_REMOVE.
  3. Session-side permission filtering (private channel reactions never leak to unauthorized sessions, no seq consumed).
  4. Lane routing through `Gateway.Guild.Actor.route_fanout/4` with `lane_family`.
  5. Session disconnect/reconnect replay: missed reaction events buffered in Gateway.Session ring buffer and replayed on resume.
  """
  use ExUnit.Case, async: false

  alias Gateway.Guild.{Actor, Cache}
  alias Gateway.{Session, Permissions}

  setup do
    n = System.unique_integer([:positive])
    gid = "react_guild_#{n}"
    pub_chan = "react_pub_#{n}"
    priv_chan = "react_priv_#{n}"
    vip_role = "react_vip_#{n}"
    user_a = "react_user_a_#{n}"
    user_b = "react_user_b_#{n}"
    user_c = "react_user_c_#{n}"
    view = Permissions.view_channel()

    Cache.put_guild(%{
      "id" => gid,
      "name" => "Reaction Test Guild",
      "owner_id" => "react_owner_#{n}",
      "channels" => [
        %{"id" => pub_chan, "guild_id" => gid, "type" => 0, "name" => "general"},
        %{"id" => priv_chan, "guild_id" => gid, "type" => 0, "name" => "secret"}
      ]
    })

    Cache.put_guild_roles(gid, [
      %{"id" => gid, "guild_id" => gid, "name" => "@everyone", "position" => 0, "permissions" => view},
      %{"id" => vip_role, "guild_id" => gid, "name" => "VIP", "position" => 1, "permissions" => 0}
    ])

    Cache.put_channel_overwrites(pub_chan, [])

    # priv_chan denies @everyone, allows VIP
    Cache.put_channel_overwrites(priv_chan, [
      %{"target_id" => gid, "target_type" => 0, "allow" => 0, "deny" => view},
      %{"target_id" => vip_role, "target_type" => 0, "allow" => view, "deny" => 0}
    ])

    # User A has VIP role (can see both pub and priv)
    Cache.put_member_roles(user_a, gid, [vip_role])
    Cache.put_member_guilds(user_a, [gid])

    # User B has only @everyone (can see pub, cannot see priv)
    Cache.put_member_roles(user_b, gid, [])
    Cache.put_member_guilds(user_b, [gid])

    # User C has only @everyone (can see pub, cannot see priv)
    Cache.put_member_roles(user_c, gid, [])
    Cache.put_member_guilds(user_c, [gid])

    {:ok, _} = Actor.get_or_spawn(gid)

    on_exit(fn ->
      for sid <- ["sess-#{n}-a", "sess-#{n}-b", "sess-#{n}-c", "sess-#{n}-resume"] do
        Session.close(sid)
      end
    end)

    {:ok,
     %{
       gid: gid,
       pub_chan: pub_chan,
       priv_chan: priv_chan,
       user_a: user_a,
       user_b: user_b,
       user_c: user_c,
       n: n
     }}
  end

  defp spawn_ws(tag) do
    test_pid = self()
    spawn(fn -> ws_loop(test_pid, tag) end)
  end

  defp ws_loop(test_pid, tag) do
    receive do
      {:send_frame, event, seq, ts} ->
        send(test_pid, {tag, event, seq, ts})
        ws_loop(test_pid, tag)

      {:close, code, reason} ->
        send(test_pid, {tag, :closed, code, reason})
    end
  end

  defp spawn_session(sid, user_id, gid, ws) do
    {:ok, pid} =
      Session.get_or_spawn(session_id: sid, user_id: user_id, guild_ids: [gid], ws_pid: ws)

    send(pid, {:resubscribe, to_string(gid), 0})
    wait_until(fn -> subscribed?(gid, sid) end)
    pid
  end

  defp subscribed?(gid, sid) do
    Actor.subscribers(gid)
    |> Enum.any?(fn {id, _} -> to_string(id) == to_string(sid) end)
  end

  defp wait_until(fun, timeout_ms \\ 3_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_wait(fun, deadline)
  end

  defp do_wait(fun, deadline) do
    if fun.() do
      :ok
    else
      if System.monotonic_time(:millisecond) > deadline,
        do: flunk("condition did not converge in time"),
        else: (Process.sleep(10); do_wait(fun, deadline))
    end
  end

  defp reaction_add_event(gid, channel_id, message_id, user_id, emoji) do
    %{
      "type" => "MESSAGE_REACTION_ADD",
      "guild_id" => gid,
      "payload" => %{
        "channel_id" => channel_id,
        "message_id" => message_id,
        "user_id" => user_id,
        "guild_id" => gid,
        "emoji" => emoji
      }
    }
  end

  defp reaction_remove_event(gid, channel_id, message_id, user_id, emoji) do
    %{
      "type" => "MESSAGE_REACTION_REMOVE",
      "guild_id" => gid,
      "payload" => %{
        "channel_id" => channel_id,
        "message_id" => message_id,
        "user_id" => user_id,
        "guild_id" => gid,
        "emoji" => emoji
      }
    }
  end

  test "multi-session reaction add fanout delivers within 50ms with correct payload", ctx do
    ws_a = spawn_ws(:user_a)
    ws_b = spawn_ws(:user_b)
    spawn_session("sess-#{ctx.n}-a", ctx.user_a, ctx.gid, ws_a)
    spawn_session("sess-#{ctx.n}-b", ctx.user_b, ctx.gid, ws_b)

    event = reaction_add_event(ctx.gid, ctx.pub_chan, "msg_100", ctx.user_a, "🔥")

    t_start = System.monotonic_time(:millisecond)
    Actor.dispatch_event(ctx.gid, event)

    assert_receive {:user_b, %{"type" => "MESSAGE_REACTION_ADD"} = received_event, _seq, _ts}, 1_000
    t_received = System.monotonic_time(:millisecond)
    assert t_received - t_start < 50, "Fanout must arrive within 50ms, took #{t_received - t_start}ms"

    payload = received_event["payload"]
    assert payload["channel_id"] == ctx.pub_chan
    assert payload["message_id"] == "msg_100"
    assert payload["user_id"] == ctx.user_a
    assert payload["emoji"] == "🔥"

    # User A also receives the broadcast
    assert_receive {:user_a, %{"type" => "MESSAGE_REACTION_ADD"} = ^received_event, _seq_a, _}, 1_000
  end

  test "multi-session reaction remove fanout delivers to subscribers", ctx do
    ws_a = spawn_ws(:user_a)
    ws_b = spawn_ws(:user_b)
    spawn_session("sess-#{ctx.n}-a", ctx.user_a, ctx.gid, ws_a)
    spawn_session("sess-#{ctx.n}-b", ctx.user_b, ctx.gid, ws_b)

    event = reaction_remove_event(ctx.gid, ctx.pub_chan, "msg_100", ctx.user_a, "🔥")
    Actor.dispatch_event(ctx.gid, event)

    assert_receive {:user_b, %{"type" => "MESSAGE_REACTION_REMOVE"} = received_event, _seq, _}, 1_000
    payload = received_event["payload"]
    assert payload["channel_id"] == ctx.pub_chan
    assert payload["message_id"] == "msg_100"
    assert payload["user_id"] == ctx.user_a
    assert payload["emoji"] == "🔥"
  end

  test "session channel permission filter suppresses private channel reactions for unauthorized sessions", ctx do
    ws_a = spawn_ws(:user_a)
    ws_b = spawn_ws(:user_b)
    spawn_session("sess-#{ctx.n}-a", ctx.user_a, ctx.gid, ws_a)
    spawn_session("sess-#{ctx.n}-b", ctx.user_b, ctx.gid, ws_b)

    priv_reaction = reaction_add_event(ctx.gid, ctx.priv_chan, "msg_secret_1", ctx.user_a, "🔒")
    Actor.dispatch_event(ctx.gid, priv_reaction)

    # User A (VIP) receives the reaction
    assert_receive {:user_a, ^priv_reaction, _seq_a, _}, 1_000

    # User B (not VIP) does NOT receive the reaction from private channel
    refute_receive {:user_b, ^priv_reaction, _, _}, 300
  end

  test "reaction events route through split chat lanes without control bottlenecks", ctx do
    gid = "split_react_guild_#{ctx.n}"
    pub_chan = "split_pub_#{ctx.n}"

    Application.put_env(:gateway, :split_threshold, 2)
    Application.put_env(:gateway, :split_lanes, 4)

    Cache.put_guild(%{
      "id" => gid,
      "name" => "Split React Guild",
      "owner_id" => "split_owner_#{ctx.n}",
      "channels" => [%{"id" => pub_chan, "guild_id" => gid, "type" => 0, "name" => "general"}]
    })

    Cache.put_guild_roles(gid, [
      %{"id" => gid, "guild_id" => gid, "name" => "@everyone", "position" => 0, "permissions" => Permissions.view_channel()}
    ])
    Cache.put_channel_overwrites(pub_chan, [])

    Cache.put_member_roles(ctx.user_a, gid, [])
    Cache.put_member_guilds(ctx.user_a, [gid])
    Cache.put_member_roles(ctx.user_b, gid, [])
    Cache.put_member_guilds(ctx.user_b, [gid])

    {:ok, _} = Actor.get_or_spawn(gid)

    ws_a = spawn_ws(:user_a)
    ws_b = spawn_ws(:user_b)
    spawn_session("sess-split-#{ctx.n}-a", ctx.user_a, gid, ws_a)
    spawn_session("sess-split-#{ctx.n}-b", ctx.user_b, gid, ws_b)

    # Guild should now be split across 4 lanes
    assert Actor.split_state(gid) == {:split, 4}

    event = reaction_add_event(gid, pub_chan, "msg_split_1", ctx.user_a, "🚀")
    :ok = Actor.route_fanout(gid, event)

    assert_receive {:user_a, %{"type" => "MESSAGE_REACTION_ADD"} = received_a, _seq_a, _}, 1_000
    assert_receive {:user_b, %{"type" => "MESSAGE_REACTION_ADD"} = received_b, _seq_b, _}, 1_000

    assert received_a["payload"]["emoji"] == "🚀"
    assert received_b["payload"]["emoji"] == "🚀"

    Application.delete_env(:gateway, :split_threshold)
    Application.delete_env(:gateway, :split_lanes)
    Session.close("sess-split-#{ctx.n}-a")
    Session.close("sess-split-#{ctx.n}-b")
  end

  test "disconnected session captures reaction in replay buffer and replays on resume", ctx do
    sid = "sess-#{ctx.n}-resume"
    ws = spawn_ws(:initial)

    {:ok, pid} =
      Session.get_or_spawn(session_id: sid, user_id: ctx.user_b, guild_ids: [ctx.gid], ws_pid: ws)

    send(pid, {:resubscribe, to_string(ctx.gid), 0})
    wait_until(fn -> subscribed?(ctx.gid, sid) end)

    # First event received live
    event1 = reaction_add_event(ctx.gid, ctx.pub_chan, "msg_1", ctx.user_a, "👍")
    Actor.dispatch_event(ctx.gid, event1)
    assert_receive {:initial, ^event1, seq1, _}, 1_000

    # Simulate socket disconnect
    Process.exit(ws, :kill)
    # Wait for session to observe socket death and clear ws_pid
    wait_until(fn ->
      case Session.info(sid) do
        {:ok, %{ws_pid: nil}} -> true
        _ -> false
      end
    end)

    # Dispatch second reaction while client is disconnected
    event2 = reaction_add_event(ctx.gid, ctx.pub_chan, "msg_1", ctx.user_a, "❤️")
    # Also dispatch private reaction which should be dropped by permission check
    event_priv = reaction_add_event(ctx.gid, ctx.priv_chan, "msg_priv", ctx.user_a, "⛔")

    Actor.dispatch_event(ctx.gid, event2)
    Actor.dispatch_event(ctx.gid, event_priv)

    # Session captures events in replay buffer, private reaction was filtered out
    wait_until(fn ->
      case Session.info(sid) do
        {:ok, %{seq: s}} when s > seq1 + 1 -> true
        _ -> false
      end
    end)

    # Resume with a new socket starting from seq1 (the last event client had before disconnect)
    new_ws = spawn_ws(:resumed)
    {:ok, current_seq, missed_frames} = Session.resume(sid, new_ws, seq1, ctx.user_b)
    assert current_seq > seq1

    # Missed frames must include the reaction event2 while disconnected
    replayed_reaction =
      Enum.find(missed_frames, fn {_seq, f} ->
        f["type"] == "MESSAGE_REACTION_ADD" and f["payload"]["emoji"] == "❤️"
      end)

    assert replayed_reaction != nil
    {replayed_seq, reaction_frame} = replayed_reaction
    assert replayed_seq > seq1
    assert reaction_frame["payload"]["channel_id"] == ctx.pub_chan
    assert reaction_frame["payload"]["message_id"] == "msg_1"
    assert reaction_frame["payload"]["emoji"] == "❤️"

    # Private reaction was filtered out and never entered replay buffer
    assert Enum.all?(missed_frames, fn {_seq, f} ->
             f["payload"]["emoji"] != "⛔"
           end)
  end
end

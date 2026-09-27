defmodule Gateway.Guild.SplitTest do
  # Phase 7e Step 4b (Issue #88): subscriber-splitting. Control keeps
  # everything but chat past @threshold@ subs; MESSAGE fan-out shards
  # across lanes. Per-session seq is assigned in the session, so splitting
  # changes timing only — these tests pin the delivery/dedup/lease
  # semantics that must not change.
  use ExUnit.Case, async: false

  alias Gateway.Guild.Actor
  alias Gateway.Guild.Cache

  @chan "split_chan_1"
  @user "split_user_1"
  @role "split_role_1"

  setup do
    gid = "split_guild_#{System.unique_integer([:positive])}"

    Application.put_env(:gateway, :split_threshold, 3)
    Application.put_env(:gateway, :split_lanes, 4)

    on_exit(fn ->
      Application.delete_env(:gateway, :split_threshold)
      Application.delete_env(:gateway, :split_lanes)

      for key <- [gid | for(i <- 0..3, do: Actor.lane_key(gid, i))] do
        case Actor.whereis(key) do
          pid when is_pid(pid) ->
            Horde.DynamicSupervisor.terminate_child(Gateway.GuildSupervisor, pid)

          nil ->
            :ok
        end
      end
    end)

    # Seed permission view: user holds a role with VIEW+SEND on the channel.
    Cache.put_guild(%{
      "id" => gid,
      "name" => "split",
      "owner_id" => "1",
      "channels" => [%{"id" => @chan, "guild_id" => gid, "type" => 0, "name" => "c"}]
    })

    Cache.put_guild_roles(gid, [
      %{"id" => @role, "guild_id" => gid, "name" => "R", "position" => 1, "permissions" => 1024 + 2048}
    ])

    Cache.put_member_roles(@user, gid, [@role])

    {:ok, gid: gid}
  end

  defp msg_event(gid, id, seq_note) do
    %{
      "type" => "MESSAGE_CREATE",
      "guild_id" => gid,
      "payload" => %{
        "message" => %{"id" => id, "channel_id" => @chan, "content" => seq_note}
      }
    }
  end

  # Long-lived forwarding subscriber: keeps its subscription alive while
  # relaying everything under a distinct tag, so the test pid can assert
  # exactly-once delivery per session without mailbox multiplexing.
  defp sub_proc() do
    parent = self()

    spawn(fn ->
      loop = fn loop ->
        receive do
          msg ->
            send(parent, {:got, self(), msg})
            loop.(loop)
        end
      end

      loop.(loop)
    end)
  end

  # Full session flow through control + lane + migrated flag.
  defp full_subscribe(gid, session_id, pid) do
    :ok = Actor.subscribe(gid, session_id, pid, @user)
    {:lane, key} = Actor.message_lane(gid, session_id)
    :ok = Actor.subscribe(key, session_id, pid, @user)
    Actor.note_migrated(gid, session_id)
    key
  end

  describe "split trigger" do
    test "below threshold the guild stays single", %{gid: gid} do
      {:ok, _} = Actor.get_or_spawn(gid)
      assert :ok = Actor.subscribe(gid, "s1", self(), @user)
      assert :ok = Actor.subscribe(gid, "s2", self(), @user)
      assert Actor.split_state(gid) == :single
      assert Actor.message_lane(gid, "s1") == :single
    end

    test "crossing threshold spawns lanes and notifies subscribers", %{gid: gid} do
      {:ok, _} = Actor.get_or_spawn(gid)
      pids = for n <- 1..3, do: {sub_proc(), "s#{n}"}

      for {pid, sid} <- pids do
        assert :ok = Actor.subscribe(gid, sid, pid, @user)
      end

      assert Actor.split_state(gid) == {:split, 4}

      for i <- 0..3 do
        assert is_pid(Actor.whereis(Actor.lane_key(gid, i)))
      end

      for {pid, _} <- pids do
        assert_receive {:got, ^pid, {:guild_split, _}}, 1_000
      end
    end

    test "lane assignment is stable per session and spread across lanes", %{gid: gid} do
      for _ <- 1..20 do
        assert Actor.lane_assignment("sess-a", 4) == Actor.lane_assignment("sess-a", 4)
      end

      lanes = for i <- 1..40, do: Actor.lane_assignment("sess-#{i}", 4)
      assert length(Enum.uniq(lanes)) > 1
    end
  end

  describe "lane dispatch semantics" do
    test "lane fans out exactly once with dedup on redelivery", %{gid: gid} do
      {:ok, _} = Actor.get_or_spawn(gid)
      key = Actor.lane_key(gid, 0)
      {:ok, _} = Actor.get_or_spawn(key, role: {:lane, 0}, real_guild_id: gid)
      assert :ok = Actor.subscribe(key, "sess-lane", self(), @user)

      evt = msg_event(gid, "m1", "hi")
      :ok = Actor.dispatch_bus_event(key, evt, nil, bus_seq: 7001)
      assert_receive {:dispatch, _, _}, 1_000

      # Same stream position redelivered: dedup net holds on the lane.
      :ok = Actor.dispatch_bus_event(key, evt, nil, bus_seq: 7001)
      refute_receive {:dispatch, _, _}, 200
    end

    test "split guild delivers exactly once across control + lane (no double)", %{gid: gid} do
      {:ok, _} = Actor.get_or_spawn(gid)
      # Push past threshold on forwarder sessions, then migrate them all
      # so control goes fully quiet for chat.
      pids = for n <- 1..3, do: {sub_proc(), "s#{n}"}
      for {pid, sid} <- pids, do: :ok = Actor.subscribe(gid, sid, pid, @user)
      assert {:split, 4} = Actor.split_state(gid)
      for {pid, sid} <- pids, do: full_subscribe(gid, sid, pid)

      # The asserted session lives on the test pid directly.
      full_subscribe(gid, "sess-full", self())

      evt = msg_event(gid, "m2", "hello")
      :ok = Actor.route_fanout(gid, evt, nil, bus_seq: 7002)
      assert_receive {:dispatch, _, _}, 1_000
      refute_receive {:dispatch, _, _}, 300
    end

    test "control drops lane-family while split but still serves control traffic", %{gid: gid} do
      {:ok, _} = Actor.get_or_spawn(gid)
      pids = for n <- 1..3, do: {sub_proc(), "s#{n}"}
      for {pid, sid} <- pids, do: :ok = Actor.subscribe(gid, sid, pid, @user)
      assert {:split, _} = Actor.split_state(gid)
      for {pid, sid} <- pids, do: full_subscribe(gid, sid, pid)

      # Asserted session, fully migrated: control must stay silent on chat.
      full_subscribe(gid, "sess-ctrl", self())

      # Direct-to-control MESSAGE while split: dropped (lanes own it).
      evt = msg_event(gid, "m3", "x")
      :ok = Actor.dispatch_bus_event(gid, evt, nil, bus_seq: 7003)
      refute_receive {:dispatch, _, _}, 300

      # Control traffic still served by control.
      presence = %{"type" => "PRESENCE_UPDATE", "guild_id" => gid, "payload" => %{}}
      :ok = Actor.route_fanout(gid, presence, nil, bus_seq: 7004)
      assert_receive {:dispatch, _, _}, 1_000
    end

    test "lanes refuse voice operations", %{gid: gid} do
      key = Actor.lane_key(gid, 0)
      {:ok, _} = Actor.get_or_spawn(key, role: {:lane, 0}, real_guild_id: gid)
      assert {:error, :not_control} = Actor.update_voice_state(key, @user, "sess", %{"channel_id" => @chan})
      assert %{} = :sys.get_state(Actor.whereis(key)) |> Map.get(:voice_states)
    end
  end

  describe "lane + session integration (Issues #91/#93)" do
    alias Gateway.{Session, Metrics}

    # Forwarder "sockets" tagging send_frames per session.
    defp spawn_ws(tag) do
      test = self()
      spawn(fn -> ws_loop(test, tag) end)
    end

    defp ws_loop(test, tag) do
      receive do
        {:send_frame, event, seq, ts} ->
          send(test, {tag, event, seq, ts})
          ws_loop(test, tag)

        {:close, code, reason} ->
          send(test, {tag, :closed, code, reason})
      end
    end

    defp spawn_session(sid, user_id, gid, ws) do
      {:ok, pid} =
        Session.get_or_spawn(session_id: sid, user_id: user_id, guild_ids: [gid], ws_pid: ws)

      wait_subscribed(gid, sid)
      pid
    end

    defp wait_subscribed(gid, sid, timeout_ms \\ 5_000) do
      deadline = System.monotonic_time(:millisecond) + timeout_ms
      do_wait_sub(gid, sid, deadline)
    end

    defp do_wait_sub(gid, sid, deadline) do
      subscribed? =
        Actor.subscribers(gid)
        |> Enum.any?(fn {id, _} -> to_string(id) == to_string(sid) end)

      cond do
        subscribed? ->
          :ok

        System.monotonic_time(:millisecond) > deadline ->
          flunk("session #{sid} did not subscribe to #{gid}")

        true ->
          # Nudge the idempotent resubscribe path (Horde placement races
          # under parallel-suite load can strand the initial subscribe).
          if pid = Session.whereis(sid), do: send(pid, {:resubscribe, to_string(gid), 0})
          Process.sleep(20)
          do_wait_sub(gid, sid, deadline)
      end
    end

    defp wait_lane_subscribed(gid, sid, timeout_ms \\ 5_000) do
      key = Actor.lane_key(gid, Actor.lane_assignment(sid, Actor.split_lane_count()))
      deadline = System.monotonic_time(:millisecond) + timeout_ms
      do_wait_lane(key, sid, deadline)
    end

    defp do_wait_lane(key, sid, deadline) do
      subscribed? =
        Actor.subscribers(key)
        |> Enum.any?(fn {id, _} -> to_string(id) == to_string(sid) end)

      cond do
        subscribed? ->
          :ok

        System.monotonic_time(:millisecond) > deadline ->
          flunk("session #{sid} did not join lane #{key}")

        true ->
          Process.sleep(20)
          do_wait_lane(key, sid, deadline)
      end
    end

    # Private guild fixture: @everyone denied on the channel, VIP allowed.
    defp seed_private_guild(gid, chan, vip, alice, bob) do
      view = 1024

      Cache.put_guild(%{
        "id" => gid,
        "name" => "lane-filter",
        "owner_id" => "1",
        "channels" => [%{"id" => chan, "guild_id" => gid, "type" => 0, "name" => "c"}]
      })

      Cache.put_guild_roles(gid, [
        %{"id" => gid, "name" => "@everyone", "position" => 0, "permissions" => 0},
        %{"id" => vip, "name" => "VIP", "position" => 1, "permissions" => 0}
      ])

      Cache.put_channel_overwrites(chan, [
        %{"target_id" => gid, "target_type" => 0, "allow" => 0, "deny" => view},
        %{"target_id" => vip, "target_type" => 0, "allow" => view, "deny" => 0}
      ])

      Cache.put_member_roles(alice, gid, [vip])
      Cache.put_member_roles(bob, gid, [])
      Cache.put_member_guilds(alice, [gid])
      Cache.put_member_guilds(bob, [gid])
    end

    defp lane_msg(gid, chan, id) do
      %{
        "type" => "MESSAGE_CREATE",
        "guild_id" => gid,
        "payload" => %{"id" => id, "channel_id" => chan, "content" => id}
      }
    end

    test "lane traffic: authorized session gets gapless seq, denied gets silence", %{gid: _} do
      n = System.unique_integer([:positive])
      gid = "lane_filter_#{n}"
      chan = "lane_filter_chan_#{n}"
      vip = "lane_filter_vip_#{n}"
      alice = "lane_filter_alice_#{n}"
      bob = "lane_filter_bob_#{n}"
      seed_private_guild(gid, chan, vip, alice, bob)

      alice_ws = spawn_ws(:alice)
      bob_ws = spawn_ws(:bob)
      spawn_session("sess-lane-a-#{n}", alice, gid, alice_ws)
      spawn_session("sess-lane-b-#{n}", bob, gid, bob_ws)
      # Third subscriber crosses the test threshold (3) so lanes exist.
      spawn_session("sess-lane-c-#{n}", alice, gid, spawn_ws(:carol))

      # All three must be lane-joined before dispatching, else assertions
      # about filtering would pass vacuously on never-sent frames.
      for sid <- ["sess-lane-a-#{n}", "sess-lane-b-#{n}", "sess-lane-c-#{n}"] do
        wait_lane_subscribed(gid, sid)
      end

      before_filtered = Metrics.get_permission_filtered()
      {:ok, %{seq: alice_base}} = Session.info("sess-lane-a-#{n}")
      {:ok, %{seq: bob_base}} = Session.info("sess-lane-b-#{n}")

      for i <- 1..3 do
        :ok = Actor.route_fanout(gid, lane_msg(gid, chan, "lm-#{i}"), nil, bus_seq: 9000 + i)
      end

      # Authorized: exactly 3 frames, gapless seq continuing from the
      # pre-dispatch base (presence frames may own the early numbers —
      # assert consecutiveness, not absolute position). No control dup —
      # migrated sessions are skipped by control, served once by the lane.
      for expected_seq <- [(alice_base + 1), (alice_base + 2), (alice_base + 3)] do
        assert_receive {:alice, %{"type" => "MESSAGE_CREATE"}, ^expected_seq, _}, 1_000
      end

      refute_receive {:alice, %{"type" => "MESSAGE_CREATE"}, _, _}, 200

      # Denied: silence on data frames, seq untouched by them, filter
      # counter moved.
      refute_receive {:bob, %{"type" => "MESSAGE_CREATE"}, _, _}, 300
      assert {:ok, %{seq: ^bob_base}} = Session.info("sess-lane-b-#{n}")
      assert Metrics.get_permission_filtered() > before_filtered
    end

    test "hot cutover: crossing threshold under traffic loses nothing", %{gid: gid} do
      # Two sessions below threshold: control serves chat directly.
      ws1 = spawn_ws(:s1)
      ws2 = spawn_ws(:s2)
      spawn_session("sess-hot-1", @user, gid, ws1)
      spawn_session("sess-hot-2", @user, gid, ws2)

      :ok = Actor.route_fanout(gid, msg_event(gid, "hot-0", "pre"), nil, bus_seq: 9100)
      assert_receive {:s1, %{"type" => "MESSAGE_CREATE"}, _, _}, 1_000
      assert_receive {:s2, %{"type" => "MESSAGE_CREATE"}, _, _}, 1_000

      # Third subscriber trips the split while traffic flows.
      ws3 = spawn_ws(:s3)
      spawn_session("sess-hot-3", @user, gid, ws3)
      assert {:split, 4} = Actor.split_state(gid)

      # Let migration settle (lane joins + migrated flags converge).
      for sid <- ["sess-hot-1", "sess-hot-2", "sess-hot-3"] do
        wait_lane_subscribed(gid, sid)
      end

      # Bases AFTER settle: presence/early frames may own arbitrary seqs.
      {:ok, %{seq: b1}} = Session.info("sess-hot-1")
      {:ok, %{seq: b2}} = Session.info("sess-hot-2")
      {:ok, %{seq: b3}} = Session.info("sess-hot-3")

      for i <- 1..4 do
        :ok = Actor.route_fanout(gid, msg_event(gid, "hot-#{i}", "post"), nil, bus_seq: 9100 + i)
      end

      # Every session holds a gapless run continuing its base, exactly
      # once each (no loss, no control+lane dup).
      for {tag, base} <- [s1: b1, s2: b2, s3: b3] do
        for expected_seq <- Enum.to_list((base + 1)..(base + 4)) do
          assert_receive {^tag, %{"type" => "MESSAGE_CREATE"}, ^expected_seq, _}, 1_000
        end
      end

      for tag <- [:s1, :s2, :s3] do
        refute_receive {^tag, %{"type" => "MESSAGE_CREATE"}, _, _}, 200
      end
    end

    test "resume on a lane: replay intact across socket drop", %{gid: gid} do
      ws1 = spawn_ws(:r1)
      spawn_session("sess-resume-lane", @user, gid, ws1)
      # Force split so this session is lane-served.
      spawn_session("sess-resume-fill-1", @user, gid, spawn_ws(:f1))
      spawn_session("sess-resume-fill-2", @user, gid, spawn_ws(:f2))
      assert {:split, 4} = Actor.split_state(gid)
      wait_lane_subscribed(gid, "sess-resume-lane")

      :ok = Actor.route_fanout(gid, msg_event(gid, "rl-1", "one"), nil, bus_seq: 9201)
      :ok = Actor.route_fanout(gid, msg_event(gid, "rl-2", "two"), nil, bus_seq: 9202)
      assert_receive {:r1, _, s1, _}, 1_000
      assert_receive {:r1, _, s2, _}, 1_000
      assert s2 == s1 + 1

      # Kill the socket: session survives on TTL, third message buffers.
      Process.exit(ws1, :kill)
      :ok = Actor.route_fanout(gid, msg_event(gid, "rl-3", "three"), nil, bus_seq: 9203)

      ws2 = spawn_ws(:r2)
      assert {:ok, current, [{replayed_seq, rl3}]} = Session.resume("sess-resume-lane", ws2, s2, @user)
      assert current == s2 + 1
      assert replayed_seq == s2 + 1
      assert rl3["payload"]["message"]["id"] == "rl-3"

      # Live tail continues on the new socket with seq continuity.
      :ok = Actor.route_fanout(gid, msg_event(gid, "rl-4", "four"), nil, bus_seq: 9204)
      assert_receive {:r2, _, s4, _}, 1_000
      assert s4 == replayed_seq + 1
    end
  end
end

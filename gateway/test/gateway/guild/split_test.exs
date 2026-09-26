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
end

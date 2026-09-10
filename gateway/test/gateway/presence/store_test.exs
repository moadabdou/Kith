defmodule Gateway.Presence.StoreTest do
  use ExUnit.Case, async: false
  alias Gateway.Presence.Store

  @table :gateway_presence_store

  setup do
    # Clear ETS table between tests if present
    if :ets.whereis(@table) != :undefined do
      :ets.delete_all_objects(@table)
    end

    :ok
  end

  test "ETS table is configured with read_concurrency and write_concurrency" do
    info = :ets.info(@table)
    assert info != :undefined
    assert Keyword.get(info, :read_concurrency) == true
    assert Keyword.get(info, :write_concurrency) == true
    assert Keyword.get(info, :named_table) == true
  end

  test "put_presence and get_presence basic lifecycle" do
    user_id = "87000000000000001"
    session_id = "sess_101_a"
    client_status = %{"desktop" => "online"}

    assert :ok = Store.put_presence(user_id, :online, client_status, session_id, self())

    assert {:ok, presence} = Store.get_presence(user_id)
    assert presence.user_id == user_id
    assert presence.status == :online
    assert presence.client_status == client_status
    assert is_integer(presence.last_activity_at)
    assert Map.has_key?(presence.sessions, session_id)

    # get_presence with integer user_id works identically
    assert {:ok, int_presence} = Store.get_presence(87_000_000_000_000_001)
    assert int_presence.user_id == user_id
  end

  test "get_presence returns not_found for nonexistent user" do
    assert {:error, :not_found} == Store.get_presence("nonexistent_user")
  end

  test "get_presences returns a map of present users and skips absent ones" do
    Store.put_presence("u1", :online, %{"desktop" => "online"}, "s1", self())
    Store.put_presence("u2", :idle, %{"mobile" => "idle"}, "s2", self())

    result = Store.get_presences(["u1", "u2", "u3_absent"])
    assert Map.has_key?(result, "u1")
    assert Map.has_key?(result, "u2")
    refute Map.has_key?(result, "u3_absent")
    assert result["u1"].status == :online
    assert result["u2"].status == :idle
  end

  test "touch_activity updates timestamp" do
    user_id = "user_touch_1"
    session_id = "sess_touch_1"

    Store.put_presence(user_id, :online, %{}, session_id, self())
    {:ok, initial} = Store.get_presence(user_id)

    # Sleep slightly or advance timestamp
    future_ts = initial.last_activity_at + 5000
    assert :ok = Store.touch_activity(user_id, session_id, future_ts)

    {:ok, updated} = Store.get_presence(user_id)
    assert updated.last_activity_at == future_ts
    assert updated.sessions[session_id].last_activity_at == future_ts
  end

  test "multi-session aggregation and precedence: dnd > online > idle > offline" do
    user_id = "multi_user_1"

    # 1. First session connects as idle
    Store.put_presence(user_id, :idle, %{"mobile" => "idle"}, "s_mobile", self())
    {:ok, p1} = Store.get_presence(user_id)
    assert p1.status == :idle

    # 2. Second session connects as online -> aggregate becomes online
    Store.put_presence(user_id, :online, %{"desktop" => "online"}, "s_desktop", self())
    {:ok, p2} = Store.get_presence(user_id)
    assert p2.status == :online
    assert p2.client_status == %{"mobile" => "idle", "desktop" => "online"}

    # 3. Third session connects as dnd -> aggregate becomes dnd
    Store.put_presence(user_id, :dnd, %{"web" => "dnd"}, "s_web", self())
    {:ok, p3} = Store.get_presence(user_id)
    assert p3.status == :dnd

    # 4. Drop dnd session -> aggregate falls back to online
    Store.drop_session(user_id, "s_web")
    {:ok, p4} = Store.get_presence(user_id)
    assert p4.status == :online

    # 5. Drop online session -> aggregate falls back to idle
    Store.drop_session(user_id, "s_desktop")
    {:ok, p5} = Store.get_presence(user_id)
    assert p5.status == :idle

    # 6. Drop final idle session -> transitions to offline
    Store.drop_session(user_id, "s_mobile")
    {:ok, p6} = Store.get_presence(user_id)
    assert p6.status == :offline
    assert p6.sessions == %{}
  end

  test "automatic session cleanup when monitored session_pid crashes" do
    user_id = "user_monitor_1"
    session_id = "sess_monitor_1"

    # Spawn a temporary process simulating Gateway.Session
    fake_session = spawn(fn ->
      receive do
        :hang -> :ok
      end
    end)

    Store.put_presence(user_id, :online, %{"desktop" => "online"}, session_id, self(), fake_session)
    {:ok, before_kill} = Store.get_presence(user_id)
    assert before_kill.status == :online
    assert Map.has_key?(before_kill.sessions, session_id)

    # Kill the simulated session actor
    Process.exit(fake_session, :kill)

    # Allow GenServer message queue to process {:DOWN, ...}
    :timer.sleep(50)

    {:ok, after_kill} = Store.get_presence(user_id)
    assert after_kill.status == :offline
    assert map_size(after_kill.sessions) == 0
  end

  test "list_online filters out offline users" do
    Store.put_presence("online_user_1", :online, %{}, "s1", self())
    Store.put_presence("idle_user_2", :idle, %{}, "s2", self())
    Store.put_presence("offline_user_3", :offline, %{}, "s3", self())

    online_list = Store.list_online()
    online_uids = Enum.map(online_list, & &1.user_id)

    assert "online_user_1" in online_uids
    assert "idle_user_2" in online_uids
    refute "offline_user_3" in online_uids
  end

  describe "Issue #31: lifecycle callbacks & multi-session acceptance" do
    test "session_connected/4 defaults to :online and empty client_status" do
      user_id = "user_lc_1"
      session_id = "sess_lc_1"

      assert :ok = Store.session_connected(user_id, session_id, self())

      assert {:ok, p} = Store.get_presence(user_id)
      assert p.status == :online
      assert p.client_status == %{}
      assert Map.has_key?(p.sessions, session_id)
      assert p.sessions[session_id].status == :online
    end

    test "session_connected/6 with explicit status, client_status, and session_pid" do
      user_id = "user_lc_2"
      session_id = "sess_lc_2"

      assert :ok = Store.session_connected(user_id, session_id, self(), :dnd, %{"web" => "dnd"}, self())

      assert {:ok, p} = Store.get_presence(user_id)
      assert p.status == :dnd
      assert p.client_status == %{"web" => "dnd"}
    end

    test "normalizes string statuses to canonical atoms" do
      user_id = "user_norm_1"
      session_id = "sess_norm_1"

      Store.session_connected(user_id, session_id, self(), "dnd")
      assert {:ok, p} = Store.get_presence(user_id)
      assert p.status == :dnd
      assert p.sessions[session_id].status == :dnd
    end

    test "acceptance: connecting two sessions maintains online when one disconnects; transitions to offline when last disconnects" do
      user_id = "user_dual_session"
      s1 = "session_web"
      s2 = "session_mobile"

      # 1. First session connects
      assert :ok = Store.session_connected(user_id, s1, self(), :online, %{"web" => "online"})
      {:ok, p1} = Store.get_presence(user_id)
      assert p1.status == :online
      assert map_size(p1.sessions) == 1

      # 2. Second session connects
      assert :ok = Store.session_connected(user_id, s2, self(), :online, %{"mobile" => "online"})
      {:ok, p2} = Store.get_presence(user_id)
      assert p2.status == :online
      assert map_size(p2.sessions) == 2

      # 3. First session disconnects -> user remains online!
      assert :ok = Store.session_disconnected(user_id, s1)
      {:ok, p3} = Store.get_presence(user_id)
      assert p3.status == :online
      assert map_size(p3.sessions) == 1
      assert Map.has_key?(p3.sessions, s2)

      # 4. Final session disconnects -> user transitions to offline
      assert :ok = Store.session_disconnected(user_id, s2)
      {:ok, p4} = Store.get_presence(user_id)
      assert p4.status == :offline
      assert map_size(p4.sessions) == 0
    end
  end

  describe "Issue #32: idle sweeper & activity wake" do
    test "sweep_idle transitions inactive :online sessions to :idle" do
      user_id = "user_idle_sweep_1"
      session_id = "sess_idle_sweep_1"

      Store.session_connected(user_id, session_id, self(), :online)
      {:ok, p_init} = Store.get_presence(user_id)
      assert p_init.status == :online

      # Simulate past activity 11 minutes ago (660,000 ms ago)
      past_ts = System.system_time(:millisecond) - 660_000
      Store.touch_activity(user_id, session_id, past_ts)

      # Trigger idle sweep with default 10-minute threshold
      assert {:ok, count} = Store.sweep_idle(600_000)
      assert count >= 1

      {:ok, p_idle} = Store.get_presence(user_id)
      assert p_idle.status == :idle
      assert p_idle.sessions[session_id].status == :idle
    end

    test "sweep_idle preserves :dnd sessions without downgrading to :idle" do
      user_id = "user_dnd_preserve"
      session_id = "sess_dnd_preserve"

      Store.session_connected(user_id, session_id, self(), :dnd)

      # Inactive for 20 minutes
      past_ts = System.system_time(:millisecond) - 1_200_000
      # Touch with old timestamp
      GenServer.call(Store, {:touch_activity, user_id, session_id, past_ts})

      assert {:ok, _count} = Store.sweep_idle(600_000)

      {:ok, p_dnd} = Store.get_presence(user_id)
      assert p_dnd.status == :dnd
      assert p_dnd.sessions[session_id].status == :dnd
    end

    test "touch_activity wakes an :idle session back to :online" do
      user_id = "user_wake_1"
      session_id = "sess_wake_1"

      Store.session_connected(user_id, session_id, self(), :online)
      past_ts = System.system_time(:millisecond) - 700_000
      GenServer.call(Store, {:touch_activity, user_id, session_id, past_ts})

      Store.sweep_idle(600_000)
      {:ok, p_idle} = Store.get_presence(user_id)
      assert p_idle.status == :idle

      # User acts now (fresh activity)
      now_ts = System.system_time(:millisecond)
      assert :ok = Store.touch_activity(user_id, session_id, now_ts)

      {:ok, p_online} = Store.get_presence(user_id)
      assert p_online.status == :online
      assert p_online.sessions[session_id].status == :online
    end

    test "multi-session: one active session keeps user :online when other session goes :idle" do
      user_id = "user_multi_idle"
      s_desktop = "sess_desk"
      s_mobile = "sess_mob"

      Store.session_connected(user_id, s_desktop, self(), :online)
      Store.session_connected(user_id, s_mobile, self(), :online)

      # Mobile had no activity for 15 mins; desktop was active just now
      past_ts = System.system_time(:millisecond) - 900_000
      GenServer.call(Store, {:touch_activity, user_id, s_mobile, past_ts})

      assert {:ok, _} = Store.sweep_idle(600_000)

      {:ok, p} = Store.get_presence(user_id)
      # Mobile is idle, desktop is online -> user aggregate status is online!
      assert p.sessions[s_mobile].status == :idle
      assert p.sessions[s_desktop].status == :online
      assert p.status == :online
    end
  end

  describe "Issue #33: manual status updates & invisible status" do
    test "update_status updates declared status, activities, and afk" do
      user_id = "user_status_1"
      session_id = "sess_status_1"
      activities = [%{"name" => "Coding", "type" => 0}]

      Store.session_connected(user_id, session_id, self(), :online)
      assert :ok = Store.update_status(user_id, session_id, "dnd", activities, true)

      assert {:ok, p} = Store.get_presence(user_id)
      assert p.status == :dnd
      assert p.activities == activities
      assert p.sessions[session_id].status == :dnd
      assert p.sessions[session_id].declared_status == :dnd
      assert p.sessions[session_id].activities == activities
      assert p.sessions[session_id].afk == true
    end

    test "update_status with invisible maps to :offline in ETS while retaining session" do
      user_id = "user_invis_1"
      session_id = "sess_invis_1"

      Store.session_connected(user_id, session_id, self(), :online)
      assert :ok = Store.update_status(user_id, session_id, "invisible")

      assert {:ok, p} = Store.get_presence(user_id)
      assert p.status == :offline
      assert p.sessions[session_id].status == :offline
      assert p.sessions[session_id].declared_status == :invisible
      assert Map.has_key?(p.sessions, session_id)

      # User is excluded from list_online
      online_uids = Enum.map(Store.list_online(), & &1.user_id)
      refute user_id in online_uids
    end

    test "multi-session: invisible session does not hide concurrent online session" do
      user_id = "user_invis_multi"
      s1 = "sess_invis"
      s2 = "sess_online"

      Store.session_connected(user_id, s1, self(), :online)
      Store.session_connected(user_id, s2, self(), :online)

      # Mark s1 invisible
      Store.update_status(user_id, s1, "invisible")

      {:ok, p} = Store.get_presence(user_id)
      assert p.sessions[s1].status == :offline
      assert p.sessions[s2].status == :online
      assert p.status == :online

      # Drop online session -> aggregate becomes offline, but s1 remains tracked
      Store.drop_session(user_id, s2)
      {:ok, p2} = Store.get_presence(user_id)
      assert p2.status == :offline
      assert Map.has_key?(p2.sessions, s1)
    end

    test "manual idle declaration is not reverted to online by heartbeat touch" do
      user_id = "user_manual_idle"
      session_id = "sess_man_idle"

      Store.session_connected(user_id, session_id, self(), :online)
      Store.update_status(user_id, session_id, "idle")

      {:ok, p_idle} = Store.get_presence(user_id)
      assert p_idle.status == :idle
      assert p_idle.sessions[session_id].declared_status == :idle

      # Simulate fresh heartbeat touch
      now = System.system_time(:millisecond)
      Store.touch_activity(user_id, session_id, now)

      # Must remain :idle because declared_status is :idle
      {:ok, p_still_idle} = Store.get_presence(user_id)
      assert p_still_idle.status == :idle
      assert p_still_idle.sessions[session_id].status == :idle
    end
  end

  describe "Issue #34: event origination and fan-out integration" do
    test "session_connected, update_status, sweep_idle, and session_disconnected trigger broadcasts" do
      user_id = "user_store_broadcaster_1"
      session_id = "sess_sb_1"
      guild_id = "guild_sb_1"

      Gateway.Guild.Cache.put_member_guilds(user_id, [guild_id])

      # Spawn a listener session in guild_id to receive fanout
      listener_id = "sess_sb_listener"
      {:ok, _} =
        Gateway.Session.get_or_spawn(
          session_id: listener_id,
          user_id: "listener_user_sb",
          guild_ids: [guild_id],
          ws_pid: self()
        )

      # 1. session_connected -> broadcasts :online
      Store.session_connected(user_id, session_id, self(), :online)
      assert_receive {:send_frame, e1, 1, _}, 1000
      assert e1["payload"]["status"] == "online"
      assert e1["payload"]["user"]["id"] == user_id

      # 2. update_status -> broadcasts :dnd with activities
      acts = [%{"name" => "Coding", "type" => 0}]
      Store.update_status(user_id, session_id, "dnd", acts)
      assert_receive {:send_frame, e2, 2, _}, 1000
      assert e2["payload"]["status"] == "dnd"
      assert e2["payload"]["activities"] == acts

      # 3. sweep_idle on a session that becomes idle -> broadcasts :idle
      past_ts = System.system_time(:millisecond) - 700_000
      # Switch to online first to test idle sweep
      Store.update_status(user_id, session_id, "online")
      assert_receive {:send_frame, _e_online, 3, _}, 1000

      # Set old activity timestamp
      GenServer.call(Store, {:touch_activity, user_id, session_id, past_ts})
      {:ok, _} = Store.sweep_idle(600_000)
      assert_receive {:send_frame, e_idle, 4, _}, 1000
      assert e_idle["payload"]["status"] == "idle"

      # 4. Redundant touch_activity while idle with old timestamp does NOT wake or broadcast
      Store.touch_activity(user_id, session_id, past_ts)
      refute_receive {:send_frame, _, _, _}, 100

      # 5. session_disconnected -> broadcasts :offline
      Store.session_disconnected(user_id, session_id)
      assert_receive {:send_frame, e_off, 5, _}, 1000
      assert e_off["payload"]["status"] == "offline"

      Gateway.Session.close(listener_id)
    end
  end
end

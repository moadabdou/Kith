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
end

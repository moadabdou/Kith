defmodule Gateway.Presence.SessionPresenceTest do
  use ExUnit.Case, async: false

  alias Gateway.Session
  alias Gateway.Presence.Store

  @user_id "test_multi_user_9901"
  @session_1 "session_device_web_9901"
  @session_2 "session_device_mobile_9902"
  @table :gateway_presence_store

  setup do
    if :ets.whereis(@table) != :undefined do
      :ets.delete_all_objects(@table)
    end

    on_exit(fn ->
      Session.close(@session_1)
      Session.close(@session_2)
    end)

    :ok
  end

  describe "Gateway.Session presence lifecycle integration" do
    test "spawning sessions automatically registers presence; closing them detaches and transitions to offline" do
      # 1. Start first session for user
      {:ok, pid1} =
        Session.get_or_spawn(
          session_id: @session_1,
          user_id: @user_id,
          guild_ids: [],
          ws_pid: self()
        )

      assert is_pid(pid1)

      {:ok, presence1} = Store.get_presence(@user_id)
      assert presence1.status == :online
      assert Map.has_key?(presence1.sessions, @session_1)
      assert map_size(presence1.sessions) == 1

      # 2. Start second concurrent session for the same user (e.g. mobile)
      {:ok, pid2} =
        Session.get_or_spawn(
          session_id: @session_2,
          user_id: @user_id,
          guild_ids: [],
          ws_pid: self()
        )

      assert is_pid(pid2)

      {:ok, presence2} = Store.get_presence(@user_id)
      assert presence2.status == :online
      assert Map.has_key?(presence2.sessions, @session_1)
      assert Map.has_key?(presence2.sessions, @session_2)
      assert map_size(presence2.sessions) == 2

      # 3. Terminate first session (Session.close invokes terminate/2 -> session_disconnected)
      Session.close(@session_1)
      # Wait briefly for GenServer teardown
      :timer.sleep(50)

      {:ok, presence3} = Store.get_presence(@user_id)
      # User must still be online because session 2 is active!
      assert presence3.status == :online
      refute Map.has_key?(presence3.sessions, @session_1)
      assert Map.has_key?(presence3.sessions, @session_2)
      assert map_size(presence3.sessions) == 1

      # 4. Terminate second session -> transitions user to offline
      Session.close(@session_2)
      :timer.sleep(50)

      {:ok, presence4} = Store.get_presence(@user_id)
      assert presence4.status == :offline
      assert map_size(presence4.sessions) == 0
    end

    test "monitored session actor abnormal exit automatically detaches session from presence store" do
      session_crash_id = "sess_crash_9903"
      user_id = "user_crash_9903"

      {:ok, pid} =
        Session.start_link(
          session_id: session_crash_id,
          user_id: user_id,
          guild_ids: [],
          ws_pid: self()
        )

      Process.unlink(pid)

      {:ok, p_before} = Store.get_presence(user_id)
      assert p_before.status == :online
      assert Map.has_key?(p_before.sessions, session_crash_id)

      # Kill the session actor brutally to simulate crash without clean terminate/2
      Process.exit(pid, :kill)
      :timer.sleep(50)

      {:ok, p_after} = Store.get_presence(user_id)
      assert p_after.status == :offline
      assert map_size(p_after.sessions) == 0
    end

    test "Session.attach preserves existing presence status on reconnect" do
      session_id = "sess_attach_preserve"
      user_id = "user_attach_preserve"
      ws_dummy = spawn(fn -> receive do :stop -> :ok end end)

      {:ok, _session_pid} =
        Session.get_or_spawn(
          session_id: session_id,
          user_id: user_id,
          guild_ids: [],
          ws_pid: ws_dummy
        )

      on_exit(fn -> Session.close(session_id) end)

      # Explicitly set status to :dnd
      Store.put_presence(user_id, :dnd, %{"desktop" => "dnd"}, session_id, ws_dummy)

      {:ok, p_dnd} = Store.get_presence(user_id)
      assert p_dnd.status == :dnd

      # Now simulate socket reconnect via Session.attach with self()
      {:ok, _seq} = Session.attach(session_id, self())

      {:ok, p_reconnect} = Store.get_presence(user_id)
      # Session actor was alive the entire time; presence remains untouched (:dnd)
      assert p_reconnect.status == :dnd
      assert p_reconnect.sessions[session_id].status == :dnd
      assert p_reconnect.sessions[session_id].client_status == %{"desktop" => "dnd"}
    end

    test "socket drop transitions presence to :offline while session remains alive, and RESUME restores :online" do
      session_id = "sess_resume_presence_transition"
      user_id = "user_resume_presence_transition"

      dummy_socket = spawn(fn -> receive do :stop -> :ok end end)

      {:ok, session_pid} =
        Session.get_or_spawn(
          session_id: session_id,
          user_id: user_id,
          guild_ids: [],
          ws_pid: dummy_socket
        )

      on_exit(fn -> Session.close(session_id) end)

      # 1. Connected: user is :online
      {:ok, p1} = Store.get_presence(user_id)
      assert p1.status == :online

      # 2. Socket process dies (simulating TCP drop / kill -9 / zombie 4009)
      Process.exit(dummy_socket, :kill)
      :timer.sleep(30)

      # Session actor is still alive!
      assert Process.alive?(session_pid)

      # Presence transitioned to :offline during disconnect window
      {:ok, p2} = Store.get_presence(user_id)
      assert p2.status == :offline

      # 3. Client reconnects and RESUMEs
      new_socket = spawn(fn -> receive do :stop -> :ok end end)
      assert {:ok, _seq, _missed} = Session.resume(session_id, new_socket, 0, user_id)

      # Presence transitioned back to :online!
      {:ok, p3} = Store.get_presence(user_id)
      assert p3.status == :online
      assert p3.sessions[session_id].status == :online
    end
  end
end

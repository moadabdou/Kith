defmodule Gateway.WS.HandlerTest do
  use ExUnit.Case, async: false

  alias Gateway.WS.Handler
  alias Gateway.Metrics

  setup do
    for {_, pid, _, _} <- DynamicSupervisor.which_children(Gateway.ConnSupervisor) do
      DynamicSupervisor.terminate_child(Gateway.ConnSupervisor, pid)
    end

    if :ets.whereis(:gateway_presence_store) != :undefined do
      :ets.delete_all_objects(:gateway_presence_store)
    end

    Gateway.Typing.RateLimiter.reset()

    :ok
  end

  describe "WebSock callback protocol unit tests" do
    test "init sends HELLO (op 10) with heartbeat_interval and arms 60s identify timer" do
      {:push, [{:text, hello_json}], state} = Handler.init(heartbeat_interval: 10_000)

      assert is_reference(state.identify_timer)
      assert state.identified == false
      assert state.heartbeat_interval == 10_000

      assert {:ok, hello} = Jason.decode(hello_json)
      assert hello["op"] == 10
      assert hello["d"]["heartbeat_interval"] == 10_000
      assert hello["s"] == nil
      assert hello["t"] == nil

      Handler.terminate(:normal, state)
    end

    test "HEARTBEAT (op 1) returns HEARTBEAT ACK (op 11)" do
      {:push, _, state} = Handler.init([])
      payload = Jason.encode!(%{"op" => 1, "d" => nil})

      assert {:push, [{:text, ack_json}], new_state} = Handler.handle_in({payload, opcode: :text}, state)

      assert {:ok, ack} = Jason.decode(ack_json)
      assert ack["op"] == 11
      assert ack["d"] == nil
      assert is_integer(new_state.last_heartbeat_at)

      Handler.terminate(:normal, new_state)
    end

    test "unknown opcode returns close code 4001" do
      {:push, _, state} = Handler.init([])
      payload = Jason.encode!(%{"op" => 999, "d" => %{}})

      assert {:stop, :normal, {4001, "Unknown opcode"}, new_state} =
               Handler.handle_in({payload, opcode: :text}, state)

      assert new_state.close_code == 4001
      Handler.terminate(:normal, new_state)
    end

    test "invalid JSON payload returns close code 4000" do
      {:push, _, state} = Handler.init([])

      assert {:stop, :normal, {4000, "Unknown error"}, new_state} =
               Handler.handle_in({"not json at all {{{", opcode: :text}, state)

      assert new_state.close_code == 4000
      Handler.terminate(:normal, new_state)
    end

    test "IDENTIFY missing token returns close code 4004 (auth failed)" do
      {:push, _, state} = Handler.init([])
      payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => ""}})

      assert {:stop, :normal, {4004, "Authentication failed"}, new_state} =
               Handler.handle_in({payload, opcode: :text}, state)

      assert new_state.close_code == 4004
      Handler.terminate(:normal, new_state)
    end

    test "IDENTIFY with invalid or tampered JWT returns close code 4004" do
      {:push, _, state} = Handler.init([])
      payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => "invalid.jwt.token"}})

      assert {:stop, :normal, {4004, "Authentication failed"}, new_state} =
               Handler.handle_in({payload, opcode: :text}, state)

      assert new_state.close_code == 4004
      Handler.terminate(:normal, new_state)
    end

    test "IDENTIFY with expired JWT returns close code 4004" do
      {:push, _, state} = Handler.init([])
      expired_token = Gateway.Auth.JWT.issue(87000000000000001, state.jwt_secret, -60)
      payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => expired_token}})

      assert {:stop, :normal, {4004, "Authentication failed"}, new_state} =
               Handler.handle_in({payload, opcode: :text}, state)

      assert new_state.close_code == 4004
      Handler.terminate(:normal, new_state)
    end

    test "IDENTIFY with valid JWT dispatches READY (op 0) and warms guild cache" do
      {:push, _, state} = Handler.init([])
      timer = state.identify_timer
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, state.jwt_secret, 3600)
      payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})

      assert {:push, [{:text, ready_json}], new_state} =
               Handler.handle_in({payload, opcode: :text}, state)

      assert new_state.identified == true
      assert new_state.identify_timer == nil
      assert Process.read_timer(timer) == false
      assert is_binary(new_state.session_id)
      assert new_state.seq == 0

      assert {:ok, ready} = Jason.decode(ready_json)
      assert ready["op"] == 0
      assert ready["t"] == "READY"
      assert ready["s"] == 0

      data = ready["d"]
      assert data["user"]["id"] == to_string(user_id)
      assert data["user"]["username"] == "moad"
      assert is_list(data["guilds"])
      assert length(data["guilds"]) >= 1

      hq_guild = Enum.find(data["guilds"], fn g -> g["id"] == "87000000000000100" end)
      assert hq_guild != nil
      assert hq_guild["name"] == "Kith HQ"
      assert length(hq_guild["channels"]) >= 3

      # Verify ETS cache was warmed
      assert {:ok, cached_guild} = Gateway.Guild.Cache.get_guild("87000000000000100")
      assert cached_guild["name"] == "Kith HQ"

      # Verify channel → guild index was warmed
      assert {:ok, "87000000000000100"} = Gateway.Guild.Cache.get_channel_guild("87000000000000201")

      Handler.terminate(:normal, new_state)
      Gateway.Session.close(new_state.session_id)
    end

    test "IDENTIFY timeout when unverified triggers close code 4000" do
      {:push, _, state} = Handler.init([])

      assert {:stop, :normal, {4000, "Identify timeout"}, new_state} =
               Handler.handle_info(:identify_timeout, state)

      assert new_state.close_code == 4000
      Handler.terminate(:normal, new_state)
    end

    test "IDENTIFY timeout ignored when already identified" do
      {:push, _, state} = Handler.init([])
      state = %{state | identified: true}

      assert {:ok, ^state} = Handler.handle_info(:identify_timeout, state)
      Handler.terminate(:normal, state)
    end

    test "rate limit exceeding 120 frames closes with code 4008" do
      {:push, _, state} = Handler.init([])
      heartbeat = Jason.encode!(%{"op" => 1, "d" => nil})

      # Flood 120 heartbeats
      final_state =
        Enum.reduce(1..120, state, fn _, acc ->
          {:push, _, next_state} = Handler.handle_in({heartbeat, opcode: :text}, acc)
          next_state
        end)

      # 121st message triggers 4008
      assert {:stop, :normal, {4008, "Rate limited"}, limited_state} =
               Handler.handle_in({heartbeat, opcode: :text}, final_state)

      assert limited_state.close_code == 4008
      Handler.terminate(:normal, limited_state)
    end

    test "terminate decrements active connections and records close code" do
      before_val = get_active_connections()
      {:push, _, state} = Handler.init([])
      assert get_active_connections() == before_val + 1

      Handler.terminate(:normal, %{state | close_code: 4001})
      assert get_active_connections() == before_val

      out = Metrics.render()
      assert out =~ ~s(gateway_ws_close_codes_total{code="4001"})
    end

    test "send_frame pushes op 0 dispatch frame with monotonic seq and records latency" do
      {:push, _, state} = Handler.init([])
      event = %{"type" => "MESSAGE_CREATE", "data" => %{"id" => "123", "content" => "hello"}}
      bus_ts = System.monotonic_time(:microsecond) - 5000

      assert {:push, [{:text, frame_json}], new_state} =
               Handler.handle_info({:send_frame, event, 1, bus_ts}, state)

      assert new_state.seq == 1
      assert {:ok, frame} = Jason.decode(frame_json)
      assert frame["op"] == 0
      assert frame["s"] == 1
      assert frame["t"] == "MESSAGE_CREATE"
      assert frame["d"]["content"] == "hello"

      out = Metrics.render()
      assert out =~ "gateway_fanout_latency_seconds_count"

      Handler.terminate(:normal, new_state)
    end

    test "close info message terminates connection with given code" do
      {:push, _, state} = Handler.init([])

      assert {:stop, :normal, {4008, "Slow consumer dropped"}, new_state} =
               Handler.handle_info({:close, 4008, "Slow consumer dropped"}, state)

      assert new_state.close_code == 4008
      Handler.terminate(:normal, new_state)
    end

    test "missed heartbeats exceeding 2 intervals closes with 4009 (session timed out)" do
      # 50ms interval => 2 intervals = 100ms
      {:push, _, state} = Handler.init(heartbeat_interval: 50)

      # Simulate elapsed time beyond 2 intervals (e.g. 110ms)
      old_time = System.monotonic_time(:millisecond) - 110
      stale_state = %{state | last_heartbeat_at: old_time}

      assert {:stop, :normal, {4009, "Session timed out"}, new_state} =
               Handler.handle_info(:heartbeat_check, stale_state)

      assert new_state.close_code == 4009
      Handler.terminate(:normal, new_state)

      out = Metrics.render()
      assert out =~ ~s(gateway_ws_close_codes_total{code="4009"})
    end

    test "heartbeats on time keep connection alive and rearm heartbeat timer" do
      {:push, _, state} = Handler.init(heartbeat_interval: 50)

      # Send a heartbeat
      payload = Jason.encode!(%{"op" => 1, "d" => nil})
      {:push, _, active_state} = Handler.handle_in({payload, opcode: :text}, state)

      # Perform check within 2 intervals (e.g. 20ms elapsed)
      assert {:ok, checked_state} = Handler.handle_info(:heartbeat_check, active_state)
      assert is_reference(checked_state.heartbeat_timer)

      Handler.terminate(:normal, checked_state)
    end

    test "zombie timeout closes with 4009 and leaves session resumable until TTL expiration" do
      {:push, _, state} = Handler.init(heartbeat_interval: 50)
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, state.jwt_secret, 3600)
      payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})

      {:push, _, identified_state} = Handler.handle_in({payload, opcode: :text}, state)
      session_id = identified_state.session_id
      assert is_binary(session_id)
      guild_id = "87000000000000100"

      # Guild actor has subscriber
      subs_before = Gateway.Guild.Actor.subscriber_count(guild_id)
      assert subs_before >= 1
      assert Gateway.Session.whereis(session_id) != nil

      # Simulate zombie: missed 2 intervals
      old_time = System.monotonic_time(:millisecond) - 120
      stale_state = %{identified_state | last_heartbeat_at: old_time}

      {:stop, :normal, {4009, _}, closing_state} =
        Handler.handle_info(:heartbeat_check, stale_state)

      Handler.terminate(:normal, closing_state)

      # Session actor is STILL ALIVE for RESUME within disconnect TTL
      assert Gateway.Session.whereis(session_id) != nil

      # Presence remains :online while session actor is alive during disconnect TTL window
      {:ok, presence} = Gateway.Presence.Store.get_presence(user_id)
      assert presence.status == :online

      # When session is explicitly closed or TTL expires, full cleanup occurs
      close_session(session_id)
      assert Gateway.Session.whereis(session_id) == nil
      assert Gateway.Guild.Actor.subscriber_count(guild_id) == subs_before - 1

      # After session actor terminates, presence transitions to :offline
      {:ok, presence_after} = Gateway.Presence.Store.get_presence(user_id)
      assert presence_after.status == :offline
    end

    test "HEARTBEAT (op 1) touches activity in Gateway.Presence.Store" do
      {:push, _, state} = Handler.init(heartbeat_interval: 10_000)
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, state.jwt_secret, 3600)
      payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})

      {:push, _, identified_state} = Handler.handle_in({payload, opcode: :text}, state)
      session_id = identified_state.session_id

      # Verify initial presence
      {:ok, p_init} = Gateway.Presence.Store.get_presence(user_id)
      assert p_init.status == :online

      # Send heartbeat with custom last_activity timestamp in the future
      future_ts = p_init.last_activity_at + 10_000
      hb_payload = Jason.encode!(%{"op" => 1, "d" => %{"last_activity" => future_ts}})

      assert {:push, [{:text, ack_json}], _hb_state} =
               Handler.handle_in({hb_payload, opcode: :text}, identified_state)

      assert {:ok, ack} = Jason.decode(ack_json)
      assert ack["op"] == 11

      # Verify presence store activity timestamp was bumped
      {:ok, p_after} = Gateway.Presence.Store.get_presence(user_id)
      assert p_after.last_activity_at == future_ts
      assert p_after.sessions[session_id].last_activity_at == future_ts

      Handler.terminate(:normal, identified_state)
      Gateway.Session.close(session_id)
    end

    test "STATUS_UPDATE (op 3) updates presence status and activities when identified" do
      {:push, _, state} = Handler.init(heartbeat_interval: 10_000)
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, state.jwt_secret, 3600)
      id_payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})

      {:push, _, identified_state} = Handler.handle_in({id_payload, opcode: :text}, state)
      session_id = identified_state.session_id

      # Send Opcode 3 with dnd and activities
      activities = [%{"name" => "Playing Elixir", "type" => 0}]

      update_payload =
        Jason.encode!(%{
          "op" => 3,
          "d" => %{
            "status" => "dnd",
            "activities" => activities,
            "afk" => false,
            "since" => 1_700_000_000_000
          }
        })

      assert {:ok, new_state} = Handler.handle_in({update_payload, opcode: :text}, identified_state)
      assert new_state.identified == true
      assert new_state.close_code == nil
      assert new_state.session_id == session_id

      # Verify presence store was updated
      {:ok, presence} = Gateway.Presence.Store.get_presence(user_id)
      assert presence.status == :dnd
      assert presence.activities == activities
      assert presence.sessions[session_id].status == :dnd
      assert presence.sessions[session_id].declared_status == :dnd
      assert presence.sessions[session_id].activities == activities

      Handler.terminate(:normal, identified_state)
      close_session(session_id)
    end

    test "STATUS_UPDATE (op 3) with invisible maps to offline in presence store" do
      {:push, _, state} = Handler.init(heartbeat_interval: 10_000)
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, state.jwt_secret, 3600)
      id_payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})

      {:push, _, identified_state} = Handler.handle_in({id_payload, opcode: :text}, state)
      session_id = identified_state.session_id

      # Send Opcode 3 with invisible
      update_payload =
        Jason.encode!(%{
          "op" => 3,
          "d" => %{
            "status" => "invisible",
            "activities" => [],
            "afk" => false,
            "since" => nil
          }
        })

      assert {:ok, _} = Handler.handle_in({update_payload, opcode: :text}, identified_state)

      {:ok, presence} = Gateway.Presence.Store.get_presence(user_id)
      assert presence.status == :offline
      assert presence.sessions[session_id].status == :offline
      assert presence.sessions[session_id].declared_status == :invisible

      Handler.terminate(:normal, identified_state)
      close_session(session_id)
    end

    test "STATUS_UPDATE (op 3) before IDENTIFY is safely ignored" do
      {:push, _, state} = Handler.init(heartbeat_interval: 10_000)
      update_payload = Jason.encode!(%{"op" => 3, "d" => %{"status" => "online"}})

      assert {:ok, new_state} = Handler.handle_in({update_payload, opcode: :text}, state)
      assert new_state.identified == false
      assert new_state.close_code == nil
      assert new_state.session_id == nil

      Handler.terminate(:normal, new_state)
    end

    test "STATUS_UPDATE (op 3) with invalid status or non-map payload is safely ignored without closing connection" do
      {:push, _, state} = Handler.init(heartbeat_interval: 10_000)
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, state.jwt_secret, 3600)
      id_payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})

      {:push, _, identified_state} = Handler.handle_in({id_payload, opcode: :text}, state)
      session_id = identified_state.session_id

      # Invalid status string
      bad_status_payload = Jason.encode!(%{"op" => 3, "d" => %{"status" => "sleeping"}})
      assert {:ok, state1} = Handler.handle_in({bad_status_payload, opcode: :text}, identified_state)
      assert state1.close_code == nil

      # Non-map d payload
      bad_d_payload = Jason.encode!(%{"op" => 3, "d" => "not_a_map"})
      assert {:ok, state2} = Handler.handle_in({bad_d_payload, opcode: :text}, state1)
      assert state2.close_code == nil

      # Missing d entirely
      missing_d_payload = Jason.encode!(%{"op" => 3})
      assert {:ok, state3} = Handler.handle_in({missing_d_payload, opcode: :text}, state2)
      assert state3.close_code == nil

      # Presence remains online
      {:ok, presence} = Gateway.Presence.Store.get_presence(user_id)
      assert presence.status == :online

      Handler.terminate(:normal, identified_state)
      close_session(session_id)
    end

    test "TYPING_START broadcasts dispatch frame to guild subscribers once per 8s cooldown window" do
      {:push, _, state} = Handler.init(heartbeat_interval: 10_000)
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, state.jwt_secret, 3600)
      id_payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})

      {:push, _, identified_state} = Handler.handle_in({id_payload, opcode: :text}, state)
      session_id = identified_state.session_id
      # Real seeded channel of Kith HQ (guild 87000000000000100), warm in cache after IDENTIFY
      channel_id = "87000000000000201"

      typing_payload = Jason.encode!(%{"t" => "TYPING_START", "d" => %{"channel_id" => channel_id}})

      # 1. First typing frame passes the rate limiter and is broadcast:
      #    the typer's own session (ws_pid = test process) receives the dispatch
      assert {:ok, s1} = Handler.handle_in({typing_payload, opcode: :text}, identified_state)
      assert s1.close_code == nil

      assert_receive {:send_frame, event, seq, bus_ts}, 1000

      assert event["type"] == "TYPING_START"
      assert event["version"] == 1
      assert event["guild_id"] == "87000000000000100"
      assert is_nil(bus_ts)
      assert is_integer(seq)

      payload = event["payload"]
      assert payload["channel_id"] == channel_id
      assert payload["user_id"] == to_string(user_id)
      assert payload["guild_id"] == "87000000000000100"
      assert is_integer(payload["timestamp"])
      assert abs(payload["timestamp"] - System.system_time(:second)) <= 5

      # 2. The dispatch frame encodes to a valid op 0 wire frame
      assert {:push, [{:text, frame_json}], _} = Handler.handle_info({:send_frame, event, seq, bus_ts}, s1)
      assert {:ok, frame} = Jason.decode(frame_json)
      assert frame["t"] == "TYPING_START"
      assert frame["op"] == 0
      assert frame["s"] == seq
      assert frame["d"]["channel_id"] == channel_id
      assert frame["d"]["user_id"] == to_string(user_id)
      assert is_integer(frame["d"]["timestamp"])

      # 3. Second and third typing frames within the 8s cooldown are silently
      #    dropped: no close, no additional TYPING_START dispatch
      assert {:ok, s2} = Handler.handle_in({typing_payload, opcode: :text}, s1)
      assert s2.close_code == nil
      assert {:ok, s3} = Handler.handle_in({typing_payload, opcode: :text}, s2)
      assert s3.close_code == nil

      refute_receive {:send_frame, %{"type" => "TYPING_START"}, _, _}, 200

      Handler.terminate(:normal, s3)
      close_session(session_id)
    end

    test "TYPING_START before IDENTIFY, with missing/unknown channel_id is safely ignored" do
      {:push, _, state} = Handler.init(heartbeat_interval: 10_000)

      # 1. Pre-IDENTIFY typing frame ignored
      payload1 = Jason.encode!(%{"t" => "TYPING_START", "d" => %{"channel_id" => "123"}})
      assert {:ok, s1} = Handler.handle_in({payload1, opcode: :text}, state)
      assert s1.identified == false
      assert s1.close_code == nil

      # 2. Identified but missing channel_id
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, state.jwt_secret, 3600)
      id_payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})
      {:push, _, identified} = Handler.handle_in({id_payload, opcode: :text}, s1)

      payload2 = Jason.encode!(%{"t" => "TYPING_START", "d" => %{}})
      assert {:ok, s2} = Handler.handle_in({payload2, opcode: :text}, identified)
      assert s2.close_code == nil

      payload3 = Jason.encode!(%{"t" => "TYPING_START", "d" => "not_a_map"})
      assert {:ok, s3} = Handler.handle_in({payload3, opcode: :text}, s2)
      assert s3.close_code == nil

      # 3. Unknown channel: guild resolution fails and the frame is dropped
      #    without closing the connection or emitting any dispatch
      payload4 = Jason.encode!(%{"t" => "TYPING_START", "d" => %{"channel_id" => "99999999999999999"}})
      assert {:ok, s4} = Handler.handle_in({payload4, opcode: :text}, s3)
      assert s4.close_code == nil

      refute_receive {:send_frame, %{"type" => "TYPING_START"}, _, _}, 200

      Handler.terminate(:normal, s4)
      close_session(identified.session_id)
    end

    test "RESUME (op 6) with valid token and seq replays missed frames in sequence" do
      {:push, _, conn1} = Handler.init(heartbeat_interval: 10_000)
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, conn1.jwt_secret, 3600)

      # 1. First connection IDENTIFY
      id_payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})
      {:push, _, identified1} = Handler.handle_in({id_payload, opcode: :text}, conn1)
      session_id = identified1.session_id
      assert is_binary(session_id)

      session_pid = Gateway.Session.whereis(session_id)
      assert is_pid(session_pid)

      # Allow initial PRESENCE_UPDATE from IDENTIFY to settle at session actor
      :timer.sleep(50)
      {:ok, init_info} = Gateway.Session.info(session_id)
      base_seq = init_info.seq

      # 2. Dispatch events 1 and 2 to session
      e1 = %{"type" => "MESSAGE_CREATE", "data" => %{"content" => "first"}}
      e2 = %{"type" => "MESSAGE_CREATE", "data" => %{"content" => "second"}}
      send(session_pid, {:dispatch, e1, 0})
      send(session_pid, {:dispatch, e2, 0})
      :timer.sleep(20)

      # 3. Connection 1 drops unexpectedly (TCP disconnect -> Handler.terminate with nil close_code)
      Handler.terminate(:closed, identified1)

      # Session is STILL ALIVE for RESUME!
      assert Gateway.Session.whereis(session_id) == session_pid

      # 4. Dispatch event 3 while client is disconnected (buffered in session replay)
      e3 = %{"type" => "MESSAGE_CREATE", "data" => %{"content" => "third"}}
      send(session_pid, {:dispatch, e3, 0})
      :timer.sleep(20)

      # 5. Connection 2 reconnects and sends RESUME from (base_seq + 1) (missed events 2 and 3)
      {:push, _, conn2} = Handler.init(heartbeat_interval: 10_000)
      resume_payload =
        Jason.encode!(%{
          "op" => 6,
          "d" => %{
            "token" => token,
            "session_id" => session_id,
            "seq" => base_seq + 1
          }
        })

      assert {:push, replay_frames, resumed_state} =
               Handler.handle_in({resume_payload, opcode: :text}, conn2)

      assert resumed_state.identified == true
      assert resumed_state.session_id == session_id
      assert resumed_state.seq == base_seq + 3

      # Verify 2 frames were replayed in exact order with seq (base_seq + 2) and (base_seq + 3)
      assert length(replay_frames) == 2
      [{:text, f2_json}, {:text, f3_json}] = replay_frames

      assert {:ok, f2} = Jason.decode(f2_json)
      assert f2["op"] == 0
      assert f2["s"] == base_seq + 2
      assert f2["t"] == "MESSAGE_CREATE"
      assert f2["d"]["content"] == "second"

      assert {:ok, f3} = Jason.decode(f3_json)
      assert f3["op"] == 0
      assert f3["s"] == base_seq + 3
      assert f3["t"] == "MESSAGE_CREATE"
      assert f3["d"]["content"] == "third"

      # 6. Check metrics
      assert Metrics.get_resumes() >= 1
      out = Metrics.render()
      assert out =~ ~s(gateway_resumes_total)
      assert out =~ ~s(gateway_resume_replay_size)

      # Cleanup
      Handler.terminate(:normal, resumed_state)
      Gateway.Session.close(session_id)
    end

    test "RESUME with non-existent or expired session_id sends Opcode 9 (INVALID_SESSION false)" do
      {:push, _, state} = Handler.init([])
      user_id = 87000000000000001
      token = Gateway.Auth.JWT.issue(user_id, state.jwt_secret, 3600)

      resume_payload =
        Jason.encode!(%{
          "op" => 6,
          "d" => %{
            "token" => token,
            "session_id" => "non-existent-session-id",
            "seq" => 5
          }
        })

      assert {:push, [{:text, op9_json}], new_state} =
               Handler.handle_in({resume_payload, opcode: :text}, state)

      assert {:ok, op9} = Jason.decode(op9_json)
      assert op9["op"] == 9
      assert op9["d"] == false
      assert new_state.identified == false
      assert is_reference(new_state.identify_timer)

      # Socket is still open; client now sends full IDENTIFY
      id_payload = Jason.encode!(%{"op" => 2, "d" => %{"token" => token}})
      assert {:push, [{:text, ready_json}], identified_state} =
               Handler.handle_in({id_payload, opcode: :text}, new_state)

      assert {:ok, ready} = Jason.decode(ready_json)
      assert ready["op"] == 0
      assert ready["t"] == "READY"

      Handler.terminate(:normal, identified_state)
      Gateway.Session.close(identified_state.session_id)
    end

    test "RESUME with unbufferable gap sends Opcode 9" do
      {:push, _, conn} = Handler.init([])
      user_id = 87000000000000004
      token = Gateway.Auth.JWT.issue(user_id, conn.jwt_secret, 3600)
      session_id = "test-gap-session-1"

      # Spawn session with small capacity = 2
      {:ok, session_pid} =
        Gateway.Session.get_or_spawn(
          session_id: session_id,
          user_id: user_id,
          guild_ids: ["87000000000000100"],
          ws_pid: nil,
          ring_capacity: 2
        )

      send(session_pid, {:dispatch, %{"type" => "M1"}, 0})
      send(session_pid, {:dispatch, %{"type" => "M2"}, 0})
      send(session_pid, {:dispatch, %{"type" => "M3"}, 0})
      :timer.sleep(20)

      # Resuming with seq 0 requires seq 1, which was evicted
      resume_payload =
        Jason.encode!(%{
          "op" => 6,
          "d" => %{
            "token" => token,
            "session_id" => session_id,
            "seq" => 0
          }
        })

      assert {:push, [{:text, op9_json}], _} =
               Handler.handle_in({resume_payload, opcode: :text}, conn)

      assert {:ok, op9} = Jason.decode(op9_json)
      assert op9["op"] == 9
      assert op9["d"] == false

      Gateway.Session.close(session_id)
    end

    test "RESUME with invalid JWT closes connection with 4004" do
      {:push, _, state} = Handler.init([])

      resume_payload =
        Jason.encode!(%{
          "op" => 6,
          "d" => %{
            "token" => "bad.jwt.token",
            "session_id" => "some-session",
            "seq" => 0
          }
        })

      assert {:stop, :normal, {4004, "Authentication failed"}, closing_state} =
               Handler.handle_in({resume_payload, opcode: :text}, state)

      assert closing_state.close_code == 4004
    end
  end

  describe "End-to-end WebSocket over Bandit" do
    test "raw client connects to /ws, completes handshake, and receives HELLO frame" do
      port = get_bandit_port()

      {:ok, socket} = :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false], 3000)

      # HTTP Upgrade request
      upgrade_req =
        "GET /ws HTTP/1.1\r\n" <>
          "Host: 127.0.0.1:#{port}\r\n" <>
          "Upgrade: websocket\r\n" <>
          "Connection: Upgrade\r\n" <>
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" <>
          "Sec-WebSocket-Version: 13\r\n\r\n"

      :ok = :gen_tcp.send(socket, upgrade_req)

      # Read 101 Switching Protocols
      {:ok, response} = :gen_tcp.recv(socket, 0, 3000)
      assert response =~ "101 Switching Protocols"
      assert response =~ "upgrade: websocket" or response =~ "Upgrade: websocket"

      # Next frame received from server must be HELLO (op 10)
      payload =
        case extract_ws_text(response) do
          {:ok, text} -> text
          :pending ->
            {:ok, frame} = :gen_tcp.recv(socket, 0, 3000)
            {:ok, text} = extract_ws_text(frame)
            text
        end

      assert {:ok, hello} = Jason.decode(payload)
      assert hello["op"] == 10
      assert hello["d"]["heartbeat_interval"] == 10_000

      :gen_tcp.close(socket)
    end
  end

  defp get_bandit_port do
    {_, pid, _, _} =
      Enum.find(Supervisor.which_children(Gateway.Supervisor), fn {id, _, _, _} -> id == Bandit end)

    {:ok, {_, port}} = ThousandIsland.listener_info(pid)
    port
  end

  defp get_active_connections do
    case Regex.run(~r/gateway_connections_active (\d+)/, Metrics.render()) do
      [_, count_str] -> String.to_integer(count_str)
      _ -> 0
    end
  end

  # Helper to parse unmasked WebSocket text frame from server
  defp extract_ws_text(data) do
    case :binary.split(data, "\r\n\r\n") do
      [_headers, ws_data] when byte_size(ws_data) > 0 ->
        decode_server_frame(ws_data)

      _ ->
        decode_server_frame(data)
    end
  end

  defp decode_server_frame(<<1::1, 0::3, 1::4, 0::1, len::7, rest::binary>>) when len < 126 do
    <<payload::binary-size(len), _::binary>> = rest
    {:ok, payload}
  end

  defp decode_server_frame(<<1::1, 0::3, 1::4, 0::1, 126::7, len::16, rest::binary>>) do
    <<payload::binary-size(len), _::binary>> = rest
    {:ok, payload}
  end

  defp decode_server_frame(_), do: :pending

  defp close_session(session_id) do
    case Gateway.Session.whereis(session_id) do
      pid when is_pid(pid) ->
        ref = Process.monitor(pid)
        Gateway.Session.close(session_id)

        receive do
          {:DOWN, ^ref, :process, ^pid, _} -> :ok
        after
          500 -> :ok
        end

      nil ->
        :ok
    end
  end
end

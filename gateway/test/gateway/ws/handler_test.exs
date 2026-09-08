defmodule Gateway.WS.HandlerTest do
  use ExUnit.Case, async: false

  alias Gateway.WS.Handler
  alias Gateway.Metrics

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

    test "zombie timeout cleans up session and leaves no orphan subscribers in guild actor" do
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

      # Verify full cleanup: session actor stopped, no orphan subscriber in guild actor
      :timer.sleep(30)
      assert Gateway.Session.whereis(session_id) == nil
      assert Gateway.Guild.Actor.subscriber_count(guild_id) == subs_before - 1
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

      # 5. Connection 2 reconnects and sends RESUME from seq 1 (missed events 2 and 3)
      {:push, _, conn2} = Handler.init(heartbeat_interval: 10_000)
      resume_payload =
        Jason.encode!(%{
          "op" => 6,
          "d" => %{
            "token" => token,
            "session_id" => session_id,
            "seq" => 1
          }
        })

      assert {:push, replay_frames, resumed_state} =
               Handler.handle_in({resume_payload, opcode: :text}, conn2)

      assert resumed_state.identified == true
      assert resumed_state.session_id == session_id
      assert resumed_state.seq == 3

      # Verify 2 frames were replayed in exact order with seq 2 and 3
      assert length(replay_frames) == 2
      [{:text, f2_json}, {:text, f3_json}] = replay_frames

      assert {:ok, f2} = Jason.decode(f2_json)
      assert f2["op"] == 0
      assert f2["s"] == 2
      assert f2["t"] == "MESSAGE_CREATE"
      assert f2["d"]["content"] == "second"

      assert {:ok, f3} = Jason.decode(f3_json)
      assert f3["op"] == 0
      assert f3["s"] == 3
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
end

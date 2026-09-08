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
      assert Gateway.Guild.Actor.subscriber_count(guild_id) >= 1
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
      assert Gateway.Guild.Actor.subscriber_count(guild_id) == 0
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

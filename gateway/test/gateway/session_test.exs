defmodule Gateway.SessionTest do
  use ExUnit.Case, async: false

  alias Gateway.Session
  alias Gateway.Metrics

  @test_session_id "test-session-99901"
  @test_session_id_2 "test-session-99902"
  @test_guild_id "999888001"

  setup do
    Enum.each([@test_session_id, @test_session_id_2], fn sid ->
      Session.close(sid)
    end)

    :ok
  end

  describe "Session lifecycle and active event streaming" do
    test "spawns under ConnSupervisor, registers, and streams events" do
      {:ok, session_pid} =
        Session.get_or_spawn(
          session_id: @test_session_id,
          user_id: 12345,
          guild_ids: [@test_guild_id],
          ws_pid: self()
        )

      assert is_pid(session_pid)
      assert Session.whereis(@test_session_id) == session_pid

      # Send simulated dispatch event to Session
      event = %{"type" => "MESSAGE_CREATE", "guild_id" => @test_guild_id, "data" => %{"content" => "hi"}}
      send(session_pid, {:dispatch, event, System.monotonic_time(:microsecond)})

      # Receiver (self) should receive {:send_frame, event, seq, bus_received_at}
      assert_receive {:send_frame, ^event, 1, _bus_ts}, 500

      # Check Session info
      assert {:ok, info} = Session.info(@test_session_id)
      assert info.seq == 1
      assert info.replay_size == 1

      # Replay buffer check
      assert {:ok, [^event]} = Session.get_replay(@test_session_id, 1, 1)

      Session.close(@test_session_id)
    end

    test "buffers events during socket disconnect and replays on attach" do
      # Start dummy socket process
      socket_pid = spawn(fn ->
        receive do
          :die -> :ok
        end
      end)

      {:ok, session_pid} =
        Session.get_or_spawn(
          session_id: @test_session_id,
          user_id: 12345,
          guild_ids: [@test_guild_id],
          ws_pid: socket_pid,
          disconnect_ttl_ms: 1000
        )

      # Send first event
      e1 = %{"type" => "MESSAGE_CREATE", "data" => %{"text" => "1"}}
      send(session_pid, {:dispatch, e1, System.monotonic_time(:microsecond)})
      :timer.sleep(20)

      # Kill socket process to simulate TCP drop
      Process.exit(socket_pid, :kill)
      :timer.sleep(20)

      # Socket is dead, but Session is STILL ALIVE and continues buffering
      assert Process.alive?(session_pid)
      e2 = %{"type" => "MESSAGE_CREATE", "data" => %{"text" => "2"}}
      send(session_pid, {:dispatch, e2, System.monotonic_time(:microsecond)})

      {:ok, info} = Session.info(@test_session_id)
      assert info.seq == 2
      assert info.replay_size == 2
      assert info.ws_pid == nil

      # Replay missed frames from seq 1 to 2
      assert {:ok, [^e1, ^e2]} = Session.get_replay(@test_session_id, 1, 2)

      # Re-attach to new socket (self)
      assert {:ok, 2} = Session.attach(@test_session_id, self())

      # Session should now stream next event to self
      e3 = %{"type" => "MESSAGE_CREATE", "data" => %{"text" => "3"}}
      send(session_pid, {:dispatch, e3, System.monotonic_time(:microsecond)})
      assert_receive {:send_frame, ^e3, 3, _ts}, 500

      Session.close(@test_session_id)
    end

    test "slow consumer drop when outbound queue exceeds limit" do
      # Fake a stalled receiver process with deep mailbox
      stalled_receiver = spawn(fn ->
        receive do
          :never -> :ok
        end
      end)

      # Pre-fill stalled_receiver mailbox with dummy messages
      Enum.each(1..50, fn i -> send(stalled_receiver, {:dummy, i}) end)

      # Create session with very low max_queue_len: 20
      {:ok, session_pid} =
        Session.get_or_spawn(
          session_id: @test_session_id_2,
          user_id: 12345,
          guild_ids: [@test_guild_id],
          ws_pid: stalled_receiver,
          max_queue_len: 20
        )

      initial_drops = Metrics.get_slow_consumer_drops()

      event = %{"type" => "BURST_EVENT", "data" => %{}}
      send(session_pid, {:dispatch, event, System.monotonic_time(:microsecond)})

      # Give GenServer time to process
      :timer.sleep(30)

      # Verified: stalled_receiver received close signal with code 4008
      assert_receive_in_process(stalled_receiver, {:close, 4008, "Slow consumer dropped"})
      assert Metrics.get_slow_consumer_drops() == initial_drops + 1

      Session.close(@test_session_id_2)
    end
  end

  defp assert_receive_in_process(pid, expected) do
    {:messages, msgs} = Process.info(pid, :messages)
    assert Enum.member?(msgs, expected)
  end
end

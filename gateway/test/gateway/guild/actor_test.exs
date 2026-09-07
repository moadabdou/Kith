defmodule Gateway.Guild.ActorTest do
  use ExUnit.Case, async: false

  alias Gateway.Guild.Actor
  alias Gateway.Metrics

  @test_guild_id "99900000000000001"
  @test_guild_id_2 "99900000000000002"
  @test_guild_id_3 "99900000000000003"

  setup do
    # Ensure any lingering test actors from previous runs are cleaned up
    Enum.each([@test_guild_id, @test_guild_id_2, @test_guild_id_3], fn gid ->
      case Actor.whereis(gid) do
        pid when is_pid(pid) ->
          DynamicSupervisor.terminate_child(Gateway.GuildSupervisor, pid)
        nil ->
          :ok
      end
    end)

    :ok
  end

  describe "Actor lifecycle and registry" do
    test "get_or_spawn spawns actor under GuildSupervisor and registers in Gateway.Registry" do
      assert Actor.whereis(@test_guild_id) == nil

      assert {:ok, pid1} = Actor.get_or_spawn(@test_guild_id)
      assert is_pid(pid1)
      assert Process.alive?(pid1)

      # In Registry with unique key
      assert [{^pid1, nil}] = Registry.lookup(Gateway.Registry, @test_guild_id)
      assert Actor.whereis(@test_guild_id) == pid1

      # Second call returns the same PID
      assert {:ok, pid2} = Actor.get_or_spawn(@test_guild_id)
      assert pid1 == pid2
    end
  end

  describe "Subscriber tracking" do
    test "tracks subscribers and handles explicit unsubscribe" do
      session_id = "sess-12345"
      {:ok, _pid} = Actor.get_or_spawn(@test_guild_id)

      assert Actor.subscriber_count(@test_guild_id) == 0
      assert Actor.subscribers(@test_guild_id) == []

      # Subscribe calling process
      assert :ok == Actor.subscribe(@test_guild_id, session_id, self())
      assert Actor.subscriber_count(@test_guild_id) == 1
      assert Actor.subscribers(@test_guild_id) == [{session_id, self()}]

      # Explicit unsubscribe
      assert :ok == Actor.unsubscribe(@test_guild_id, session_id)
      assert Actor.subscriber_count(@test_guild_id) == 0
      assert Actor.subscribers(@test_guild_id) == []
    end

    test "cleans up subscriber automatically via Process.monitor on subscriber process death" do
      session_id = "sess-crash-me"
      {:ok, _actor_pid} = Actor.get_or_spawn(@test_guild_id)

      # Spawn an ephemeral subscriber process
      subscriber_pid =
        spawn(fn ->
          receive do
            :stop -> :ok
          end
        end)

      assert :ok == Actor.subscribe(@test_guild_id, session_id, subscriber_pid)
      assert Actor.subscriber_count(@test_guild_id) == 1

      # Kill the subscriber process
      Process.exit(subscriber_pid, :kill)

      # Give GenServer time to receive {:DOWN, ...}
      eventually(fn ->
        assert Actor.subscriber_count(@test_guild_id) == 0
        assert Actor.subscribers(@test_guild_id) == []
      end)
    end

    test "re-subscribing with same session_id replaces cleanly without duplicate monitors" do
      session_id = "sess-replace"
      {:ok, _actor_pid} = Actor.get_or_spawn(@test_guild_id)

      p1 = spawn(fn -> receive do: (_ -> :ok) end)
      p2 = spawn(fn -> receive do: (_ -> :ok) end)

      assert :ok == Actor.subscribe(@test_guild_id, session_id, p1)
      assert Actor.subscriber_count(@test_guild_id) == 1

      # Re-subscribe same session_id with new PID
      assert :ok == Actor.subscribe(@test_guild_id, session_id, p2)
      assert Actor.subscriber_count(@test_guild_id) == 1
      assert Actor.subscribers(@test_guild_id) == [{session_id, p2}]

      # Killing the old PID p1 should NOT affect the current subscriber
      Process.exit(p1, :kill)
      :timer.sleep(20)
      assert Actor.subscriber_count(@test_guild_id) == 1

      Process.exit(p2, :kill)
      eventually(fn ->
        assert Actor.subscriber_count(@test_guild_id) == 0
      end)
    end
  end

  describe "TTL reaper and metrics" do
    test "terminates cleanly with :normal when 0 subscribers remain after TTL" do
      initial_actors = Metrics.get_guild_actors_active()

      # Spawn with very short TTL: 50ms
      {:ok, pid} = Actor.get_or_spawn(@test_guild_id_2, ttl_ms: 50)
      ref = Process.monitor(pid)

      assert Metrics.get_guild_actors_active() == initial_actors + 1

      # Wait for TTL expiry (actor starts with 0 subscribers)
      assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 500

      # Verified dead and decremented
      assert Actor.whereis(@test_guild_id_2) == nil
      assert Metrics.get_guild_actors_active() == initial_actors
    end

    test "new subscriber cancels pending TTL shutdown" do
      {:ok, pid} = Actor.get_or_spawn(@test_guild_id_3, ttl_ms: 100)
      ref = Process.monitor(pid)

      # Subscribe before 100ms expires
      :ok = Actor.subscribe(@test_guild_id_3, "sess-keepalive", self())

      # Wait longer than TTL
      :timer.sleep(150)

      # Actor should still be alive
      assert Process.alive?(pid)
      refute_receive {:DOWN, ^ref, :process, ^pid, _}

      # Now unsubscribe
      :ok = Actor.unsubscribe(@test_guild_id_3, "sess-keepalive")

      # Actor should terminate after TTL
      assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 500
      assert Actor.whereis(@test_guild_id_3) == nil
    end
  end

  defp eventually(assertion_fn, attempts \\ 20, delay_ms \\ 10) do
    assertion_fn.()
  rescue
    e in [ExUnit.AssertionError] ->
      if attempts > 0 do
        :timer.sleep(delay_ms)
        eventually(assertion_fn, attempts - 1, delay_ms)
      else
        reraise e, __STACKTRACE__
      end
  end
end

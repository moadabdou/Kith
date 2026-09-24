defmodule Gateway.Voice.SfuHealthTest do
  use ExUnit.Case, async: false

  alias Gateway.Voice.SfuHealth

  # Each test gets an isolated unnamed GenServer + private ETS table
  # (table: opt) with an injected probe — deterministic, no network, and no
  # interference with the supervised SfuHealth from the app boot.
  setup do
    System.put_env("VOICE_SFU_POOL", "ep-a:5000,ep-b:5001")

    on_exit(fn ->
      System.delete_env("VOICE_SFU_POOL")
    end)

    :ok
  end

  defp start_isolated(opts) do
    table = :"sfu_health_test_#{System.unique_integer([:positive, :monotonic])}"
    {:ok, pid} = GenServer.start(SfuHealth, Keyword.put(opts, :table, table))
    {pid, table}
  end

  test "healthy pool stays fully live" do
    {pid, _} = start_isolated(probe: fn _ep, _t -> true end, interval_ms: 60_000)
    SfuHealth.poll_now(pid)
    wait_checks(pid, 2)
    assert Enum.sort(SfuHealth.live_of(pid)) == ["ep-a:5000", "ep-b:5001"]
    GenServer.stop(pid, :normal)
  end

  test "dead endpoint excluded after threshold" do
    test_pid = self()

    probe = fn endpoint, _t ->
      send(test_pid, {:probed, endpoint})
      endpoint == "ep-a:5000"
    end

    {pid, _} =
      start_isolated(probe: probe, interval_ms: 60_000, fail_threshold: 2, recover_threshold: 2)

    # First failure: still live (threshold 2).
    SfuHealth.poll_now(pid)
    wait_checks(pid, 2)
    assert_received {:probed, "ep-a:5000"}
    assert_received {:probed, "ep-b:5001"}
    assert Enum.sort(SfuHealth.live_of(pid)) == ["ep-a:5000", "ep-b:5001"]

    # Second consecutive failure: excluded.
    SfuHealth.poll_now(pid)
    wait_checks(pid, 4)
    assert Enum.sort(SfuHealth.live_of(pid)) == ["ep-a:5000"]

    GenServer.stop(pid, :normal)
  end

  test "dead endpoint resurrected after consecutive successes" do
    {:ok, ep_b_failures} = Agent.start_link(fn -> 2 end)

    probe = fn endpoint, _t ->
      if endpoint == "ep-b:5001" do
        Agent.get_and_update(ep_b_failures, fn
          0 -> {true, 0}
          n -> {false, n - 1}
        end)
      else
        true
      end
    end

    {pid, _} =
      start_isolated(probe: probe, interval_ms: 60_000, fail_threshold: 2, recover_threshold: 2)

    SfuHealth.poll_now(pid)
    wait_checks(pid, 2)
    SfuHealth.poll_now(pid)
    wait_checks(pid, 4)
    assert SfuHealth.live_of(pid) == ["ep-a:5000"]

    SfuHealth.poll_now(pid)
    wait_checks(pid, 6)
    SfuHealth.poll_now(pid)
    wait_checks(pid, 8)
    assert Enum.sort(SfuHealth.live_of(pid)) == ["ep-a:5000", "ep-b:5001"]

    GenServer.stop(pid, :normal)
  end

  test "single transient failure never flips (flap damping)" do
    {:ok, fail_once} = Agent.start_link(fn -> false end)

    probe = fn endpoint, _t ->
      if endpoint == "ep-b:5001" and not Agent.get(fail_once, & &1) do
        Agent.update(fail_once, fn _ -> true end)
        false
      else
        true
      end
    end

    {pid, _} = start_isolated(probe: probe, interval_ms: 60_000, fail_threshold: 2)
    SfuHealth.poll_now(pid)
    wait_checks(pid, 2)
    SfuHealth.poll_now(pid)
    wait_checks(pid, 4)

    assert Enum.sort(SfuHealth.live_of(pid)) == ["ep-a:5000", "ep-b:5001"]
    GenServer.stop(pid, :normal)
  end

  test "total outage falls back to full list (fail-closed, never empty)" do
    {pid, _} = start_isolated(probe: fn _ep, _t -> false end, interval_ms: 60_000, fail_threshold: 1)
    SfuHealth.poll_now(pid)
    wait_checks(pid, 2)

    assert Enum.sort(SfuHealth.live_of(pid)) == ["ep-a:5000", "ep-b:5001"]
    GenServer.stop(pid, :normal)
  end

  test "concurrent poll cycles coalesce to one in-flight probe per endpoint" do
    {:ok, count} = Agent.start_link(fn -> 0 end)
    {:ok, gate} = Agent.start_link(fn -> false end)
    test_pid = self()

    probe = fn endpoint, _t ->
      Agent.update(count, &(&1 + 1))
      send(test_pid, {:probe_started, endpoint})

      # Hold open until the test releases the gate: both poll cycles are
      # issued while these are in flight.
      wait_until(fn -> Agent.get(gate, & &1) end)
      true
    end

    {pid, _} = start_isolated(probe: probe, interval_ms: 60_000)

    # Fire two poll cycles back-to-back; the second must not spawn dupes.
    spawn(fn -> SfuHealth.poll_now(pid) end)
    spawn(fn -> SfuHealth.poll_now(pid) end)

    # Wait until both endpoints have exactly one probe in flight…
    wait_until(fn -> Agent.get(count, & &1) == 2 end)
    # …then drain: any duplicate spawn would arrive here if coalescing
    # were broken.
    assert_received {:probe_started, _}
    assert_received {:probe_started, _}
    refute_received {:probe_started, _}, 100

    Agent.update(gate, fn _ -> true end)

    # Wait for both in-flight probes to land before asserting.
    wait_until(fn -> Agent.get(count, & &1) == 2 end)
    GenServer.stop(pid, :normal)

    # Exactly 2 probes total (one per endpoint), despite 2 poll cycles.
    assert Agent.get(count, & &1) == 2
  end

  test "stale probe results are dropped (generation guard)" do
    {pid, _} = start_isolated(probe: fn _ep, _t -> true end, interval_ms: 60_000)

    # A forged result with a bogus generation must not crash or flip.
    send(pid, {:probe_result, "ep-a:5000", -999_999, false})
    Process.sleep(50)

    assert Enum.sort(SfuHealth.live_of(pid)) == ["ep-a:5000", "ep-b:5001"]
    GenServer.stop(pid, :normal)
  end

  test "supervised instance is running and serving placement" do
    assert is_pid(Process.whereis(SfuHealth))
    assert {_checks, _flips} = SfuHealth.probe_stats()
    assert is_list(SfuHealth.live_endpoints())
  end

  describe "confirm/3 demand path (Phase 7d Step 6a)" do
    test "confirm returns the fresh observation and shares one probe across waiters" do
      {:ok, count} = Agent.start_link(fn -> 0 end)

      probe = fn _ep, _t ->
        Agent.update(count, &(&1 + 1))
        Process.sleep(100)
        false
      end

      {pid, _} = start_isolated(probe: probe, interval_ms: 60_000, fail_threshold: 5, broadcast: false)

      t1 = Task.async(fn -> SfuHealth.confirm(pid, "ep-a:5000", 5_000) end)
      t2 = Task.async(fn -> SfuHealth.confirm(pid, "ep-a:5000", 5_000) end)

      assert {:ok, false} = Task.await(t1, 5_000)
      assert {:ok, false} = Task.await(t2, 5_000)

      # One shared probe despite two concurrent confirms.
      assert Agent.get(count, & &1) == 1

      # Single observation does NOT flip at threshold 5 (damping intact).
      assert Enum.sort(SfuHealth.live_of(pid)) == ["ep-a:5000", "ep-b:5001"]

      GenServer.stop(pid, :normal)
    end

    test "confirm joins an in-flight poll probe instead of spawning a dupe" do
      {:ok, count} = Agent.start_link(fn -> 0 end)
      {:ok, gate} = Agent.start_link(fn -> false end)

      probe = fn _ep, _t ->
        Agent.update(count, &(&1 + 1))
        wait_until(fn -> Agent.get(gate, & &1) end)
        true
      end

      {pid, _} = start_isolated(probe: probe, interval_ms: 60_000, broadcast: false)

      spawn(fn -> SfuHealth.poll_now(pid) end)
      # Let the poll's probes get in flight.
      wait_until(fn -> Agent.get(count, & &1) == 2 end)

      t = Task.async(fn -> SfuHealth.confirm(pid, "ep-a:5000", 5_000) end)
      # Confirm must NOT spawn a third probe for ep-a.
      Process.sleep(100)
      assert Agent.get(count, & &1) == 2

      Agent.update(gate, fn _ -> true end)
      assert {:ok, true} = Task.await(t, 5_000)

      GenServer.stop(pid, :normal)
    end

    test "confirm on unknown endpoint errors without probing" do
      {:ok, count} = Agent.start_link(fn -> 0 end)
      {pid, _} = start_isolated(probe: fn _ep, _t -> Agent.update(count, &(&1 + 1)); true end, interval_ms: 60_000, broadcast: false)

      assert {:error, :unknown} = SfuHealth.confirm(pid, "nope:9999", 1_000)
      assert Agent.get(count, & &1) == 0

      GenServer.stop(pid, :normal)
    end

    test "confirm fail-open: dead poller returns unavailable" do
      {pid, _} = start_isolated(probe: fn _ep, _t -> true end, interval_ms: 60_000, broadcast: false)
      GenServer.stop(pid, :normal)

      assert {:error, :unavailable} = SfuHealth.confirm(pid, "ep-a:5000", 500)
    end
  end

  defp wait_until(fun, timeout_ms \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_wait_until(fun, deadline)
  end

  # Probe results land asynchronously (handle_info) after poll_now returns.
  # Wait until N probe results have been applied before asserting liveness.
  defp wait_checks(pid, n) do
    wait_until(fn ->
      {checks, _} = SfuHealth.probe_stats(pid)
      checks >= n
    end)
  end

  defp do_wait_until(fun, deadline) do
    if fun.() do
      :ok
    else
      if System.monotonic_time(:millisecond) > deadline do
        flunk("wait_until timed out")
      else
        Process.sleep(10)
        do_wait_until(fun, deadline)
      end
    end
  end
end

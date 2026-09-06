defmodule Gateway.HealthTest do
  use ExUnit.Case, async: false

  alias Gateway.Health
  alias Gateway.Test.Wait

  test "healthy?/2 accepts full alive tree with matching ids" do
    entries = [
      {:child_a, self(), :worker, [:child_a]},
      {:child_b, self(), :worker, [:child_b]}
    ]

    assert Health.healthy?(entries, MapSet.new([:child_a, :child_b]))
  end

  test "healthy?/2 rejects missing, restarting and dead children" do
    assert Health.healthy?([{:a, self(), :worker, []}], MapSet.new([:a, :b])) == false

    assert Health.healthy?(
             [{:a, :restarting, :worker, []}, {:b, self(), :worker, []}],
             MapSet.new([:a, :b])
           ) == false

    dead = spawn(fn -> :ok end)
    ref = Process.monitor(dead)

    receive do
      {:DOWN, ^ref, :process, ^dead, _reason} -> :ok
    end

    assert Health.healthy?([{:a, dead, :worker, []}], MapSet.new([:a])) == false
  end

  test "ready? is true after boot" do
    assert Health.ready?()
  end

  test "killing Health recovers readiness without Docker noticing" do
    old = Process.whereis(Health)
    kill(old)

    Wait.wait_until(fn ->
      new = Process.whereis(Health)
      is_pid(new) and new != old and Health.ready?()
    end)
  end

  defp kill(pid) do
    ref = Process.monitor(pid)
    Process.exit(pid, :kill)

    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
    end
  end
end

defmodule Gateway.ApplicationTest do
  use ExUnit.Case, async: false

  alias Gateway.Test.Wait

  test "supervision tree holds all children alive with spec ids" do
    entries = Supervisor.which_children(Gateway.Supervisor)

    ids = Enum.map(entries, &elem(&1, 0))
    assert MapSet.new(ids) == MapSet.new(Gateway.Application.child_ids())
    assert length(entries) == 6

    assert Enum.all?(entries, fn {_id, pid, _type, _modules} ->
             is_pid(pid) and Process.alive?(pid)
           end)
  end

  test "killing Metrics restarts the entire tree (rest_for_one)" do
    before = snapshot()
    kill(Gateway.Metrics)

    Wait.wait_until(fn ->
      entries = Supervisor.which_children(Gateway.Supervisor)

      Enum.all?(entries, fn {_id, pid, _type, _modules} ->
        is_pid(pid) and Process.alive?(pid)
      end) and Enum.all?(entries, fn {id, pid, _type, _modules} -> before[id] != pid end)
    end)

    after_map = snapshot()
    assert map_size(after_map) == map_size(before)
    assert Gateway.Health.ready?()
  end

  test "killing Health restarts Health and below, never Metrics" do
    metrics_pid = Process.whereis(Gateway.Metrics)
    kill(Gateway.Health)

    Wait.wait_until(fn ->
      Gateway.Health.ready?() and Process.whereis(Gateway.Metrics) == metrics_pid
    end)

    assert Process.whereis(Gateway.Health) != nil
    assert Process.whereis(Gateway.Metrics) == metrics_pid
  end

  defp snapshot do
    Gateway.Supervisor
    |> Supervisor.which_children()
    |> Map.new(fn {id, pid, _type, _modules} -> {id, pid} end)
  end

  defp kill(module) do
    pid = Process.whereis(module)
    ref = Process.monitor(pid)
    Process.exit(pid, :kill)

    receive do
      {:DOWN, ^ref, :process, ^pid, _reason} -> :ok
    end
  end
end

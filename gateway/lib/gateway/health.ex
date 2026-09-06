defmodule Gateway.Health do
  use GenServer

  @supervisor Gateway.Supervisor
  @timeout 250

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  def ready?(timeout \\ @timeout) do
    if Process.whereis(__MODULE__) do
      GenServer.call(__MODULE__, :ready?, timeout)
    else
      false
    end
  catch
    :exit, _ -> false
  end

  def check do
    healthy?(Supervisor.which_children(@supervisor), MapSet.new(Gateway.Application.child_ids()))
  end

  def healthy?(entries, expected_ids) do
    ids = MapSet.new(entries, fn {id, _pid, _type, _modules} -> id end)

    MapSet.equal?(ids, expected_ids) and
      Enum.all?(entries, fn {_id, pid, _type, _modules} ->
        is_pid(pid) and Process.alive?(pid)
      end)
  end

  @impl true
  def init(:ok) do
    {:ok, %{}}
  end

  @impl true
  def handle_call(:ready?, _from, state) do
    {:reply, check(), state}
  end
end

defmodule Gateway.ConnSupervisor do
  @moduledoc """
  Partitioned session supervision (birth-burst scaling).

  A `PartitionSupervisor` fronting N `DynamicSupervisor` partitions (one per
  scheduler slice by default) so 500 simultaneous IDENTIFYs don't serialize
  on a single supervisor mailbox. Spawning stays fully synchronous —
  `start_child/2` returns `{:ok, pid}` — so there is no nil-pid window and
  no protocol race (unlike an async-spawn design).

  Routing key is the `session_id` (uniform hex), so load spreads evenly
  regardless of user. Sessions are named via `Gateway.Registry`
  (`"session:<id>"`), hence partitioning is transparent to lookups:
  `Session.whereis/1`, `attach`, `resume`, and `close` are untouched.
  """

  @default_partitions System.schedulers_online()

  def start_link(opts \\ []) do
    partitions = Keyword.get(opts, :partitions, partitions())

    PartitionSupervisor.start_link(
      child_spec: {DynamicSupervisor, [strategy: :one_for_one]},
      name: __MODULE__,
      partitions: partitions
    )
  end

  def child_spec(opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]},
      type: :supervisor
    }
  end

  @doc """
  Partition count. Override with `config :gateway, conn_partitions: N`
  (e.g. 1 in constrained test envs).
  """
  def partitions do
    Application.get_env(:gateway, :conn_partitions, @default_partitions)
  end

  @doc """
  Starts a session child on the partition owning `session_id`.
  Same return contract as `DynamicSupervisor.start_child/2`.
  """
  def start_child(session_id, spec) do
    DynamicSupervisor.start_child({:via, PartitionSupervisor, {__MODULE__, session_id}}, spec)
  end

  @doc """
  Partition supervisor pids (internal routing targets).
  """
  def partition_pids do
    for {_id, pid, _, _} <- Supervisor.which_children(__MODULE__), is_pid(pid), do: pid
  end

  @doc """
  Terminates a session child wherever it lives. Used by test cleanup;
  returns `:ok` even when the pid is already gone.
  """
  def terminate_child(pid) when is_pid(pid) do
    Enum.reduce_while(partition_pids(), {:error, :not_found}, fn part, _acc ->
      case DynamicSupervisor.terminate_child(part, pid) do
        :ok -> {:halt, :ok}
        {:error, :not_found} -> {:cont, {:error, :not_found}}
      end
    end)
    |> case do
      :ok -> :ok
      {:error, :not_found} -> {:error, :not_found}
    end
  end

  @doc """
  Aggregates `{partition_pid, child_pid}` pairs across all partitions.
  Used by test cleanup.
  """
  def each_child do
    for part <- partition_pids(),
        {_, pid, _, _} <- DynamicSupervisor.which_children(part),
        is_pid(pid),
        do: {part, pid}
  end
end

defmodule Gateway.GuildSupervisor do
  # Phase 7c (Issue #86): distributed supervisor for guild actors.
  # Horde places each actor on some cluster node and restarts it on a
  # survivor when the holding node dies. Same name as before so existing
  # call sites (get_or_spawn, tests) keep working; only the backend changed.
  use Horde.DynamicSupervisor

  def start_link(opts) do
    # NOTE: name goes in the THIRD arg (opts). The outer supervisor then
    # registers as "<name>.Supervisor" and the impl as <name> itself.
    Horde.DynamicSupervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    opts
    |> Keyword.put_new(:strategy, :one_for_one)
    |> Keyword.put_new(:members, :auto)
    |> Horde.DynamicSupervisor.init()
  end
end

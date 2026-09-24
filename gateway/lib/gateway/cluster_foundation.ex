defmodule Gateway.ClusterFoundation do
  @moduledoc """
  Supervises the clustering processes as one unit (Phase 7c, Issue #86).

  libcluster discovery, the Horde registry, the guild lease agent and the
  distributed guild supervisor live here under :one_for_one — deliberately
  OUTSIDE the main tree's :rest_for_one chain. Rationale: Horde processes
  carry cluster membership/CRDT state and tolerate supervisor-driven
  restarts poorly (flaky rejoin, teardown races). The chaos-tested
  rest_for_one semantics (kill Health → restart the serving tail) must not
  churn cluster membership as a side effect. This group only restarts when
  one of its own crashes, or when Metrics (the tree root) dies.
  """

  use Supervisor

  def start_link(_opts) do
    Supervisor.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @impl true
  def init(:ok) do
    # NOTE: delta_crdt shutdown is bounded (default 30s): on supervised
    # restart the CRDT must not stall the whole tree; state re-gossips
    # within one sync interval (300ms) after rejoin.
    horde_opts = [delta_crdt_options: [shutdown: 2_000]]

    children = [
      {Horde.Registry,
       [name: Gateway.HordeRegistry, keys: :unique, members: :auto] ++ horde_opts},
      Gateway.Guild.Lease,
      Supervisor.child_spec({Gateway.GuildSupervisor, horde_opts}, id: Gateway.GuildSupervisor)
    ]

    children =
      if cluster_enabled?() do
        [cluster_supervisor() | children]
      else
        children
      end

    Supervisor.init(children, strategy: :one_for_one)
  end

  # libcluster discovery is pointless (and its shutdown slow) without BEAM
  # distribution. mix test/dev run undistributed; prod docker sets --name.
  # CLUSTER_ENABLED=false forces it off anywhere.
  defp cluster_enabled? do
    System.get_env("CLUSTER_ENABLED", "true") == "true" and Node.alive?()
  end

  defp cluster_supervisor do
    topologies = [
      gateway: [
        strategy: Cluster.Strategy.DNSPoll,
        config: [
          polling_interval: 5_000,
          query: System.get_env("CLUSTER_DNS_QUERY", "gateway-cluster"),
          node_basename: "gateway"
        ]
      ]
    ]

    Supervisor.child_spec(
      {Cluster.Supervisor, [topologies, [name: Gateway.ClusterSupervisor]]},
      id: Gateway.ClusterSupervisor
    )
  end
end

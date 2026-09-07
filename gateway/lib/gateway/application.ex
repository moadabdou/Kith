defmodule Gateway.Application do
  use Application

  @supervisor Gateway.Supervisor

  @impl true
  def start(_type, _args) do
    Supervisor.start_link(
      Enum.map(children(), &report/1),
      strategy: :rest_for_one,
      max_restarts: 50,
      max_seconds: 5,
      name: @supervisor
    )
  end

  def child_ids do
    children() |> Enum.map(&Supervisor.child_spec(&1, []).id)
  end

  def child_label(id), do: inspect(id)

  def start_and_report(id, {module, fun, args}) do
    case apply(module, fun, args) do
      {:ok, _pid} = ok ->
        Gateway.Metrics.child_started(id)
        ok

      other ->
        other
    end
  end

  defp children do
    [
      Gateway.Metrics,
      Gateway.Health,
      {Registry, keys: :unique, name: Gateway.Registry},
      Gateway.GuildSupervisor,
      Gateway.ConnSupervisor,
      Gateway.Bus.Consumer,
      Supervisor.child_spec({Bandit, plug: Gateway.Router, port: port()}, id: Bandit)
    ]
  end

  defp report(child) do
    spec = Supervisor.child_spec(child, [])
    %{spec | start: {__MODULE__, :start_and_report, [spec.id, spec.start]}}
  end

  defp port do
    System.get_env("PORT", "4000") |> String.to_integer()
  end
end

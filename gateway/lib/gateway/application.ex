defmodule Gateway.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      Gateway.Metrics,
      {Plug.Cowboy, scheme: :http, plug: Gateway.Router, options: [port: port()]}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: Gateway.Supervisor)
  end

  defp port do
    System.get_env("PORT", "4000") |> String.to_integer()
  end
end

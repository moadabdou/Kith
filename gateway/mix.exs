defmodule Gateway.MixProject do
  use Mix.Project

  def project do
    [
      app: :gateway,
      version: "0.1.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      deps: deps()
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  def application do
    [
      extra_applications: [:logger],
      mod: {Gateway.Application, []}
    ]
  end

  defp deps do
    [
      {:bandit, "~> 1.6"},
      {:websock_adapter, "~> 0.6"},
      {:jason, "~> 1.4"},
      {:redix, "~> 1.5"},
      {:postgrex, "~> 0.20"}
    ]
  end
end

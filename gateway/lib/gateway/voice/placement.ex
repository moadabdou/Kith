defmodule Gateway.Voice.Placement do
  @moduledoc """
  Channel-assigned SFU placement (Phase 7d, Issue #87).

  Pure deterministic mapping: `channel_id` hashes onto exactly one endpoint
  of the configured pool, so every member of a channel lands on the same SFU
  (room managers are per-process — splitting a channel across SFUs would
  split-brain it).

  The pool comes from the `VOICE_SFU_POOL` env var (comma-separated
  `host:port` list). Unset/empty falls back to the legacy single
  `VOICE_ENDPOINT`, preserving today's behavior exactly.

  Liveness comes from `Gateway.Voice.SfuHealth` (Step 3): `live_endpoints/0`
  is the placement input, and `select/2` over an explicit list keeps the
  pure mapping testable without the poller running.
  """

  @doc """
  Returns the endpoint list in effect: the pool when configured, else the
  single legacy endpoint. ALWAYS sorted: `select/2` indexes by hash, so
  every producer of a list (config parse here, ETS read in SfuHealth,
  test fixtures) must agree on one canonical order, or the same channel
  maps to different SFUs depending on who asked. Sorting is the cheapest
  global invariant for that.
  """
  def endpoints do
    case System.get_env("VOICE_SFU_POOL", "") |> String.trim() do
      "" ->
        [Application.get_env(:gateway, :voice_endpoint, System.get_env("VOICE_ENDPOINT", "127.0.0.1:5000"))]

      pool ->
        pool
        |> String.split(",", trim: true)
        |> Enum.map(&String.trim/1)
        |> Enum.reject(&(&1 == ""))
    end
    |> case do
      [] -> [Application.get_env(:gateway, :voice_endpoint, System.get_env("VOICE_ENDPOINT", "127.0.0.1:5000"))]
      list -> Enum.sort(list)
    end
  end

  @doc """
  Live endpoints for placement. Delegates to `SfuHealth` when it is running
  (supervised in prod/test app boot); falls back to the static configured
  list when it isn't (unit tests that boot no supervision tree).
  """
  def live_endpoints do
    case GenServer.whereis(Gateway.Voice.SfuHealth) do
      nil -> endpoints()
      _pid -> Gateway.Voice.SfuHealth.live_endpoints()
    end
  catch
    :exit, _ -> endpoints()
  end

  @doc """
  Selects the SFU endpoint for `channel_id` from `list` (defaults to
  `live_endpoints/0`). Deterministic: same channel always maps together.
  """
  def select(channel_id, list \\ nil) do
    list = list || live_endpoints()
    Enum.at(list, :erlang.phash2(to_string(channel_id), length(list)))
  end

  @doc """
  Re-selects excluding a confirmed-dead candidate (Step 6a demand path).
  Returns the candidate unchanged when exclusion would leave no endpoints
  (fail-closed: a maybe-dead answer beats no answer).
  """
  def exclude(channel_id, candidate, live) do
    case live -- [candidate] do
      [] -> candidate
      rest -> select(channel_id, rest)
    end
  end
end

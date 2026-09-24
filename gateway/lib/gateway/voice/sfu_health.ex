defmodule Gateway.Voice.SfuHealth do
  @moduledoc """
  Out-of-band SFU liveness tracker (Phase 7d, Issue #87, Steps 3+6a).

  Maintains the *live* subset of the configured pool (`VOICE_SFU_POOL`) by
  polling each SFU's `/healthz` on an interval. Authors of voice placement
  read the live list.

  Two observation paths share one set of threshold counters:
  - Steady-state poller: one in-flight check per endpoint max, flap-damped
    (dead after N consecutive failures, alive after M successes). Request
    paths never touch it.
  - Demand confirm (`confirm/2`, Step 6a): a voice RE-request (client was
    already placed and asks again — the failover hint) triggers a priority
    probe of the placed endpoint when the poller's verdict may be stale.
    Concurrent confirms/polls for one endpoint coalesce onto a single probe;
    waiters share its verdict. Healthy confirms cost milliseconds; a dead
    endpoint usually fails fast (RST). Bounded by the caller's timeout —
    callers fail open (trust the candidate) when the poller itself is wedged.

  Fail-closed on total outage: if every endpoint is dead, the live list
  falls back to the full configured list.
  """

  use GenServer
  require Logger

  @table :gateway_sfu_health
  @default_interval_ms 5_000
  # Dead-SFU SYNs usually RST fast (refused) or answer in ~1ms (healthy,
  # same bridge net). A killed container's half-torn mapping can blackhole
  # instead — this bound is what each fresh post-kill probe costs, and
  # re-request confirms serialize per guild actor, so it multiplies. 500ms
  # keeps kill->re-place for 3 members near ~1s; flap damping (threshold 2)
  # still absorbs lone slow polls. Tunable via VOICE_SFU_PROBE_TIMEOUT_MS.
  @default_timeout_ms 500
  @default_fail_threshold 2
  @default_recover_threshold 2

  # ── Public API ────────────────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Live endpoints for placement. Never empty (see moduledoc)."
  def live_endpoints(table \\ @table) do
    case :ets.whereis(table) do
      :undefined -> Gateway.Voice.Placement.endpoints()
      _ -> read_live(table)
    end
  end

  @doc "Probe counts, for tests (`{checks_total, flips}`)."
  def probe_stats(server \\ __MODULE__) do
    GenServer.call(server, :probe_stats)
  end

  @doc "Force an immediate poll cycle (tests, chaos harness)."
  def poll_now(server \\ __MODULE__) do
    GenServer.call(server, :poll_now, 10_000)
  end

  @doc "Live endpoints of a specific (usually unnamed test) instance."
  def live_of(server) do
    GenServer.call(server, :live)
  end

  @doc """
  Confirms one endpoint's liveness on the demand path (Step 6a).

  Returns `{:ok, ok?}` — the SINGLE fresh observation (not the damped
  belief). Rationale: the answerer needs to exclude a corpse NOW; a lone
  slow probe must not flip placement for everyone (threshold counting still
  gates flips + broadcasts), but it is sufficient reason to route THIS
  client elsewhere — the next re-request re-observes, so a transient blip
  self-heals on the following answer. Concurrent confirms and polls for one
  endpoint share a single probe.

  Callers should bound with a timeout and fail open (trust the candidate)
  on timeout/exit — a wedged poller must not wedge voice joins.
  """
  def confirm(server \\ __MODULE__, endpoint, timeout_ms \\ 3_000) do
    GenServer.call(server, {:confirm, endpoint}, timeout_ms)
  catch
    :exit, _ -> {:error, :unavailable}
  end

  @doc """
  Notifies local guild actors of a liveness transition so they can push
  null-then-reallocate failover updates (Step 4). Local-node only: each
  node supervises its own poller over the same SFUs, and each actor process
  lives on exactly one node — so notifying local actors is the complete
  audience, with no distribution involved and no subscription lifecycle
  (a crashed poller restarts and simply notifies on its next flip; actors
  never need to rejoin anything).
  """
  def notify_local_actors(endpoint, alive?) do
    msg = if alive?, do: {:sfu_up, endpoint}, else: {:sfu_down, endpoint}

    notified =
      Gateway.GuildSupervisor
      |> Horde.DynamicSupervisor.which_children()
      |> Enum.map(fn
        {_, pid, _, _} when is_pid(pid) -> pid
        _ -> nil
      end)
      |> Enum.filter(fn pid -> is_pid(pid) and node(pid) == node() end)
      |> Enum.map(fn pid ->
        send(pid, msg)
        pid
      end)

    Gateway.Metrics.incr_sfu_notify(length(notified))
    Logger.info("Gateway.Voice.SfuHealth notified #{length(notified)} local actor(s) of #{endpoint} -> #{if alive?, do: "alive", else: "dead"}")
    :ok
  rescue
    e ->
      Logger.warning("Gateway.Voice.SfuHealth notify failed for #{endpoint}: #{inspect(e)}")
      :ok
  catch
    kind, reason ->
      Logger.warning("Gateway.Voice.SfuHealth notify failed for #{endpoint}: #{inspect(kind)} #{inspect(reason)}")
      :ok
  end

  # ── GenServer ─────────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    # Named table for the supervised instance; test instances pass
    # `table: <atom>` to get isolated ETS (each owner deletes its own).
    table = Keyword.get(opts, :table, @table)
    :ets.new(table, [:named_table, :public, :set, read_concurrency: true])

    state = %{
      table: table,
      broadcast?: Keyword.get(opts, :broadcast, true),
      interval_ms: Keyword.get(opts, :interval_ms, env_int("VOICE_SFU_POLL_MS", @default_interval_ms)),
      timeout_ms: Keyword.get(opts, :timeout_ms, env_int("VOICE_SFU_PROBE_TIMEOUT_MS", @default_timeout_ms)),
      fail_threshold: Keyword.get(opts, :fail_threshold, env_int("VOICE_SFU_FAIL_THRESHOLD", @default_fail_threshold)),
      recover_threshold:
        Keyword.get(opts, :recover_threshold, env_int("VOICE_SFU_RECOVER_THRESHOLD", @default_recover_threshold)),
      probe: Keyword.get(opts, :probe, &default_probe/2),
      in_flight: %{},
      confirm_waiters: %{},
      checks_total: 0,
      flips: 0
    }

    # Seed synchronously so the first placement after boot already has rows.
    state = refresh_endpoints(state)
    schedule_poll(state.interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_call(:probe_stats, _from, state) do
    {:reply, {state.checks_total, state.flips}, state}
  end

  def handle_call(:live, _from, state) do
    {:reply, read_live(state.table), state}
  end

  def handle_call(:poll_now, _from, state) do
    {:reply, :ok, do_poll(state)}
  end

  def handle_call({:confirm, endpoint}, from, state) do
    if endpoint in all_endpoints(state.table) do
      case Map.get(state.confirm_waiters, endpoint) do
        nil ->
          case Map.get(state.in_flight, endpoint) do
            nil ->
              {state, _gen} = spawn_probe(state, endpoint)
              {:noreply, %{state | confirm_waiters: Map.put(state.confirm_waiters, endpoint, [from])}}

            _gen ->
              # A poll probe is already flying — share its verdict.
              {:noreply, %{state | confirm_waiters: Map.put(state.confirm_waiters, endpoint, [from])}}
          end

        waiters ->
          {:noreply, %{state | confirm_waiters: Map.put(state.confirm_waiters, endpoint, [from | waiters])}}
      end
    else
      {:reply, {:error, :unknown}, state}
    end
  end

  @impl true
  def handle_info(:poll, state) do
    schedule_poll(state.interval_ms)
    {:noreply, do_poll(state)}
  end
  # Probe result. Stale results (endpoint reconfigured away mid-flight, or a
  # superseded generation) are dropped — only the current generation counts.
  # Threshold counting proceeds for flips/broadcasts; confirm waiters get the
  # single fresh observation (see confirm/3).
  def handle_info({:probe_result, endpoint, gen, ok?}, state) do
    case Map.get(state.in_flight, endpoint) do
      ^gen ->
        in_flight = Map.delete(state.in_flight, endpoint)
        state = %{state | in_flight: in_flight, checks_total: state.checks_total + 1}
        state = apply_result(state, endpoint, ok?)
        {waiters, confirm_waiters} = Map.pop(state.confirm_waiters, endpoint, [])
        state = %{state | confirm_waiters: confirm_waiters}

        for from <- waiters do
          GenServer.reply(from, {:ok, ok?})
        end

        {:noreply, state}

      _stale ->
        {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ── Internals ─────────────────────────────────────────────────────────

  defp do_poll(state) do
    state = refresh_endpoints(state)

    Enum.reduce(all_endpoints(state.table), state, fn endpoint, acc ->
      if Map.has_key?(acc.in_flight, endpoint) do
        acc
      else
        {acc, _gen} = spawn_probe(acc, endpoint)
        acc
      end
    end)
  end

  defp spawn_probe(state, endpoint) do
    gen = System.unique_integer([:positive, :monotonic])
    parent = self()
    probe = state.probe
    timeout = state.timeout_ms

    spawn(fn ->
      result =
        try do
          probe.(endpoint, timeout)
        rescue
          _ -> false
        catch
          _, _ -> false
        end

      send(parent, {:probe_result, endpoint, gen, result == true})
    end)

    {%{state | in_flight: Map.put(state.in_flight, endpoint, gen)}, gen}
  end

  # Reconcile ETS rows with the configured pool: add newcomers as alive
  # (optimistic — the poll corrects within one interval), drop removed ones.
  defp refresh_endpoints(state) do
    configured = MapSet.new(Gateway.Voice.Placement.endpoints())
    known = MapSet.new(all_endpoints(state.table))

    for endpoint <- MapSet.difference(configured, known) do
      :ets.insert(state.table, {endpoint, true, 0, 0})
    end

    for endpoint <- MapSet.difference(known, configured) do
      :ets.delete(state.table, endpoint)
    end

    state
  end

  defp apply_result(state, endpoint, ok?) do
    table = state.table

    case :ets.lookup(table, endpoint) do
      [{^endpoint, alive?, fails, succs}] ->
        {alive?, fails, succs} =
          if ok? do
            succs = succs + 1
            alive? = if !alive? and succs >= state.recover_threshold, do: true, else: alive?
            {alive?, 0, succs}
          else
            fails = fails + 1
            alive? = if alive? and fails >= state.fail_threshold, do: false, else: alive?
            {alive?, fails, 0}
          end

        previously_alive =
          case :ets.lookup(table, endpoint) do
            [{_, was, _, _}] -> was
            [] -> alive?
          end

        :ets.insert(table, {endpoint, alive?, fails, succs})

        if alive? != previously_alive do
          Gateway.Metrics.incr_sfu_flip(if alive?, do: "up", else: "down")
          Logger.info("Gateway.Voice.SfuHealth #{endpoint} -> #{if alive?, do: "alive", else: "dead"}")
          broadcast(state, endpoint, alive?)

          %{state | flips: state.flips + 1}
        else
          state
        end

      [] ->
        state
    end
  end

  defp all_endpoints(table) do
    :ets.tab2list(table) |> Enum.map(&elem(&1, 0))
  end

  defp read_live(table) do
    live =
      :ets.tab2list(table)
      |> Enum.filter(fn {_ep, alive?, _f, _s} -> alive? end)
      |> Enum.map(&elem(&1, 0))
      |> Enum.sort()

    case live do
      # Fail-closed: total outage still yields placeable endpoints.
      [] -> table |> :ets.tab2list() |> Enum.map(&elem(&1, 0)) |> Enum.sort()
      list -> list
    end
  end

  defp default_probe(endpoint, timeout_ms) do
    url = endpoint_to_health_url(endpoint)
    http_opts = [timeout: timeout_ms, connect_timeout: timeout_ms]

    case :httpc.request(:get, {String.to_charlist(url), []}, http_opts, []) do
      {:ok, {{_, 200, _}, _, _}} -> true
      _ -> false
    end
  end

  @doc false
  def endpoint_to_health_url(endpoint) do
    base =
      if String.contains?(endpoint, "://") do
        endpoint
      else
        "http://" <> endpoint
      end

    base |> String.trim_trailing("/") |> Kernel.<>("/healthz")
  end

  # Notify local guild actors of a liveness transition (Step 4). Broadcast
  # can be disabled per-instance (tests use `broadcast: false` and drive the
  # actor path by sending the message directly).
  defp broadcast(%{broadcast?: false}, _endpoint, _alive?), do: :ok

  defp broadcast(_state, endpoint, alive?) do
    notify_local_actors(endpoint, alive?)
  end

  defp schedule_poll(interval_ms) do
    Process.send_after(self(), :poll, interval_ms)
  end

  defp env_int(name, default) do
    case System.get_env(name) do
      nil -> default
      raw -> case Integer.parse(raw) do
        {n, ""} when n > 0 -> n
        _ -> default
      end
    end
  end
end

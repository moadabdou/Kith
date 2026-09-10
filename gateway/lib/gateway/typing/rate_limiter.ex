defmodule Gateway.Typing.RateLimiter do
  @moduledoc """
  Server-side typing rate limiter per `(user_id, channel_id)` (plan/05 §2 & #35).

  10 users typing in a 500-member guild = ~6 events/sec of pure noise. A malicious
  client could flood thousands of typing requests per second. We enforce server-side
  rate limiting per `(user_id, channel_id)` (default max 1 event per 8 seconds).

  Uses an in-memory ETS table (`:gateway_typing_rate_limits`) with concurrent reads
  and writes directly in the caller process for sub-microsecond point checks.
  Runs a periodic background sweeper to evict stale buckets and prevent memory leaks.
  """

  use GenServer, restart: :permanent
  require Logger

  @table :gateway_typing_rate_limits
  @default_cooldown_ms 8_000
  @default_cleanup_interval_ms 60_000
  @default_max_age_ms 60_000

  # ── Public API ──────────────────────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Checks if a typing event from `user_id` in `channel_id` is allowed under `cooldown_ms`.
  Executed directly in the caller process against the ETS table.

  Returns `:ok` if allowed (and updates the bucket timestamp).
  Returns `{:rate_limited, retry_after_ms}` if within the cooldown window.
  """
  def check_rate(user_id, channel_id, cooldown_ms \\ @default_cooldown_ms) do
    if :ets.whereis(@table) == :undefined do
      :ok
    else
      key = {to_string(user_id), to_string(channel_id)}
      now = System.monotonic_time(:millisecond)

      case :ets.lookup(@table, key) do
        [{^key, last_typed_at}] ->
          elapsed = now - last_typed_at

          if elapsed < cooldown_ms do
            {:rate_limited, cooldown_ms - elapsed}
          else
            :ets.insert(@table, {key, now})
            :ok
          end

        [] ->
          :ets.insert(@table, {key, now})
          :ok
      end
    end
  end

  @doc """
  Evicts buckets older than `max_age_ms` from the rate limit table.
  Returns the number of deleted buckets.
  """
  def cleanup_expired(max_age_ms \\ @default_max_age_ms) do
    if :ets.whereis(@table) == :undefined do
      0
    else
      now = System.monotonic_time(:millisecond)
      cutoff = now - max_age_ms

      match_spec = [
        {{:"$1", :"$2"}, [{:<, :"$2", cutoff}], [true]}
      ]

      :ets.select_delete(@table, match_spec)
    end
  end

  @doc """
  Resets all entries in the rate limit table (useful for tests).
  """
  def reset do
    if :ets.whereis(@table) != :undefined do
      :ets.delete_all_objects(@table)
    end

    :ok
  end

  @doc """
  Returns the total number of active rate-limit buckets.
  """
  def count do
    if :ets.whereis(@table) != :undefined do
      :ets.info(@table, :size)
    else
      0
    end
  end

  # ── GenServer Callbacks ─────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    cleanup_interval = Keyword.get(opts, :cleanup_interval_ms, @default_cleanup_interval_ms)
    max_age = Keyword.get(opts, :max_age_ms, @default_max_age_ms)

    table =
      if :ets.whereis(@table) == :undefined do
        :ets.new(@table, [
          :set,
          :public,
          :named_table,
          read_concurrency: true,
          write_concurrency: true
        ])
      else
        @table
      end

    timer = Process.send_after(self(), :cleanup_expired, cleanup_interval)

    state = %{
      table: table,
      cleanup_interval_ms: cleanup_interval,
      max_age_ms: max_age,
      timer: timer
    }

    Logger.info("Gateway.Typing.RateLimiter initialized with ETS table #{inspect(@table)}")
    {:ok, state}
  end

  @impl true
  def handle_info(:cleanup_expired, state) do
    cleaned = cleanup_expired(state.max_age_ms)

    if cleaned > 0 do
      Logger.debug("Gateway.Typing.RateLimiter evicted #{cleaned} expired typing rate buckets")
    end

    timer = Process.send_after(self(), :cleanup_expired, state.cleanup_interval_ms)
    {:noreply, %{state | timer: timer}}
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    if state.timer && Process.read_timer(state.timer) do
      Process.cancel_timer(state.timer)
    end

    :ok
  end
end

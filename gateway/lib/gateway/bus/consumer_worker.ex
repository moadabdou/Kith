defmodule Gateway.Bus.ConsumerWorker do
  @moduledoc """
  Parallel lane for JetStream intake (Issue #88 Step 4).

  The NatsConsumer router does nothing per message but decode, hash the
  guild id, and cast here. Each worker runs the full processing pipeline
  (cache sync, guild-actor dispatch, presence enrichment, metrics, ACK)
  for its share of guilds.

  Ordering guarantee (plan/01 §4-5): routing is a pure function of
  guild_id, so every message for one guild lands in the SAME worker
  mailbox, FIFO. Per-guild dispatch order is identical to the single
  consumer. Redeliveries hash identically, so the actor's {seq, type}
  dedup net still matches exactly. Lease gating and the local-only
  mirror gate live downstream in the dispatch path, untouched.
  """
  use GenServer
  require Logger

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts)
  end

  @impl true
  def init(opts) do
    nats_url =
      Keyword.get(opts, :nats_url) ||
        System.get_env("NATS_URL") ||
        "nats://127.0.0.1:4222"

    send(self(), :connect)
    {:ok, %{nats_url: nats_url, gnat: nil}}
  end

  @impl true
  def handle_info(:connect, %{gnat: nil} = state) do
    uri = URI.parse(state.nats_url)

    case Gnat.start_link(%{host: uri.host || "127.0.0.1", port: uri.port || 4222}) do
      {:ok, gnat} ->
        Process.monitor(gnat)
        {:noreply, %{state | gnat: gnat}}

      {:error, reason} ->
        Logger.warning("Gateway.Bus.ConsumerWorker NATS connect failed: #{inspect(reason)}; retrying in 1s")
        Process.send_after(self(), :connect, 1000)
        {:noreply, state}
    end
  end

  def handle_info(:connect, state) do
    {:noreply, state}
  end

  def handle_info({:DOWN, _ref, :process, pid, reason}, %{gnat: pid} = state) do
    Logger.warning("Gateway.Bus.ConsumerWorker NATS connection died: #{inspect(reason)}; reconnecting in 1s")
    Process.send_after(self(), :connect, 1000)
    {:noreply, %{state | gnat: nil}}
  end

  @impl true
  def handle_cast({:process, event, reply_to, bus_received_at}, state) do
    # Lane timing (Issue #88 Step 4 diagnosis): split per-message cost
    # into process vs ack segments, averaged over 1000-message windows in
    # process state (free) and logged. No ETS, no calls, ~1µs overhead.
    t0 = System.monotonic_time(:microsecond)
    meta = Gateway.Bus.NatsConsumer.parse_ack_metadata(reply_to)

    guild_id =
      event["guild_id"] ||
        (is_map(event["payload"]) && event["payload"]["guild_id"]) ||
        ""

    type = event["type"] || "UNKNOWN"

    # Immediately synchronize permissions & entities in local ETS cache
    Gateway.Guild.Cache.handle_event(event)

    # Route by guild_id -> dispatch to the hosting node only.
    # Local-only bus dispatch: every node consumes every event (cache
    # convergence), but only the actor's host dispatches. The mirror
    # copy is dropped before crossing distribution.
    # Step 4b: MESSAGE-family events on split guilds fan out to lanes.
    if guild_id != "" do
      Gateway.Guild.Actor.route_fanout(to_string(guild_id), event, bus_received_at,
        bus_seq: meta.stream_seq
      )
    end

    # Discord-correct: GUILD_MEMBER_ADD is always accompanied by a
    # companion PRESENCE_UPDATE so old members learn the joining user's
    # live status.  The REST API has no presence data, so the gateway
    # enriches the event here from the node-local ETS presence store.
    # The companion inherits the parent's bus_seq: same seq, different
    # type, so cross-node dedup still matches exactly (Phase 7c).
    maybe_emit_member_presence(type, guild_id, event, bus_received_at, meta.stream_seq)

    # Sampled 1/100 by stream seq (same discipline as the router trim):
    # drill-readable without serializing anything behind logging.
    if meta.stream_seq && rem(meta.stream_seq, 100) == 0 do
      actor_pid =
        if guild_id != "", do: Gateway.Guild.Actor.whereis(guild_id), else: nil

      Logger.info(
        "Event consumed [#{meta.stream_seq}] type=#{type} guild_id=#{guild_id} (actor=#{inspect(actor_pid)}, sampled 1/100)"
      )
    end

    Gateway.Metrics.incr_event_consumed()

    t1 = System.monotonic_time(:microsecond)

    # Explicit JetStream ACK: +ACK sent back to reply_to subject
    ack_message(state.gnat, reply_to)

    t2 = System.monotonic_time(:microsecond)
    {:noreply, report_timing(state, t1 - t0, t2 - t1)}
  end

  defp report_timing(state, proc_us, ack_us) do
    n = Map.get(state, :timed, 0) + 1
    sp = Map.get(state, :timed_proc_us, 0) + proc_us
    sa = Map.get(state, :timed_ack_us, 0) + ack_us
    state = Map.merge(state, %{timed: n, timed_proc_us: sp, timed_ack_us: sa})

    if rem(n, 1000) == 0 do
      Logger.info(
        "ConsumerWorker timing: n=#{n} process_avg_us=#{div(sp, n)} ack_avg_us=#{div(sa, n)}"
      )

      %{state | timed: 0, timed_proc_us: 0, timed_ack_us: 0}
    else
      state
    end
  end

  # Emits a companion PRESENCE_UPDATE when a GUILD_MEMBER_ADD arrives, so
  # existing guild subscribers immediately see the joining user's live status
  # (online/idle/dnd) instead of defaulting to offline.
  defp maybe_emit_member_presence("GUILD_MEMBER_ADD", guild_id, event, bus_received_at, bus_seq)
       when guild_id != "" do
    with %{"payload" => %{"user" => %{"id" => uid}}} <- event,
         {:ok, presence} <- Gateway.Presence.Store.get_presence(uid) do
      status = to_string(presence.status)

      presence_event = %{
        "type" => "PRESENCE_UPDATE",
        "version" => 1,
        "guild_id" => guild_id,
        "payload" => %{
          "user" => %{"id" => uid},
          "guild_id" => guild_id,
          "status" => status,
          "activities" => presence.activities || [],
          "client_status" => presence.client_status || %{}
        }
      }

      Gateway.Guild.Actor.dispatch_bus_event(guild_id, presence_event, bus_received_at,
        bus_seq: bus_seq
      )
    end

    :ok
  end

  defp maybe_emit_member_presence(_type, _guild_id, _event, _bus_received_at, _bus_seq), do: :ok

  defp ack_message(nil, _reply_to), do: :ok
  defp ack_message(_gnat, nil), do: :ok
  defp ack_message(_gnat, ""), do: :ok

  defp ack_message(gnat, reply_to) do
    case Gnat.pub(gnat, reply_to, "+ACK") do
      :ok -> :ok
      {:error, err} -> Logger.error("Failed to ACK JetStream message on #{reply_to}: #{inspect(err)}")
    end
  end
end

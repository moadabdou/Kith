defmodule Gateway.Bus.Consumer do
  use GenServer, restart: :permanent
  require Logger

  @default_group "kith-gateway"
  @default_batch_size 10
  @default_block_ms 50

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    redis_url =
      Keyword.get(opts, :redis_url) ||
        System.get_env("REDIS_URL") ||
        "redis://127.0.0.1:6379"

    group = Keyword.get(opts, :group, @default_group)
    consumer_id = Keyword.get(opts, :consumer_id, "gateway-#{:erlang.phash2(self())}-#{System.unique_integer([:positive])}")
    batch_size = Keyword.get(opts, :batch_size, @default_batch_size)
    block_ms = Keyword.get(opts, :block_ms, @default_block_ms)
    stream_pattern = Keyword.get(opts, :stream_pattern, "kith:events:*")

    state = %{
      redix: nil,
      redis_url: redis_url,
      group: group,
      consumer_id: consumer_id,
      batch_size: batch_size,
      block_ms: block_ms,
      stream_pattern: stream_pattern,
      known_streams: MapSet.new(),
      shutting_down: false
    }

    send(self(), :connect)
    {:ok, state}
  end

  @impl true
  def handle_info(:connect, %{shutting_down: true} = state) do
    {:noreply, state}
  end

  def handle_info(:connect, state) do
    case Redix.start_link(state.redis_url) do
      {:ok, redix} ->
        Process.monitor(redix)
        Logger.info("Gateway.Bus.Consumer connected to Redis at #{state.redis_url}")
        send(self(), :poll)
        {:noreply, %{state | redix: redix}}

      {:error, reason} ->
        Logger.warning("Gateway.Bus.Consumer failed to connect to Redis at #{state.redis_url}: #{inspect(reason)}; retrying in 1s")
        Process.send_after(self(), :connect, 1000)
        {:noreply, state}
    end
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, reason}, %{redix: pid} = state) do
    Logger.warning("Gateway.Bus.Consumer Redis connection died: #{inspect(reason)}; reconnecting in 1s")
    Process.send_after(self(), :connect, 1000)
    {:noreply, %{state | redix: nil, known_streams: MapSet.new()}}
  end

  def handle_info(:poll, %{shutting_down: true} = state) do
    {:noreply, state}
  end

  def handle_info(:poll, %{redix: nil} = state) do
    {:noreply, state}
  end

  def handle_info(:poll, state) do
    state = discover_streams(state)

    if MapSet.size(state.known_streams) == 0 do
      Process.send_after(self(), :poll, state.block_ms)
      {:noreply, state}
    else

      # 1. Recover unacknowledged / pending messages from PEL
      state = read_pending(MapSet.to_list(state.known_streams), state)

      # 2. Read new messages with XREADGROUP >
      state = read_new(MapSet.to_list(state.known_streams), state)

      # Update lag metrics
      update_lag(MapSet.to_list(state.known_streams), state)

      send(self(), :poll)
      {:noreply, state}
    end
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    if state.redix && Process.alive?(state.redix) do
      Redix.stop(state.redix)
    end
    :ok
  end

  # ── Internal Helpers ────────────────────────────────────────────────────────

  defp discover_streams(state) do
    case scan_keys(state.redix, state.stream_pattern) do
      {:ok, keys} when is_list(keys) ->
        active_set = MapSet.new(keys)
        surviving = MapSet.intersection(state.known_streams, active_set)

        new_streams =
          Enum.reduce(keys, surviving, fn stream, acc ->
            if MapSet.member?(acc, stream) do
              acc
            else
              ensure_group(state.redix, stream, state.group)
              MapSet.put(acc, stream)
            end
          end)

        %{state | known_streams: new_streams}

      {:error, reason} ->
        Logger.warning("Gateway.Bus.Consumer failed to discover streams: #{inspect(reason)}")
        state
    end
  end

  defp scan_keys(redix, pattern) do
    do_scan(redix, "0", pattern, [])
  end

  defp do_scan(redix, cursor, pattern, acc) do
    case Redix.command(redix, ["SCAN", cursor, "MATCH", pattern, "COUNT", "100"]) do
      {:ok, ["0", batch]} ->
        {:ok, Enum.uniq(acc ++ batch)}

      {:ok, [next_cursor, batch]} ->
        do_scan(redix, next_cursor, pattern, acc ++ batch)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp ensure_group(redix, stream, group) do
    case Redix.command(redix, ["XGROUP", "CREATE", stream, group, "0", "MKSTREAM"]) do
      {:ok, _} ->
        Logger.debug("Created consumer group #{group} for stream #{stream}")
        :ok

      {:error, %Redix.Error{message: "BUSYGROUP" <> _}} ->
        :ok

      {:error, reason} ->
        Logger.warning("Could not create consumer group #{group} on #{stream}: #{inspect(reason)}")
        :error
    end
  end

  # Read pending messages for this consumer (unacked from crash recovery)
  defp read_pending(streams, state) do
    Enum.reduce(streams, state, fn stream, acc_state ->
      cmd = [
        "XREADGROUP",
        "GROUP",
        acc_state.group,
        acc_state.consumer_id,
        "COUNT",
        to_string(acc_state.batch_size),
        "STREAMS",
        stream,
        "0"
      ]

      case Redix.command(acc_state.redix, cmd) do
        {:ok, [[_stream_name, entries]]} when is_list(entries) and entries != [] ->
          Enum.each(entries, fn [id, fields] ->
            handle_entry(stream, id, fields, acc_state, true)
          end)
          acc_state

        {:error, %Redix.Error{message: "NOGROUP" <> _}} ->
          %{acc_state | known_streams: MapSet.delete(acc_state.known_streams, stream)}

        _ ->
          acc_state
      end
    end)
  end

  # Read new messages using >
  defp read_new([], state), do: state

  defp read_new(streams, state) do
    ids = List.duplicate(">", length(streams))
    cmd = [
      "XREADGROUP",
      "GROUP",
      state.group,
      state.consumer_id,
      "BLOCK",
      to_string(state.block_ms),
      "COUNT",
      to_string(state.batch_size),
      "STREAMS"
      | streams ++ ids
    ]

    case Redix.command(state.redix, cmd) do
      {:ok, nil} ->
        state

      {:ok, results} when is_list(results) ->
        Enum.each(results, fn
          [_stream_name, nil] -> :ok
          [stream_name, entries] when is_list(entries) ->
            Enum.each(entries, fn [id, fields] ->
              handle_entry(stream_name, id, fields, state, false)
            end)
          _ -> :ok
        end)
        state

      {:error, %Redix.Error{message: "NOGROUP" <> _}} ->
        Logger.debug("Consumer group missing for one of #{inspect(streams)}; resetting known streams")
        %{state | known_streams: MapSet.new()}

      {:error, reason} ->
        Logger.warning("XREADGROUP error: #{inspect(reason)}")
        state
    end
  end

  defp handle_entry(stream, id, fields, state, redelivery) do
    event_payload = extract_field(fields, "event")

    if event_payload do
      case Jason.decode(event_payload) do
        {:ok, event} ->
          guild_id = event["guild_id"] || ""
          type = event["type"] || "UNKNOWN"

          # Route by guild_id -> locate Guild Actor
          actor_pid =
            if guild_id != "", do: Gateway.Guild.Actor.whereis(guild_id), else: nil

          sub_count =
            if actor_pid, do: Gateway.Guild.Actor.subscriber_count(guild_id), else: 0

          Logger.info(
            "Event consumed [#{id}] type=#{type} guild_id=#{guild_id} (actor=#{inspect(actor_pid)}, #{sub_count} subscribers)"
          )

          if redelivery do
            Gateway.Metrics.incr_event_redelivered()
          end

          Gateway.Metrics.incr_event_consumed()

          # At-least-once: XACK ONLY after successful handling
          case Redix.command(state.redix, ["XACK", stream, state.group, id]) do
            {:ok, _} -> :ok
            {:error, ack_err} ->
              Logger.error("Failed to XACK entry #{id} on #{stream}: #{inspect(ack_err)}")
          end

        {:error, decode_err} ->
          Logger.error("Failed to decode JSON event from entry #{id} on #{stream}: #{inspect(decode_err)}")
          # ACK corrupt message so it does not loop infinitely
          Redix.command(state.redix, ["XACK", stream, state.group, id])
      end
    else
      Logger.warning("Stream entry #{id} missing 'event' field: #{inspect(fields)}")
      Redix.command(state.redix, ["XACK", stream, state.group, id])
    end
  end

  defp extract_field(fields, key) when is_list(fields) do
    fields
    |> Enum.chunk_every(2)
    |> Enum.find_value(fn
      [k, v] when k == key -> v
      _ -> nil
    end)
  end
  defp extract_field(_, _), do: nil

  defp update_lag(streams, state) do
    total_lag =
      Enum.reduce(streams, 0, fn stream, acc ->
        case Redix.command(state.redix, ["XPENDING", stream, state.group]) do
          {:ok, [count | _]} when is_integer(count) -> acc + count
          _ -> acc
        end
      end)

    Gateway.Metrics.set_consumer_lag(total_lag)
  rescue
    _ -> :ok
  end
end

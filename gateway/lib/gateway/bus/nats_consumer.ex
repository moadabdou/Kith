defmodule Gateway.Bus.NatsConsumer do
  use GenServer, restart: :permanent
  require Logger

  @default_stream "KITH_EVENTS"
  @default_durable_name "kith-gateway"
  @default_filter_subject "kith.events.>"
  @default_deliver_subject "kith.gateway.inbox"

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    nats_url =
      Keyword.get(opts, :nats_url) ||
        System.get_env("NATS_URL") ||
        "nats://127.0.0.1:4222"

    stream = Keyword.get(opts, :stream, @default_stream)
    durable_name = Keyword.get(opts, :durable_name, @default_durable_name)
    filter_subject = Keyword.get(opts, :filter_subject, @default_filter_subject)
    deliver_subject = Keyword.get(opts, :deliver_subject, @default_deliver_subject)

    state = %{
      gnat: nil,
      nats_url: nats_url,
      stream: stream,
      durable_name: durable_name,
      filter_subject: filter_subject,
      deliver_subject: deliver_subject,
      sub_ref: nil,
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
    uri = URI.parse(state.nats_url)
    host = uri.host || "127.0.0.1"
    port = uri.port || 4222

    conn_opts = %{
      host: host,
      port: port,
      name: "kith-gateway-consumer"
    }

    case Gnat.start_link(conn_opts) do
      {:ok, gnat} ->
        Process.monitor(gnat)
        Logger.info("Gateway.Bus.NatsConsumer connected to NATS at #{state.nats_url}")

        with :ok <- ensure_stream(gnat, state.stream, state.filter_subject),
             :ok <- ensure_consumer(gnat, state.stream, state.durable_name, state.filter_subject, state.deliver_subject),
             {:ok, sub_ref} <- Gnat.sub(gnat, self(), state.deliver_subject) do
          Logger.info("Gateway.Bus.NatsConsumer subscribed to #{state.deliver_subject} for stream #{state.stream}")
          {:noreply, %{state | gnat: gnat, sub_ref: sub_ref}}
        else
          {:error, reason} ->
            Logger.error("Gateway.Bus.NatsConsumer failed to setup JetStream consumer: #{inspect(reason)}; retrying in 1s")
            Process.send_after(self(), :connect, 1000)
            {:noreply, %{state | gnat: gnat}}
        end

      {:error, reason} ->
        Logger.warning("Gateway.Bus.NatsConsumer failed to connect to NATS at #{state.nats_url}: #{inspect(reason)}; retrying in 1s")
        Process.send_after(self(), :connect, 1000)
        {:noreply, state}
    end
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, reason}, %{gnat: pid} = state) do
    Logger.warning("Gateway.Bus.NatsConsumer NATS connection died: #{inspect(reason)}; reconnecting in 1s")
    Process.send_after(self(), :connect, 1000)
    {:noreply, %{state | gnat: nil, sub_ref: nil}}
  end

  @impl true
  def handle_info({:msg, %{body: body, reply_to: reply_to}}, state) do
    handle_jetstream_msg(body, reply_to, state)
    {:noreply, state}
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, state) do
    if state.gnat && Process.alive?(state.gnat) do
      Gnat.stop(state.gnat)
    end
    :ok
  end

  # ── Message Processing & Dispatch ──────────────────────────────────────────

  defp handle_jetstream_msg(body, reply_to, state) do
    bus_received_at = System.monotonic_time(:microsecond)
    meta = parse_ack_metadata(reply_to)

    if meta.delivered_count > 1 do
      Gateway.Metrics.incr_event_redelivered()
    end

    if meta.pending do
      Gateway.Metrics.set_consumer_lag(meta.pending)
    end

    case Jason.decode(body) do
      {:ok, event} ->
        guild_id = event["guild_id"] || ""
        type = event["type"] || "UNKNOWN"

        # Route by guild_id -> dispatch to Guild Actor
        if guild_id != "" do
          Gateway.Guild.Actor.dispatch_event(guild_id, event, bus_received_at)
        end

        # Discord-correct: GUILD_MEMBER_ADD is always accompanied by a
        # companion PRESENCE_UPDATE so old members learn the joining user's
        # live status.  The REST API has no presence data, so the gateway
        # enriches the event here from the node-local ETS presence store.
        maybe_emit_member_presence(type, guild_id, event, bus_received_at)

        actor_pid =
          if guild_id != "", do: Gateway.Guild.Actor.whereis(guild_id), else: nil

        sub_count =
          if actor_pid, do: Gateway.Guild.Actor.subscriber_count(guild_id), else: 0

        seq_str = if meta.stream_seq, do: to_string(meta.stream_seq), else: "0"
        Logger.info(
          "Event consumed [#{seq_str}] type=#{type} guild_id=#{guild_id} (actor=#{inspect(actor_pid)}, #{sub_count} subscribers)"
        )

        Gateway.Metrics.incr_event_consumed()

        # Explicit JetStream ACK: +ACK sent back to reply_to subject
        ack_message(state.gnat, reply_to)

      {:error, decode_err} ->
        Logger.error("Failed to decode JSON event from NATS message: #{inspect(decode_err)}")
        # Acknowledge corrupt message to avoid infinite redelivery poison loop
        ack_message(state.gnat, reply_to)
    end
  end

  # Emits a companion PRESENCE_UPDATE when a GUILD_MEMBER_ADD arrives, so
  # existing guild subscribers immediately see the joining user's live status
  # (online/idle/dnd) instead of defaulting to offline.
  defp maybe_emit_member_presence("GUILD_MEMBER_ADD", guild_id, event, bus_received_at)
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

      Gateway.Guild.Actor.dispatch_event(guild_id, presence_event, bus_received_at)
    end

    :ok
  end

  defp maybe_emit_member_presence(_type, _guild_id, _event, _bus_received_at), do: :ok

  defp ack_message(_gnat, nil), do: :ok
  defp ack_message(_gnat, ""), do: :ok
  defp ack_message(gnat, reply_to) do
    case Gnat.pub(gnat, reply_to, "+ACK") do
      :ok -> :ok
      {:error, err} ->
        Logger.error("Failed to ACK JetStream message on #{reply_to}: #{inspect(err)}")
    end
  end

  # Parses JetStream reply-to format:
  # $JS.ACK.<stream>.<consumer>.<delivered_count>.<stream_seq>.<consumer_seq>.<timestamp>.<pending>
  def parse_ack_metadata(nil), do: %{delivered_count: 1, stream_seq: nil, pending: nil}
  def parse_ack_metadata(reply_to) when is_binary(reply_to) do
    case String.split(reply_to, ".") do
      ["$JS", "ACK", _stream, _consumer, delivered_str, stream_seq_str, _cons_seq, _ts, pending_str | _] ->
        %{
          delivered_count: String.to_integer(delivered_str),
          stream_seq: String.to_integer(stream_seq_str),
          pending: String.to_integer(pending_str)
        }

      _ ->
        %{delivered_count: 1, stream_seq: nil, pending: nil}
    end
  rescue
    _ -> %{delivered_count: 1, stream_seq: nil, pending: nil}
  end

  # ── JetStream Setup Helpers ────────────────────────────────────────────────

  defp ensure_stream(gnat, stream, filter_subject) do
    payload =
      Jason.encode!(%{
        name: stream,
        subjects: [filter_subject],
        storage: "file",
        retention: "limits",
        discard: "old",
        max_age: 86_400_000_000_000, # 24h in nanoseconds
        duplicate_window: 120_000_000_000 # 2m in nanoseconds
      })

    case Gnat.request(gnat, "$JS.API.STREAM.CREATE.#{stream}", payload) do
      {:ok, %{body: body}} ->
        case Jason.decode(body) do
          {:ok, %{"error" => %{"code" => 400, "err_code" => 10058}}} ->
            # Stream already exists; update it to ensure subjects match
            update_stream(gnat, stream, filter_subject)

          {:ok, %{"error" => err}} ->
            Logger.warning("JetStream stream creation error: #{inspect(err)}")
            :ok

          _ ->
            :ok
        end

      {:error, reason} ->
        Logger.warning("JetStream stream create request failed: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp update_stream(gnat, stream, filter_subject) do
    payload =
      Jason.encode!(%{
        name: stream,
        subjects: [filter_subject],
        storage: "file",
        retention: "limits",
        discard: "old",
        max_age: 86_400_000_000_000,
        duplicate_window: 120_000_000_000
      })

    case Gnat.request(gnat, "$JS.API.STREAM.UPDATE.#{stream}", payload) do
      {:ok, _} -> :ok
      {:error, reason} ->
        Logger.warning("JetStream stream update request failed: #{inspect(reason)}")
        :ok
    end
  end

  defp ensure_consumer(gnat, stream, durable_name, filter_subject, deliver_subject) do
    payload =
      Jason.encode!(%{
        stream_name: stream,
        config: %{
          durable_name: durable_name,
          filter_subject: filter_subject,
          deliver_subject: deliver_subject,
          ack_policy: "explicit",
          deliver_policy: "all",
          replay_policy: "instant",
          ack_wait: 30_000_000_000 # 30s in nanoseconds
        }
      })

    case Gnat.request(gnat, "$JS.API.CONSUMER.CREATE.#{stream}.#{durable_name}", payload) do
      {:ok, %{body: body}} ->
        case Jason.decode(body) do
          {:ok, %{"error" => err}} ->
            Logger.warning("JetStream consumer creation notice: #{inspect(err)}")
            :ok

          _ ->
            :ok
        end

      {:error, reason} ->
        Logger.warning("JetStream consumer create request failed: #{inspect(reason)}")
        {:error, reason}
    end
  end
end

defmodule Gateway.Bus.NatsConsumerTest do
  use ExUnit.Case
  import Gateway.Test.Wait

  @nats_url System.get_env("NATS_URL", "nats://127.0.0.1:4222")

  describe "parse_ack_metadata/1" do
    test "correctly extracts delivered_count, stream_seq, and pending lag" do
      reply_to = "$JS.ACK.KITH_EVENTS.kith-gateway.1.42.10.1788880000000000000.5"
      meta = Gateway.Bus.NatsConsumer.parse_ack_metadata(reply_to)

      assert meta.delivered_count == 1
      assert meta.stream_seq == 42
      assert meta.pending == 5
    end

    test "identifies redeliveries when delivered_count > 1" do
      reply_to = "$JS.ACK.KITH_EVENTS.kith-gateway.3.99.12.1788880000000000000.0"
      meta = Gateway.Bus.NatsConsumer.parse_ack_metadata(reply_to)

      assert meta.delivered_count == 3
      assert meta.stream_seq == 99
      assert meta.pending == 0
    end

    test "handles malformed or nil reply_to gracefully" do
      assert Gateway.Bus.NatsConsumer.parse_ack_metadata(nil) == %{delivered_count: 1, stream_seq: nil, pending: nil}
      assert Gateway.Bus.NatsConsumer.parse_ack_metadata("") == %{delivered_count: 1, stream_seq: nil, pending: nil}
      assert Gateway.Bus.NatsConsumer.parse_ack_metadata("some.random.subject") == %{delivered_count: 1, stream_seq: nil, pending: nil}
    end
  end

  describe "worker_for/2 routing (ordering guarantee)" do
    test "same guild always maps to the same worker" do
      for count <- [1, 2, 4, 8] do
        first = Gateway.Bus.NatsConsumer.worker_for("99900120000000001", count)

        for _ <- 1..50 do
          assert Gateway.Bus.NatsConsumer.worker_for("99900120000000001", count) == first
        end
      end
    end

    test "index stays inside the pool for many guilds" do
      for count <- [1, 2, 4, 8] do
        for i <- 1..200 do
          w = Gateway.Bus.NatsConsumer.worker_for("guild_#{i}", count)
          assert w >= 0 and w < count
        end
      end
    end

    test "guilds spread across workers (parallelism actually happens)" do
      seen =
        for i <- 1..50 do
          Gateway.Bus.NatsConsumer.worker_for("guild_#{i}", 4)
        end
        |> Enum.uniq()

      assert length(seen) > 1
    end
  end

  describe "JetStream Integration" do
    setup do
      uri = URI.parse(@nats_url)
      host = uri.host || "127.0.0.1"
      port = uri.port || 4222

      case Gnat.start_link(%{host: host, port: port}) do
        {:ok, gnat} ->
          {:ok, gnat: gnat}

        {:error, reason} ->
          {:skip, "NATS not reachable at #{@nats_url}: #{inspect(reason)}"}
      end
    end

    test "consumes event from JetStream subject, routes to Guild Actor, and ACKs it", %{gnat: gnat} do
      test_id = System.unique_integer([:positive])
      stream = "TEST_JS_STREAM_#{test_id}"
      durable = "test-consumer-#{test_id}"
      filter_subject = "kith_test.#{test_id}.>"
      deliver_subject = "test.inbox.#{test_id}"
      guild_id = "guild_#{test_id}"
      pub_subject = "kith_test.#{test_id}.#{guild_id}"

      on_exit(fn ->
        uri = URI.parse(@nats_url)
        case Gnat.start_link(%{host: uri.host || "127.0.0.1", port: uri.port || 4222}) do
          {:ok, cleanup_gnat} ->
            _ = Gnat.request(cleanup_gnat, "$JS.API.STREAM.DELETE.#{stream}", "")
            Gnat.stop(cleanup_gnat)

          _ ->
            :ok
        end
      end)

      # Start isolated NatsConsumer for this test
      {:ok, consumer_pid} =
        Gateway.Bus.NatsConsumer.start_link(
          nats_url: @nats_url,
          stream: stream,
          durable_name: durable,
          filter_subject: filter_subject,
          deliver_subject: deliver_subject,
          name: :"nats_consumer_#{test_id}"
        )

      on_exit(fn ->
        if Process.alive?(consumer_pid), do: GenServer.stop(consumer_pid)
      end)

      # Give consumer time to create stream and consumer
      Process.sleep(100)

      event = %{
        "type" => "MESSAGE_CREATE",
        "version" => 1,
        "guild_id" => guild_id,
        "payload" => %{
          "id" => "msg_#{test_id}",
          "content" => "Hello NATS JetStream",
          "guild_id" => guild_id
        }
      }

      # Publish directly to NATS
      :ok = Gnat.pub(gnat, pub_subject, Jason.encode!(event))

      # Verify metrics render shows consumed event
      wait_until(fn ->
        metrics = Gateway.Metrics.render()
        metrics =~ "gateway_events_consumed_total"
      end, 3_000)

      # Verify consumer state has no pending unacked messages
      wait_until(fn ->
        case Gnat.request(gnat, "$JS.API.CONSUMER.INFO.#{stream}.#{durable}", "") do
          {:ok, %{body: body}} ->
            case Jason.decode(body) do
              {:ok, %{"num_ack_pending" => 0, "delivered" => %{"consumer_seq" => seq}}} when seq > 0 ->
                true
              _ ->
                false
            end
          _ ->
            false
        end
      end, 3_000)

      {:ok, %{body: body}} = Gnat.request(gnat, "$JS.API.CONSUMER.INFO.#{stream}.#{durable}", "")
      {:ok, info} = Jason.decode(body)
      assert info["num_ack_pending"] == 0
      assert info["delivered"]["consumer_seq"] >= 1
    end

    test "router fans 20 same-guild messages through workers with zero loss and full ack", %{gnat: gnat} do
      test_id = System.unique_integer([:positive])
      stream = "TEST_JS_FLOW_#{test_id}"
      durable = "test-flow-#{test_id}"
      filter_subject = "kith_flow.#{test_id}.>"
      deliver_subject = "flow.inbox.#{test_id}"
      guild_id = "flow_guild_#{test_id}"
      pub_subject = "kith_flow.#{test_id}.#{guild_id}"

      on_exit(fn ->
        uri = URI.parse(@nats_url)
        case Gnat.start_link(%{host: uri.host || "127.0.0.1", port: uri.port || 4222}) do
          {:ok, cleanup_gnat} ->
            _ = Gnat.request(cleanup_gnat, "$JS.API.STREAM.DELETE.#{stream}", "")
            Gnat.stop(cleanup_gnat)

          _ ->
            :ok
        end
      end)

      {:ok, consumer_pid} =
        Gateway.Bus.NatsConsumer.start_link(
          nats_url: @nats_url,
          stream: stream,
          durable_name: durable,
          filter_subject: filter_subject,
          deliver_subject: deliver_subject,
          name: :"nats_flow_#{test_id}"
        )

      on_exit(fn ->
        if Process.alive?(consumer_pid), do: GenServer.stop(consumer_pid)
      end)

      Process.sleep(100)

      for n <- 1..20 do
        event = %{
          "type" => "MESSAGE_CREATE",
          "version" => 1,
          "guild_id" => guild_id,
          "payload" => %{"id" => "flow_#{test_id}_#{n}", "content" => "flow #{n}", "guild_id" => guild_id}
        }

        :ok = Gnat.pub(gnat, pub_subject, Jason.encode!(event))
      end

      # All 20 flow router -> same worker -> processed -> acked: no loss,
      # no backlog left behind.
      wait_until(fn ->
        case Gnat.request(gnat, "$JS.API.CONSUMER.INFO.#{stream}.#{durable}", "") do
          {:ok, %{body: body}} ->
            case Jason.decode(body) do
              {:ok, %{"num_ack_pending" => 0, "delivered" => %{"consumer_seq" => seq}}} when seq >= 20 ->
                true

              _ ->
                false
            end

          _ ->
            false
        end
      end, 10_000)

      {:ok, %{body: body}} = Gnat.request(gnat, "$JS.API.CONSUMER.INFO.#{stream}.#{durable}", "")
      {:ok, info} = Jason.decode(body)
      assert info["num_ack_pending"] == 0
      assert info["delivered"]["consumer_seq"] >= 20
    end
  end
end

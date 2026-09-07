defmodule Gateway.Bus.ConsumerTest do
  use ExUnit.Case
  import Gateway.Test.Wait

  @redis_url System.get_env("REDIS_URL", "redis://127.0.0.1:6379")

  setup do
    case Redix.start_link(@redis_url) do
      {:ok, redix} ->
        {:ok, redix: redix}

      {:error, reason} ->
        {:skip, "Redis not reachable at #{@redis_url}: #{inspect(reason)}"}
    end
  end

  test "consumes event from guild stream, routes by guild_id, and ACKs it", %{redix: redix} do
    guild_id = "test_guild_#{System.unique_integer([:positive])}"
    stream = "kith:events:#{guild_id}"
    group = "kith-gateway"

    on_exit(fn ->
      cleanup_stream(stream)
    end)

    event_payload = %{
      "type" => "MESSAGE_CREATE",
      "version" => 1,
      "guild_id" => guild_id,
      "payload" => %{
        "id" => "111222333",
        "channel_id" => "444555666",
        "guild_id" => guild_id,
        "content" => "Hello Redis consumer"
      }
    }

    # Publish message to the guild stream
    {:ok, _entry_id} =
      Redix.command(redix, ["XADD", stream, "*", "event", Jason.encode!(event_payload)])

    # Wait until consumer discovers the stream and acknowledges the message
    wait_until(fn ->
      case Redix.command(redix, ["XPENDING", stream, group]) do
        {:ok, [0, _, _, _]} -> true
        _ -> false
      end
    end, 3_000)

    # Verify message was acked (PEL is empty)
    {:ok, [count | _]} = Redix.command(redix, ["XPENDING", stream, group])
    assert count == 0

    # Verify metrics render shows consumed event
    metrics = Gateway.Metrics.render()
    assert metrics =~ "gateway_events_consumed_total"
  end

  test "recovers unacknowledged events from PEL upon restart (zero loss)", %{redix: redix} do
    guild_id = "test_pel_#{System.unique_integer([:positive])}"
    stream = "kith:events:#{guild_id}"
    group = "kith-gateway"
    consumer_name = "dead-consumer"

    on_exit(fn ->
      cleanup_stream(stream)
    end)

    # 1. Create stream and consumer group
    _ = Redix.command(redix, ["XGROUP", "CREATE", stream, group, "0", "MKSTREAM"])

    event_payload = %{
      "type" => "MESSAGE_CREATE",
      "version" => 1,
      "guild_id" => guild_id,
      "payload" => %{"id" => "999888", "content" => "crash test"}
    }

    # 2. XADD an event
    {:ok, _entry_id} =
      Redix.command(redix, ["XADD", stream, "*", "event", Jason.encode!(event_payload)])

    # 3. Read the message with XREADGROUP but DO NOT ACK (simulating consumer crash mid-batch)
    {:ok, [[^stream, entries]]} =
      Redix.command(redix, [
        "XREADGROUP",
        "GROUP",
        group,
        consumer_name,
        "COUNT",
        "1",
        "STREAMS",
        stream,
        ">"
      ])

    assert length(entries) == 1

    # Verify it is in PEL (Pending Entries List)
    {:ok, [count | _]} = Redix.command(redix, ["XPENDING", stream, group])
    assert count == 1

    # 4. Start a separate recovery consumer with the SAME consumer name to claim unacked messages
    {:ok, pid} =
      Gateway.Bus.Consumer.start_link(
        redis_url: @redis_url,
        group: group,
        consumer_id: consumer_name,
        name: :"recovery_#{System.unique_integer([:positive])}"
      )

    # Wait for consumer to process pending messages and ACK them
    wait_until(fn ->
      case Redix.command(redix, ["XPENDING", stream, group]) do
        {:ok, [0, _, _, _]} -> true
        _ -> false
      end
    end, 3_000)

    {:ok, [final_count | _]} = Redix.command(redix, ["XPENDING", stream, group])
    assert final_count == 0

    # Verify redelivery metric increased
    metrics = Gateway.Metrics.render()
    assert metrics =~ "gateway_event_redeliveries_total"

    GenServer.stop(pid)
  end

  defp cleanup_stream(stream) do
    case Redix.start_link(@redis_url) do
      {:ok, conn} ->
        _ = Redix.command(conn, ["DEL", stream])
        Redix.stop(conn)

      _ ->
        :ok
    end
  end
end

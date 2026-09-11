defmodule ChunkMemoryBench do
  @moduledoc """
  Benchmark harness for Issue #40:
  10,000-member guild seed + streaming chunk memory profile (Phase 2 Gate).

  Connects over WebSocket, identifies, issues Opcode 8 REQUEST_GUILD_MEMBERS,
  and streams 10 consecutive chunks of 1,000 members while profiling BEAM memory.
  """

  require Logger

  @guild_id "99900000000000000"
  @owner_id 99900000000000001
  @target_chunks 10
  @max_memory_delta_mb 50.0

  defmodule SimpleWS do
    @moduledoc "Minimal RFC 6455 WebSocket client over :gen_tcp."

    def connect(host, port, path \\ "/ws") do
      char_host = to_charlist(host)

      with {:ok, socket} <- :gen_tcp.connect(char_host, port, [:binary, active: false, packet: :raw], 5000) do
        nonce = :crypto.strong_rand_bytes(16) |> Base.encode64()

        handshake =
          "GET #{path} HTTP/1.1\r\n" <>
            "Host: #{host}:#{port}\r\n" <>
            "Upgrade: websocket\r\n" <>
            "Connection: Upgrade\r\n" <>
            "Sec-WebSocket-Key: #{nonce}\r\n" <>
            "Sec-WebSocket-Version: 13\r\n\r\n"

        :ok = :gen_tcp.send(socket, handshake)
        wait_for_handshake(socket, <<>>)
      end
    end

    defp wait_for_handshake(socket, buffer) do
      case :gen_tcp.recv(socket, 0, 5000) do
        {:ok, data} ->
          combined = buffer <> data

          if String.contains?(combined, "\r\n\r\n") do
            [_headers, rest] = :binary.split(combined, "\r\n\r\n")
            {:ok, socket, rest}
          else
            wait_for_handshake(socket, combined)
          end

        {:error, reason} ->
          {:error, {:handshake_failed, reason}}
      end
    end

    def send_json(socket, map) do
      json = Jason.encode!(map)
      send_text(socket, json)
    end

    def send_text(socket, text) when is_binary(text) do
      len = byte_size(text)
      mask = :crypto.strong_rand_bytes(4)
      masked = mask_payload(text, mask)

      header =
        cond do
          len <= 125 ->
            <<1::1, 0::3, 1::4, 1::1, len::7, mask::binary>>

          len <= 65535 ->
            <<1::1, 0::3, 1::4, 1::1, 126::7, len::16, mask::binary>>

          true ->
            <<1::1, 0::3, 1::4, 1::1, 127::7, len::64, mask::binary>>
        end

      :gen_tcp.send(socket, [header, masked])
    end

    def recv_json(socket, buffer, timeout \\ 10_000) do
      case recv_frame(socket, buffer, timeout) do
        {:ok, :text, payload, rest} ->
          {:ok, Jason.decode!(payload), rest}

        {:ok, :ping, payload, rest} ->
          # Echo pong
          send_pong(socket, payload)
          recv_json(socket, rest, timeout)

        {:ok, other_opcode, _payload, rest} ->
          {:ok, {:opcode, other_opcode}, rest}

        {:error, reason} ->
          {:error, reason}
      end
    end

    def recv_frame(socket, buffer, timeout \\ 10_000) do
      case parse_frame(buffer) do
        {:ok, opcode, payload, rest} ->
          {:ok, opcode, payload, rest}

        :need_more ->
          case :gen_tcp.recv(socket, 0, timeout) do
            {:ok, chunk} ->
              recv_frame(socket, buffer <> chunk, timeout)

            {:error, reason} ->
              {:error, reason}
          end
      end
    end

    defp send_pong(socket, payload) do
      len = byte_size(payload)
      mask = :crypto.strong_rand_bytes(4)
      masked = mask_payload(payload, mask)
      header = <<1::1, 0::3, 10::4, 1::1, len::7, mask::binary>>
      :gen_tcp.send(socket, [header, masked])
    end

    defp parse_frame(<<_fin::1, _rsv::3, opcode_num::4, masked::1, len_byte::7, rest::binary>>) do
      opcode =
        case opcode_num do
          1 -> :text
          2 -> :binary
          8 -> :close
          9 -> :ping
          10 -> :pong
          other -> {:unknown, other}
        end

      case {len_byte, rest} do
        {126, <<len::16, rest2::binary>>} ->
          extract_payload(opcode, masked, len, rest2)

        {127, <<len::64, rest2::binary>>} ->
          extract_payload(opcode, masked, len, rest2)

        {len, rest2} when len <= 125 ->
          extract_payload(opcode, masked, len, rest2)

        _ ->
          :need_more
      end
    end

    defp parse_frame(_), do: :need_more

    defp extract_payload(opcode, masked, len, rest) do
      if masked == 1 do
        case rest do
          <<mask::binary-size(4), data::binary-size(len), remaining::binary>> ->
            {:ok, opcode, mask_payload(data, mask), remaining}

          _ ->
            :need_more
        end
      else
        case rest do
          <<payload::binary-size(len), remaining::binary>> ->
            {:ok, opcode, payload, remaining}

          _ ->
            :need_more
        end
      end
    end

    defp mask_payload(data, mask) do
      data_len = byte_size(data)
      full_mask = :binary.copy(mask, div(data_len, 4) + 1)
      <<truncated_mask::binary-size(data_len), _::binary>> = full_mask
      :crypto.exor(data, truncated_mask)
    end

    def close(socket) do
      :gen_tcp.close(socket)
    end
  end

  defmodule MemorySampler do
    @moduledoc "Samples BEAM memory concurrently during streaming."

    def start_link do
      Agent.start_link(fn ->
        %{
          samples: [],
          peak_total: :erlang.memory(:total),
          peak_processes: :erlang.memory(:processes),
          peak_binary: :erlang.memory(:binary),
          active: true
        }
      end)
    end

    def start_sampling(pid, interval_ms \\ 5) do
      spawn_link(fn -> sample_loop(pid, interval_ms) end)
    end

    defp sample_loop(pid, interval_ms) do
      active =
        Agent.get_and_update(pid, fn state ->
          if state.active do
            total = :erlang.memory(:total)
            procs = :erlang.memory(:processes)
            bin = :erlang.memory(:binary)

            new_state = %{
              state
              | samples: [total | state.samples],
                peak_total: max(state.peak_total, total),
                peak_processes: max(state.peak_processes, procs),
                peak_binary: max(state.peak_binary, bin)
            }

            {true, new_state}
          else
            {false, state}
          end
        end)

      if active do
        Process.sleep(interval_ms)
        sample_loop(pid, interval_ms)
      end
    end

    def stop(pid) do
      Agent.get_and_update(pid, fn state ->
        {state, %{state | active: false}}
      end)
    end
  end

  def run do
    IO.puts("""

    ╔══════════════════════════════════════════════════════════════════════════════╗
    ║      KITH PHASE 2 GATE: 10k-MEMBER GUILD STREAMING CHUNK MEMORY PROFILE      ║
    ╚══════════════════════════════════════════════════════════════════════════════╝
    Schedulers online: #{:erlang.system_info(:schedulers_online)}
    OTP Version:       #{:erlang.system_info(:otp_release)}
    Target Guild ID:   #{@guild_id}
    Member Expectation:10,000 members (10 chunks × 1,000)
    """)

    port = String.to_integer(System.get_env("PORT", "4000"))
    jwt_secret = System.get_env("JWT_SECRET", "dev-jwt-secret-change-me")

    # 1. Warm-up and baseline memory recording
    IO.puts("→ [1/5] Collecting initial BEAM memory baseline...")
    :erlang.garbage_collect()
    Process.sleep(200)
    baseline_mem = record_memory()

    # 2. Start memory sampling agent
    {:ok, sampler} = MemorySampler.start_link()
    MemorySampler.start_sampling(sampler, 5)

    # 3. Connect WebSocket client
    IO.puts("→ [2/5] Connecting WebSocket to 127.0.0.1:#{port}/ws...")
    {:ok, socket, buffer} = SimpleWS.connect("127.0.0.1", port, "/ws")

    # 4. Handshake: Expect HELLO (op 10), then send IDENTIFY (op 2)
    IO.puts("→ [3/5] Performing IDENTIFY handshake (Opcode 2)...")
    {:ok, hello, buffer} = SimpleWS.recv_json(socket, buffer)
    if is_map(hello) and hello["op"] != 10, do: raise("Expected HELLO (op 10), got: #{inspect(hello)}")

    token = Gateway.Auth.JWT.issue(@owner_id, jwt_secret, 3600)
    identify_payload = %{"op" => 2, "d" => %{"token" => token}}
    SimpleWS.send_json(socket, identify_payload)

    {:ok, ready, buffer} = SimpleWS.recv_json(socket, buffer)
    case ready do
      %{"t" => "READY"} ->
        :ok

      other ->
        raise "Expected READY dispatch, got: #{inspect(other)}"
    end

    # 5. Issue Opcode 8 REQUEST_GUILD_MEMBERS
    IO.puts("→ [4/5] Sending Opcode 8 REQUEST_GUILD_MEMBERS (query='', limit=0, presences=false)...")
    stream_start_time = System.monotonic_time(:millisecond)

    request_payload = %{
      "op" => 8,
      "d" => %{
        "guild_id" => @guild_id,
        "query" => "",
        "limit" => 0,
        "presences" => false
      }
    }

    SimpleWS.send_json(socket, request_payload)

    # 6. Stream and verify 10 consecutive chunks
    IO.puts("→ [5/5] Streaming chunks from Postgrex keyset cursor...")
    {chunks, _final_buffer} = collect_chunks(socket, buffer, @target_chunks, stream_start_time)
    stream_end_time = System.monotonic_time(:millisecond)
    total_stream_ms = stream_end_time - stream_start_time

    # Stop sampler
    sampler_stats = MemorySampler.stop(sampler)
    SimpleWS.close(socket)

    # Record post-stream and post-GC memory
    post_stream_mem = record_memory()
    :erlang.garbage_collect()
    Process.sleep(100)
    post_gc_mem = record_memory()

    # Metrics computation
    total_members_received = Enum.sum(Enum.map(chunks, fn c -> c.member_count end))
    memory_delta_mb = (sampler_stats.peak_total - baseline_mem.total) / (1024 * 1024)
    post_gc_delta_mb = (post_gc_mem.total - baseline_mem.total) / (1024 * 1024)

    print_report(
      chunks,
      total_members_received,
      total_stream_ms,
      baseline_mem,
      sampler_stats,
      post_stream_mem,
      post_gc_mem,
      memory_delta_mb,
      post_gc_delta_mb
    )

    # Assertions
    cond do
      length(chunks) != @target_chunks ->
        IO.puts("\n❌ FAILED: Expected #{@target_chunks} chunks, got #{length(chunks)}")
        System.halt(1)

      total_members_received != 10_000 ->
        IO.puts("\n❌ FAILED: Expected 10,000 members, got #{total_members_received}")
        System.halt(1)

      memory_delta_mb >= @max_memory_delta_mb ->
        IO.puts(
          "\n❌ FAILED: Peak memory delta #{Float.round(memory_delta_mb, 2)} MB exceeded #{@max_memory_delta_mb} MB gate threshold!"
        )
        System.halt(1)

      true ->
        IO.puts(
          "\n✅ PASSED Phase 2 Gate: 10,000 members streamed cleanly across 10 chunks with peak memory delta < #{@max_memory_delta_mb} MB!"
        )
    end
  end

  defp collect_chunks(socket, buffer, target_count, stream_start_time) do
    do_collect_chunks(socket, buffer, 0, target_count, [], stream_start_time)
  end

  defp do_collect_chunks(_socket, buffer, idx, target_count, acc, _start) when idx >= target_count do
    {Enum.reverse(acc), buffer}
  end

  defp do_collect_chunks(socket, buffer, idx, target_count, acc, start_time) do
    chunk_arrival_time = System.monotonic_time(:millisecond)

    case SimpleWS.recv_json(socket, buffer, 15_000) do
      {:ok, %{"t" => "GUILD_MEMBERS_CHUNK", "d" => d}, rest} ->
        elapsed_from_start = chunk_arrival_time - start_time
        chunk_idx = d["chunk_index"]
        chunk_count = d["chunk_count"]
        members = d["members"] || []
        member_count = length(members)

        info = %{
          index: chunk_idx,
          count: chunk_count,
          member_count: member_count,
          elapsed_ms: elapsed_from_start
        }

        IO.puts(
          "   [Chunk #{chunk_idx + 1}/#{chunk_count}] +#{member_count} members (total elapsed: #{elapsed_from_start}ms)"
        )

        do_collect_chunks(socket, rest, idx + 1, target_count, [info | acc], start_time)

      {:ok, _non_chunk_frame, rest} ->
        # Ignore non-chunk frames (e.g. PRESENCE_UPDATE or ack)
        do_collect_chunks(socket, rest, idx, target_count, acc, start_time)

      {:error, reason} ->
        raise "Stream failed at chunk #{idx}: #{inspect(reason)}"
    end
  end

  defp record_memory do
    %{
      total: :erlang.memory(:total),
      processes: :erlang.memory(:processes),
      binary: :erlang.memory(:binary),
      ets: :erlang.memory(:ets)
    }
  end

  defp mb(bytes), do: Float.round(bytes / (1024 * 1024), 2)

  defp print_report(
         chunks,
         total_members,
         total_ms,
         baseline,
         sampler,
         post_stream,
         post_gc,
         delta_mb,
         post_gc_delta_mb
       ) do
    members_per_sec = round(total_members / max(total_ms / 1000, 0.001))

    IO.puts("""

    ════════════════════════════════════════════════════════════════════════════════
                             STREAMING PERFORMANCE SUMMARY
    ════════════════════════════════════════════════════════════════════════════════
    Total Chunks Delivered:    #{length(chunks)} / #{@target_chunks}
    Total Members Delivered:   #{total_members} members
    Total Stream Duration:     #{total_ms} ms (#{Float.round(total_ms / 1000, 2)} s)
    Average Throughput:        #{members_per_sec} members/sec
    Average Chunk Latency:     #{Float.round(total_ms / length(chunks), 1)} ms/chunk

    ────────────────────────────────────────────────────────────────────────────────
                                BEAM MEMORY PROFILE
    ────────────────────────────────────────────────────────────────────────────────
    Baseline Memory:           #{mb(baseline.total)} MB  (Processes: #{mb(baseline.processes)} MB, Binary: #{mb(baseline.binary)} MB)
    Peak Memory During Stream: #{mb(sampler.peak_total)} MB  (Processes: #{mb(sampler.peak_processes)} MB, Binary: #{mb(sampler.peak_binary)} MB)
    Post-Stream Memory:        #{mb(post_stream.total)} MB  (Processes: #{mb(post_stream.processes)} MB, Binary: #{mb(post_stream.binary)} MB)
    Post-GC Memory:            #{mb(post_gc.total)} MB  (Processes: #{mb(post_gc.processes)} MB, Binary: #{mb(post_gc.binary)} MB)
    ────────────────────────────────────────────────────────────────────────────────
    PEAK MEMORY DELTA:         #{Float.round(delta_mb, 2)} MB  (Threshold: < #{@max_memory_delta_mb} MB)
    POST-GC MEMORY DELTA:      #{Float.round(post_gc_delta_mb, 2)} MB
    ════════════════════════════════════════════════════════════════════════════════
    """)
  end
end

ChunkMemoryBench.run()

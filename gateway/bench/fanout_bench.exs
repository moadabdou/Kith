defmodule FanoutBench do
  @moduledoc """
  Benchmark harness for Issue #23: Naive Global Fan-out vs. Guild Actors.
  Compares a single global fan-out process vs. distributed guild actors
  under 1,000 and 10,000 session loads.
  """

  defmodule SessionReceiver do
    def start_link(delivered_counter) do
      spawn_link(fn -> loop(delivered_counter) end)
    end

    defp loop(counter) do
      receive do
        {:dispatch, _event} ->
          :atomics.add(counter, 1, 1)
          loop(counter)

        :stop ->
          :ok
      end
    end
  end

  defmodule NaiveGlobalDispatcher do
    use GenServer

    def start_link(sessions) do
      GenServer.start_link(__MODULE__, sessions)
    end

    def publish(pid, event) do
      GenServer.cast(pid, {:publish, event})
    end

    def sync(pid) do
      GenServer.call(pid, :sync, :infinity)
    end

    def init(sessions) do
      {:ok, %{sessions: sessions}}
    end

    def handle_cast({:publish, event}, state) do
      Enum.each(state.sessions, fn pid ->
        send(pid, {:dispatch, event})
      end)
      {:noreply, state}
    end

    def handle_call(:sync, _from, state) do
      {:reply, :ok, state}
    end
  end

  defmodule GuildActorDispatcher do
    use GenServer

    def start_link(subscribers) do
      GenServer.start_link(__MODULE__, subscribers)
    end

    def dispatch(pid, event) do
      GenServer.cast(pid, {:dispatch, event})
    end

    def sync(pid) do
      GenServer.call(pid, :sync, :infinity)
    end

    def init(subscribers) do
      {:ok, %{subscribers: subscribers}}
    end

    def handle_cast({:dispatch, event}, state) do
      Enum.each(state.subscribers, fn pid ->
        send(pid, {:dispatch, event})
      end)
      {:noreply, state}
    end

    def handle_call(:sync, _from, state) do
      {:reply, :ok, state}
    end
  end

  def run do
    IO.puts("""
    ╔══════════════════════════════════════════════════════════════════════════════╗
    ║        KITH PHASE 1 BENCHMARK: NAIVE GLOBAL FAN-OUT VS. GUILD ACTORS        ║
    ╚══════════════════════════════════════════════════════════════════════════════╝
    Schedulers online: #{:erlang.system_info(:schedulers_online)}
    BEAM SMT/Cores:   #{:erlang.system_info(:logical_processors)}
    """)

    results_1k = run_benchmark_scale(1_000, 20, 100)
    results_10k = run_benchmark_scale(10_000, 20, 100)

    print_summary_tables(results_1k, results_10k)
  end

  defp run_benchmark_scale(num_sessions, subscribers_per_guild, num_burst_publishes) do
    num_guilds = div(num_sessions, subscribers_per_guild)
    total_deliveries = num_sessions * num_burst_publishes

    IO.puts("────────────────────────────────────────────────────────────────────────────────")
    IO.puts("  SCALE: #{num_sessions} Sessions | #{num_guilds} Guilds (#{subscribers_per_guild} subs/guild) | #{num_burst_publishes} Bursts")
    IO.puts("  Total message deliveries per trial: #{format_num(total_deliveries)}")
    IO.puts("────────────────────────────────────────────────────────────────────────────────\n")

    # 1. Run Naive Baseline
    IO.puts("  [1/2] Running Naive Global Fan-out...")
    naive_res = run_naive_trial(num_sessions, num_burst_publishes, total_deliveries)
    IO.puts("        Done in #{naive_res.total_wall_ms} ms (p99 publish: #{naive_res.p99_us} µs)\n")

    # GC and settle
    :erlang.garbage_collect()
    :timer.sleep(500)

    # 2. Run Guild Actor Model
    IO.puts("  [2/2] Running Distributed Guild Actor Model...")
    actor_res = run_actor_trial(num_sessions, subscribers_per_guild, num_burst_publishes, total_deliveries)
    IO.puts("        Done in #{actor_res.total_wall_ms} ms (p99 publish: #{actor_res.p99_us} µs)\n")

    %{
      num_sessions: num_sessions,
      num_guilds: num_guilds,
      total_deliveries: total_deliveries,
      naive: naive_res,
      actor: actor_res
    }
  end

  defp run_naive_trial(num_sessions, num_burst_publishes, expected_deliveries) do
    counter = :atomics.new(1, [])
    session_pids = Enum.map(1..num_sessions, fn _ -> SessionReceiver.start_link(counter) end)
    {:ok, dispatcher} = NaiveGlobalDispatcher.start_link(session_pids)

    queue_sampler = spawn_link(fn -> queue_sampler_loop(dispatcher, 0) end)

    sched_before = :scheduler.sample()
    t_start = System.monotonic_time(:microsecond)

    publish_latencies =
      Enum.map(1..num_burst_publishes, fn i ->
        event = %{"type" => "MESSAGE_CREATE", "data" => %{"n" => i}}
        t0 = System.monotonic_time(:microsecond)
        NaiveGlobalDispatcher.publish(dispatcher, event)
        t1 = System.monotonic_time(:microsecond)
        t1 - t0
      end)

    NaiveGlobalDispatcher.sync(dispatcher)
    wait_until_delivered(counter, expected_deliveries)
    t_end = System.monotonic_time(:microsecond)
    sched_after = :scheduler.sample()

    send(queue_sampler, {:stop, self()})
    peak_queue = receive do {:peak_queue, q} -> q end

    total_wall_ms = Float.round((t_end - t_start) / 1_000, 2)
    sched_util = parse_scheduler_util(sched_before, sched_after)

    Enum.each(session_pids, fn p -> send(p, :stop) end)
    GenServer.stop(dispatcher)

    build_metrics_record(total_wall_ms, publish_latencies, expected_deliveries, peak_queue, sched_util)
  end

  defp run_actor_trial(num_sessions, subscribers_per_guild, num_burst_publishes, expected_deliveries) do
    counter = :atomics.new(1, [])
    session_pids = Enum.map(1..num_sessions, fn _ -> SessionReceiver.start_link(counter) end)

    guild_chunks = Enum.chunk_every(session_pids, subscribers_per_guild)
    guild_actors = Enum.map(guild_chunks, fn subs ->
      {:ok, pid} = GuildActorDispatcher.start_link(subs)
      pid
    end)

    queue_sampler = spawn_link(fn -> multi_queue_sampler_loop(guild_actors, 0) end)

    sched_before = :scheduler.sample()
    t_start = System.monotonic_time(:microsecond)

    publish_latencies =
      Enum.map(1..num_burst_publishes, fn i ->
        event = %{"type" => "MESSAGE_CREATE", "data" => %{"n" => i}}
        t0 = System.monotonic_time(:microsecond)
        Enum.each(guild_actors, fn actor ->
          GuildActorDispatcher.dispatch(actor, event)
        end)
        t1 = System.monotonic_time(:microsecond)
        t1 - t0
      end)

    Enum.each(guild_actors, fn actor ->
      GuildActorDispatcher.sync(actor)
    end)

    wait_until_delivered(counter, expected_deliveries)
    t_end = System.monotonic_time(:microsecond)
    sched_after = :scheduler.sample()

    send(queue_sampler, {:stop, self()})
    peak_queue = receive do {:peak_queue, q} -> q end

    total_wall_ms = Float.round((t_end - t_start) / 1_000, 2)
    sched_util = parse_scheduler_util(sched_before, sched_after)

    Enum.each(session_pids, fn p -> send(p, :stop) end)
    Enum.each(guild_actors, fn actor -> GenServer.stop(actor) end)

    build_metrics_record(total_wall_ms, publish_latencies, expected_deliveries, peak_queue, sched_util)
  end

  defp queue_sampler_loop(pid, max_q) do
    receive do
      {:stop, reply_to} ->
        send(reply_to, {:peak_queue, max_q})
    after
      0 ->
        curr_q =
          case Process.info(pid, :message_queue_len) do
            {:message_queue_len, len} -> len
            nil -> 0
          end
        queue_sampler_loop(pid, max(curr_q, max_q))
    end
  end

  defp multi_queue_sampler_loop(pids, max_q) do
    receive do
      {:stop, reply_to} ->
        send(reply_to, {:peak_queue, max_q})
    after
      0 ->
        total_q =
          Enum.reduce(pids, 0, fn p, acc ->
            case Process.info(p, :message_queue_len) do
              {:message_queue_len, len} -> acc + len
              nil -> acc
            end
          end)
        multi_queue_sampler_loop(pids, max(total_q, max_q))
    end
  end

  defp wait_until_delivered(counter, expected) do
    curr = :atomics.get(counter, 1)
    if curr < expected do
      :timer.sleep(1)
      wait_until_delivered(counter, expected)
    else
      :ok
    end
  end

  defp parse_scheduler_util(s1, s2) do
    util = :scheduler.utilization(s1, s2)
    total_pct =
      case List.keyfind(util, :total, 0) do
        {:total, frac, _} -> Float.round(frac * 100, 1)
        _ -> 0.0
      end

    cores =
      util
      |> Enum.filter(fn
        {:normal, _id, _frac, _str} -> true
        _ -> false
      end)
      |> Enum.map(fn {:normal, id, frac, _} ->
        {id, Float.round(frac * 100, 1)}
      end)

    %{total_pct: total_pct, cores: cores}
  end

  defp build_metrics_record(total_wall_ms, latencies, deliveries, peak_queue, sched_util) do
    sorted = Enum.sort(latencies)
    len = length(sorted)
    p50 = Enum.at(sorted, div(len * 50, 100))
    p95 = Enum.at(sorted, div(len * 95, 100))
    p99 = Enum.at(sorted, div(len * 99, 100))
    mean = Float.round(Enum.sum(sorted) / len, 1)
    throughput = round(deliveries / (total_wall_ms / 1_000))

    %{
      total_wall_ms: total_wall_ms,
      p50_us: p50,
      p95_us: p95,
      p99_us: p99,
      mean_us: mean,
      deliveries_per_sec: throughput,
      peak_queue: peak_queue,
      sched_util: sched_util
    }
  end

  defp format_num(n) when n >= 1_000_000, do: "#{Float.round(n / 1_000_000, 1)}M"
  defp format_num(n) when n >= 1_000, do: "#{Float.round(n / 1_000, 1)}k"
  defp format_num(n), do: "#{n}"

  defp print_summary_tables(r1k, r10k) do
    IO.puts("""
    ══════════════════════════════════════════════════════════════════════════════════
                            FINAL BENCHMARK COMPARISON REPORT
    ══════════════════════════════════════════════════════════════════════════════════

    ┌────────────────────────────────────────────────────────────────────────────┐
    │ 1,000 SESSIONS (100 Bursts → 100,000 Total Deliveries)                     │
    ├─────────────────────────────┬────────────────────┬─────────────────────────┤
    │ Metric                      │ Naive (1 Process)  │ Guild Actors (50 Actors)│
    ├─────────────────────────────┼────────────────────┼─────────────────────────┤
    │ Total Drain Wall Time       │ #{pad(r1k.naive.total_wall_ms, "ms")} │ #{pad(r1k.actor.total_wall_ms, "ms")}    │
    │ Throughput (deliveries/sec) │ #{pad(r1k.naive.deliveries_per_sec, " msg/s")} │ #{pad(r1k.actor.deliveries_per_sec, " msg/s")}    │
    │ Total Sched Utilization     │ #{pad(r1k.naive.sched_util.total_pct, " %")} │ #{pad(r1k.actor.sched_util.total_pct, " %")}    │
    │ Peak Mailbox Queue Depth    │ #{pad(r1k.naive.peak_queue, " msgs")} │ #{pad(r1k.actor.peak_queue, " msgs")}    │
    └─────────────────────────────┴────────────────────┴─────────────────────────┘

    ┌────────────────────────────────────────────────────────────────────────────┐
    │ 10,000 SESSIONS (100 Bursts → 1,000,000 Total Deliveries)                  │
    ├─────────────────────────────┬────────────────────┬─────────────────────────┤
    │ Metric                      │ Naive (1 Process)  │ Guild Actors (500 Actors)│
    ├─────────────────────────────┼────────────────────┼─────────────────────────┤
    │ Total Drain Wall Time       │ #{pad(r10k.naive.total_wall_ms, "ms")} │ #{pad(r10k.actor.total_wall_ms, "ms")}    │
    │ Throughput (deliveries/sec) │ #{pad(r10k.naive.deliveries_per_sec, " msg/s")} │ #{pad(r10k.actor.deliveries_per_sec, " msg/s")}    │
    │ Total Sched Utilization     │ #{pad(r10k.naive.sched_util.total_pct, " %")} │ #{pad(r10k.actor.sched_util.total_pct, " %")}    │
    │ Peak Mailbox Queue Depth    │ #{pad(r10k.naive.peak_queue, " msgs")} │ #{pad(r10k.actor.peak_queue, " msgs")}    │
    │ Parallelism Speedup         │ 1.00x (Baseline)   │ #{Float.round(r10k.naive.total_wall_ms / r10k.actor.total_wall_ms, 2)}x Faster            │
    └─────────────────────────────┴────────────────────┴─────────────────────────┘

    ┌────────────────────────────────────────────────────────────────────────────┐
    │ BEAM Multi-Core Scheduler Saturation (10,000 Sessions Scale)               │
    ├────────────────────────────────────────────────────────────────────────────┤
    │ Naive Baseline (Bottlenecked on single dispatcher process):                │
    │   #{format_cores(r10k.naive.sched_util.cores)}
    │                                                                            │
    │ Guild Actors (Concurrent BEAM processes across all 8 schedulers):          │
    │   #{format_cores(r10k.actor.sched_util.cores)}
    └────────────────────────────────────────────────────────────────────────────┘
    """)
  end

  defp format_cores(cores) do
    cores
    |> Enum.map(fn {id, pct} -> "Core #{id}: #{String.pad_leading("#{pct}%", 5)}" end)
    |> Enum.chunk_every(4)
    |> Enum.map(&Enum.join(&1, "  |  "))
    |> Enum.join("\n    │   ")
  end

  defp pad(val, unit) do
    str = "#{val}#{unit}"
    String.pad_trailing(str, 16)
  end
end

FanoutBench.run()

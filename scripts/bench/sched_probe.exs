# Scheduler saturation probe (no +sbu flag available: scheduler_wall_time
# is :undefined). Uses total run-queue length (0 = schedulers idle, growing
# = work waiting) + top message queues + process count.
rqs = :erlang.statistics(:run_queue_lengths)
total_rq = Enum.sum(rqs)
IO.puts("run_queue_total=#{total_rq} per_sched=#{inspect(rqs)}")
lens =
  for p <- Process.list() do
    case Process.info(p, :message_queue_len) do
      {:message_queue_len, l} when l > 0 -> l
      _ -> nil
    end
  end
  |> Enum.reject(&is_nil/1)
  |> Enum.sort(:desc)
  |> Enum.take(5)
IO.puts("top_queues=#{inspect(lens)}")
IO.puts("procs=#{length(Process.list())}")
IO.puts("mem_mb=#{div(:erlang.memory(:total), 1048576)}")

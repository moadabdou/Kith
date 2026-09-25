# Remote probe into a live gateway node (docker exec spawns a fresh VM;
# this script connects to the app node over distribution and rpc-calls).
# Usage: elixir remote_probe.exs <container-ip> [cookie]
[ip | rest] = System.argv()
cookie = List.first(rest) || System.get_env("ERLANG_COOKIE") || "dev-cluster-cookie"
Node.start(:"probe@127.0.0.1")
Node.set_cookie(String.to_atom(cookie))
target = :"gateway@#{ip}"

unless Node.connect(target) do
  IO.puts("connect_failed=#{ip}")
  System.halt(1)
end

rqs = :rpc.call(target, :erlang, :statistics, [:run_queue_lengths])
total_rq = if is_list(rqs), do: Enum.sum(rqs), else: -1
IO.puts("run_queue_total=#{total_rq}")

procs = :rpc.call(target, Process, :list, [])
top =
  if is_list(procs) do
    procs
    |> Enum.map(&:rpc.call(target, Process, :info, [&1, :message_queue_len]))
    |> Enum.filter(fn
      {:message_queue_len, l} when l > 0 -> true
      _ -> false
    end)
    |> Enum.map(fn {:message_queue_len, l} -> l end)
    |> Enum.sort(:desc)
    |> Enum.take(8)
  else
    [:rpc_failed]
  end
IO.puts("top_queues=#{inspect(top)}")
IO.puts("procs=#{if is_list(procs), do: length(procs), else: -1}")
mem = :rpc.call(target, :erlang, :memory, [:total])
IO.puts("mem_mb=#{if is_integer(mem), do: div(mem, 1048576), else: -1}")

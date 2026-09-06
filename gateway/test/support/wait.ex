defmodule Gateway.Test.Wait do
  def wait_until(fun, timeout \\ 5_000) do
    deadline = System.monotonic_time() + System.convert_time_unit(timeout, :millisecond, :native)
    do_wait(fun, deadline)
  end

  defp do_wait(fun, deadline) do
    if fun.() do
      :ok
    else
      if System.monotonic_time() >= deadline do
        raise "wait_until timed out"
      else
        Process.sleep(10)
        do_wait(fun, deadline)
      end
    end
  end
end

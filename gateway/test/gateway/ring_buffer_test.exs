defmodule Gateway.RingBufferTest do
  use ExUnit.Case, async: true

  alias Gateway.RingBuffer

  describe "RingBuffer basic operations" do
    test "new buffer is empty" do
      buf = RingBuffer.new(5)
      assert RingBuffer.empty?(buf)
      assert RingBuffer.size(buf) == 0
      assert buf.min_seq == nil
      assert buf.max_seq == nil
    end

    test "put inserts items and tracks sequences" do
      buf =
        RingBuffer.new(5)
        |> RingBuffer.put(1, "msg-1")
        |> RingBuffer.put(2, "msg-2")
        |> RingBuffer.put(3, "msg-3")

      assert RingBuffer.size(buf) == 3
      assert buf.min_seq == 1
      assert buf.max_seq == 3

      assert {:ok, "msg-1"} = RingBuffer.get(buf, 1)
      assert {:ok, "msg-2"} = RingBuffer.get(buf, 2)
      assert {:ok, "msg-3"} = RingBuffer.get(buf, 3)
      assert :error = RingBuffer.get(buf, 99)
    end

    test "evicts oldest items when capacity is exceeded" do
      buf =
        RingBuffer.new(3)
        |> RingBuffer.put(1, "msg-1")
        |> RingBuffer.put(2, "msg-2")
        |> RingBuffer.put(3, "msg-3")
        |> RingBuffer.put(4, "msg-4")

      assert RingBuffer.size(buf) == 3
      assert buf.min_seq == 2
      assert buf.max_seq == 4

      # Oldest sequence 1 was evicted
      assert :error = RingBuffer.get(buf, 1)
      assert {:ok, "msg-2"} = RingBuffer.get(buf, 2)
      assert {:ok, "msg-3"} = RingBuffer.get(buf, 3)
      assert {:ok, "msg-4"} = RingBuffer.get(buf, 4)
    end

    test "range returns contiguous slice or gap error" do
      buf =
        RingBuffer.new(3)
        |> RingBuffer.put(10, "m10")
        |> RingBuffer.put(11, "m11")
        |> RingBuffer.put(12, "m12")

      assert {:ok, ["m10", "m11", "m12"]} = RingBuffer.range(buf, 10, 12)
      assert {:ok, ["m11", "m12"]} = RingBuffer.range(buf, 11, 12)
      assert {:ok, []} = RingBuffer.range(buf, 13, 12)

      # Evict 10
      buf = RingBuffer.put(buf, 13, "m13")
      assert {:error, :gap_unbufferable} = RingBuffer.range(buf, 10, 12)
      assert {:ok, ["m11", "m12", "m13"]} = RingBuffer.range(buf, 11, 13)
    end
  end
end

defmodule Gateway.Voice.PlacementTest do
  use ExUnit.Case, async: true

  alias Gateway.Voice.Placement

  @pool ["127.0.0.1:5000", "127.0.0.1:5001"]

  describe "select/2 — channel affinity (Phase 7d, Issue #87)" do
    test "same channel always maps to the same endpoint" do
      first = Placement.select("chan-abc", @pool)

      for _ <- 1..20 do
        assert Placement.select("chan-abc", @pool) == first
      end
    end

    test "channels spread over both SFUs" do
      picked =
        for i <- 1..50 do
          Placement.select("chan-#{i}", @pool)
        end
        |> MapSet.new()

      assert MapSet.equal?(picked, MapSet.new(@pool))
    end

    test "single-entry pool always returns that endpoint" do
      assert Placement.select("chan-abc", ["127.0.0.1:5000"]) == "127.0.0.1:5000"
    end
  end

  describe "exclude/3 — demand-path corpse exclusion (Phase 7d Step 6a)" do
    test "excluded candidate re-hashes onto a survivor" do
      pool = ["ep-a:5000", "ep-b:5001"]
      candidate = Placement.select("chan-x", pool)
      other = (pool -- [candidate]) |> hd()

      assert Placement.exclude("chan-x", candidate, pool) == other
    end

    test "single-endpoint pool fails closed (returns the candidate)" do
      assert Placement.exclude("chan-x", "only:5000", ["only:5000"]) == "only:5000"
    end
  end

  describe "endpoints/0 — configuration" do
    test "falls back to legacy VOICE_ENDPOINT when no pool is configured" do
      System.delete_env("VOICE_SFU_POOL")
      System.delete_env("VOICE_ENDPOINT")

      assert Placement.endpoints() == ["127.0.0.1:5000"]
    end

    test "honours legacy VOICE_ENDPOINT override" do
      System.delete_env("VOICE_SFU_POOL")
      System.put_env("VOICE_ENDPOINT", "10.0.0.9:5000")

      try do
        assert Placement.endpoints() == ["10.0.0.9:5000"]
      after
        System.delete_env("VOICE_ENDPOINT")
      end
    end

    test "parses comma-separated pool, trimming whitespace and empties" do
      System.put_env("VOICE_SFU_POOL", " 127.0.0.1:5000 ,, 127.0.0.1:5001 ")

      try do
        assert Placement.endpoints() == ["127.0.0.1:5000", "127.0.0.1:5001"]
      after
        System.delete_env("VOICE_SFU_POOL")
      end
    end

    test "blank pool falls back to legacy endpoint" do
      System.put_env("VOICE_SFU_POOL", " , ,")

      try do
        assert Placement.endpoints() == ["127.0.0.1:5000"]
      after
        System.delete_env("VOICE_SFU_POOL")
      end
    end
  end
end

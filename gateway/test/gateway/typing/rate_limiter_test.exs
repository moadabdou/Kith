defmodule Gateway.Typing.RateLimiterTest do
  use ExUnit.Case, async: false

  alias Gateway.Typing.RateLimiter

  setup do
    RateLimiter.reset()
    :ok
  end

  test "first typing trigger returns :ok and subsequent triggers within 8s return :rate_limited" do
    user_id = "user_rl_1"
    channel_id = "chan_rl_100"

    # 1. First trigger allowed
    assert :ok = RateLimiter.check_rate(user_id, channel_id)

    # 2. Immediate second trigger rate-limited with retry_after_ms
    assert {:rate_limited, retry_after_ms} = RateLimiter.check_rate(user_id, channel_id)
    assert is_integer(retry_after_ms)
    assert retry_after_ms > 0 and retry_after_ms <= 8_000

    # 3. Third trigger also rate-limited
    assert {:rate_limited, _} = RateLimiter.check_rate(user_id, channel_id)
  end

  test "rate limits are scoped per (user_id, channel_id) tuple" do
    u1 = "user_rl_a"
    u2 = "user_rl_b"
    c1 = "chan_rl_1"
    c2 = "chan_rl_2"

    # u1 in c1 allowed
    assert :ok = RateLimiter.check_rate(u1, c1)
    assert {:rate_limited, _} = RateLimiter.check_rate(u1, c1)

    # u1 in different channel c2 allowed
    assert :ok = RateLimiter.check_rate(u1, c2)

    # different user u2 in c1 allowed
    assert :ok = RateLimiter.check_rate(u2, c1)

    # different user u2 in c2 allowed
    assert :ok = RateLimiter.check_rate(u2, c2)

    assert RateLimiter.count() == 4
  end

  test "trigger passes after custom cooldown expires" do
    user_id = "user_custom_cooldown"
    channel_id = "chan_custom_cooldown"
    short_cooldown_ms = 50

    assert :ok = RateLimiter.check_rate(user_id, channel_id, short_cooldown_ms)
    assert {:rate_limited, _} = RateLimiter.check_rate(user_id, channel_id, short_cooldown_ms)

    # Sleep past cooldown
    :timer.sleep(60)

    # Now allowed again
    assert :ok = RateLimiter.check_rate(user_id, channel_id, short_cooldown_ms)
  end

  test "high volume of typing requests from single user does not leak ETS memory" do
    user_id = "spammer_user"
    channel_id = "spammed_channel"

    # Flood 500 requests
    for _ <- 1..500 do
      RateLimiter.check_rate(user_id, channel_id)
    end

    # ETS table must only have 1 entry for this (user, channel) tuple
    assert RateLimiter.count() == 1
  end

  test "cleanup_expired evicts stale buckets" do
    # Populate multiple buckets
    now = System.monotonic_time(:millisecond)
    table = :gateway_typing_rate_limits

    # Stale bucket from 100 seconds ago
    :ets.insert(table, {{"u_old", "c_old"}, now - 100_000})

    # Recent bucket from 5 seconds ago
    :ets.insert(table, {{"u_recent", "c_recent"}, now - 5_000})

    assert RateLimiter.count() == 2

    # Cleanup buckets older than 60 seconds
    evicted = RateLimiter.cleanup_expired(60_000)
    assert evicted == 1
    assert RateLimiter.count() == 1

    # Recent bucket remains
    assert :ets.lookup(table, {"u_recent", "c_recent"}) != []
    assert :ets.lookup(table, {"u_old", "c_old"}) == []
  end
end

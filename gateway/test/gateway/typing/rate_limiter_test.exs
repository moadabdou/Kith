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

  test "clear drops a single bucket so the next typing trigger passes immediately" do
    user_id = "user_clear_1"
    channel_id = "chan_clear_1"

    assert :ok = RateLimiter.check_rate(user_id, channel_id)
    assert {:rate_limited, _} = RateLimiter.check_rate(user_id, channel_id)

    assert :ok = RateLimiter.clear(user_id, channel_id)

    # New typing episode: allowed without waiting out the 8s cooldown
    assert :ok = RateLimiter.check_rate(user_id, channel_id)
  end

  test "clear is scoped to the given (user_id, channel_id) tuple" do
    assert :ok = RateLimiter.check_rate("u_clear_a", "c_clear_1")
    assert :ok = RateLimiter.check_rate("u_clear_a", "c_clear_2")

    assert :ok = RateLimiter.clear("u_clear_a", "c_clear_1")

    assert :ok = RateLimiter.check_rate("u_clear_a", "c_clear_1")
    assert {:rate_limited, _} = RateLimiter.check_rate("u_clear_a", "c_clear_2")
  end

  test "clear on a missing bucket is a no-op" do
    assert :ok = RateLimiter.clear("nobody", "nowhere")
    assert RateLimiter.count() == 0
  end

  test "clear_on_message clears the author's bucket for a real MESSAGE_CREATE shape" do
    user_id = "user_com_1"
    channel_id = "chan_com_1"

    assert :ok = RateLimiter.check_rate(user_id, channel_id)
    assert {:rate_limited, _} = RateLimiter.check_rate(user_id, channel_id)

    event = %{
      "type" => "MESSAGE_CREATE",
      "version" => 1,
      "guild_id" => "guild_com_1",
      "payload" => %{
        "id" => "msg-com-1",
        "channel_id" => channel_id,
        "guild_id" => "guild_com_1",
        "author" => %{"id" => user_id, "username" => "alice", "discriminator" => "0001"},
        "content" => "hello"
      }
    }

    assert :cleared = RateLimiter.clear_on_message(event)
    assert :ok = RateLimiter.check_rate(user_id, channel_id)
  end

  test "clear_on_message skips non-message events and authorless messages" do
    assert :ok = RateLimiter.check_rate("u_com_x", "c_com_x")

    assert :skipped = RateLimiter.clear_on_message(%{"type" => "TYPING_START"})
    assert :skipped = RateLimiter.clear_on_message(%{"type" => "MESSAGE_UPDATE", "payload" => %{}})

    authorless = %{
      "type" => "MESSAGE_CREATE",
      "payload" => %{"id" => "msg-com-2", "channel_id" => "c_com_x", "content" => "no author"}
    }

    assert :skipped = RateLimiter.clear_on_message(authorless)

    # Untouched bucket still rate-limits
    assert {:rate_limited, _} = RateLimiter.check_rate("u_com_x", "c_com_x")
  end

  test "clear_on_message never raises on malformed MESSAGE_CREATE shapes" do
    assert :skipped = RateLimiter.clear_on_message(%{"type" => "MESSAGE_CREATE"})
    assert :skipped = RateLimiter.clear_on_message(%{"type" => "MESSAGE_CREATE", "payload" => "junk"})
    assert :skipped = RateLimiter.clear_on_message(%{"type" => "MESSAGE_CREATE", "payload" => %{"author" => "junk"}})

    assert :skipped =
             RateLimiter.clear_on_message(%{
               "type" => "MESSAGE_CREATE",
               "payload" => %{"author" => %{}, "channel_id" => ""}
             })
  end
end

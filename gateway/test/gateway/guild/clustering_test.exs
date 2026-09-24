defmodule Gateway.Guild.ClusteringTest do
  # Phase 7c (Issue #86): cross-node duplicate suppression, lease-gated
  # dispatch, survivor re-subscribe. Single-node suite: Horde runs
  # standalone, so placement/dedup/lease logic is exercised directly;
  # true multi-node kill/SIGSTOP behavior is covered by
  # scripts/chaos/phase7_gateway.sh.
  use ExUnit.Case, async: false

  alias Gateway.Guild.Actor
  alias Gateway.Guild.Cache
  alias Gateway.Guild.Lease
  alias Gateway.Metrics

  @guild "77700000000000001"

  setup do
    case Actor.whereis(@guild) do
      pid when is_pid(pid) ->
        Horde.DynamicSupervisor.terminate_child(Gateway.GuildSupervisor, pid)

      nil ->
        :ok
    end

    :ok
  end

  describe "cross-node duplicate suppression" do
    test "same {bus_seq, type} dispatched twice fans out once" do
      {:ok, _} = Actor.get_or_spawn(@guild)
      :ok = Actor.subscribe(@guild, "sess-dedup", self(), nil)

      evt = %{"type" => "PRESENCE_UPDATE", "guild_id" => @guild, "payload" => %{}}
      :ok = Actor.dispatch_event(@guild, evt, nil, bus_seq: 4242)
      :ok = Actor.dispatch_event(@guild, evt, nil, bus_seq: 4242)

      assert_receive {:dispatch, ^evt, _}, 1_000
      refute_receive {:dispatch, _, _}, 200

      out = Metrics.render()
      assert out =~ "gateway_guild_dedup_drops_total"
    end

    test "different bus_seq values both fan out" do
      {:ok, _} = Actor.get_or_spawn(@guild)
      :ok = Actor.subscribe(@guild, "sess-dedup-2", self(), nil)

      evt = %{"type" => "PRESENCE_UPDATE", "guild_id" => @guild, "payload" => %{}}
      :ok = Actor.dispatch_event(@guild, evt, nil, bus_seq: 100)
      :ok = Actor.dispatch_event(@guild, evt, nil, bus_seq: 101)

      assert_receive {:dispatch, _, _}, 1_000
      assert_receive {:dispatch, _, _}, 1_000
    end

    test "events without bus_seq always dispatch (legacy path)" do
      {:ok, _} = Actor.get_or_spawn(@guild)
      :ok = Actor.subscribe(@guild, "sess-dedup-3", self(), nil)

      evt = %{"type" => "PRESENCE_UPDATE", "guild_id" => @guild, "payload" => %{}}
      :ok = Actor.dispatch_event(@guild, evt)
      :ok = Actor.dispatch_event(@guild, evt)

      assert_receive {:dispatch, _, _}, 1_000
      assert_receive {:dispatch, _, _}, 1_000
    end
  end

  describe "local-only bus dispatch" do
    test "dispatch_bus_event fans out when the actor is local" do
      {:ok, pid} = Actor.get_or_spawn(@guild)
      assert node(pid) == node()
      :ok = Actor.subscribe(@guild, "sess-bus-local", self(), nil)

      evt = %{"type" => "PRESENCE_UPDATE", "guild_id" => @guild, "payload" => %{}}
      assert :ok = Actor.dispatch_bus_event(@guild, evt, nil, bus_seq: 9001)
      assert_receive {:dispatch, ^evt, _}, 1_000
    end

    test "dispatch_event still fans out (remote-capable path unchanged)" do
      {:ok, _} = Actor.get_or_spawn(@guild)
      :ok = Actor.subscribe(@guild, "sess-bus-remote-path", self(), nil)

      evt = %{"type" => "PRESENCE_UPDATE", "guild_id" => @guild, "payload" => %{}}
      assert :ok = Actor.dispatch_event(@guild, evt, nil, bus_seq: 9002)
      assert_receive {:dispatch, ^evt, _}, 1_000
    end
  end

  describe "warm-on-miss" do
    test "cross-node subscribe computes visibility from a cold cache" do
      # Simulates an actor on a node that never saw IDENTIFY: ETS is empty
      # for this guild, so without warm-on-miss every channel check denies.
      gid = 777_000_000_000_00991
      uid = 777_000_000_000_00993
      cid = 777_000_000_000_00994
      rid = 777_000_000_000_00995

      if pg_up?() do
        seed_visibility_fixture(gid, uid, cid, rid)

        try do
          assert :error = Cache.get_guild(gid)
          assert :ok = Cache.ensure_member_view(uid, gid)
          assert {:ok, _} = Cache.get_guild(gid)
          assert {:ok, rids} = Cache.get_member_roles(uid, gid)
          assert to_string(rid) in Enum.map(rids, &to_string/1)
          assert Gateway.Permissions.can_view?(uid, cid, gid)
        after
          cleanup_visibility_fixture(gid, uid, cid, rid)
        end
      else
        # No Postgres here: warm must still fail gracefully, never crash.
        assert {:error, _} = Cache.ensure_member_view(uid, gid)
      end
    end
  end

  defp pg_up? do
    case Postgrex.query(Gateway.DB, "SELECT 1", []) do
      {:ok, _} -> true
      _ -> false
    end
  rescue
    _ -> false
  end

  defp seed_visibility_fixture(gid, uid, cid, rid) do
    q = fn sql, params ->
      {:ok, _} = Postgrex.query(Gateway.DB, sql, params)
    end

    q.("INSERT INTO users (id, username, discriminator, email, password_hash) VALUES ($1, 'warmtest', 1, 'warm@test.io', 'x') ON CONFLICT (id) DO NOTHING", [uid])
    q.("INSERT INTO guilds (id, name, owner_id) VALUES ($1, 'Warm Test Guild', $2) ON CONFLICT (id) DO NOTHING", [gid, uid])
    q.("INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable) VALUES ($1, $2, 'Talkers', 0, false, 1, 3072, false) ON CONFLICT (id) DO NOTHING", [rid, gid])
    q.("INSERT INTO channels (id, guild_id, type, name, position) VALUES ($1, $2, 0, 'warm-chan', 1) ON CONFLICT (id) DO NOTHING", [cid, gid])
    q.("INSERT INTO members (guild_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [gid, uid])
    q.("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [gid, uid, rid])
    :ok
  end

  defp cleanup_visibility_fixture(gid, uid, cid, rid) do
    q = fn sql, params ->
      try do
        Postgrex.query(Gateway.DB, sql, params)
      rescue
        _ -> :ok
      catch
        _, _ -> :ok
      end
    end

    q.("DELETE FROM member_roles WHERE guild_id = $1", [gid])
    q.("DELETE FROM members WHERE guild_id = $1", [gid])
    q.("DELETE FROM channels WHERE guild_id = $1", [gid])
    q.("DELETE FROM roles WHERE guild_id = $1", [gid])
    q.("DELETE FROM guilds WHERE id = $1", [gid])
    q.("DELETE FROM users WHERE id = $1", [uid])
    :ok
  end

  describe "lease round-trip" do
    test "acquire/renew/release against the lease store" do
      gid = "lease-test-#{System.unique_integer([:positive])}"

      case Lease.acquire(gid) do
        :ok ->
          assert {:error, :taken} = Lease.acquire(gid, "someone-else")
          assert :ok = Lease.renew(gid)
          assert :ok = Lease.release(gid)
          assert :ok = Lease.acquire(gid, "someone-else")
          assert :ok = Lease.release(gid, "someone-else")

        {:error, :unavailable} ->
          # No Redis in this environment; multi-node lease behavior is
          # covered by scripts/chaos/phase7_gateway.sh.
          :ok
      end
    end
  end

  describe "survivor re-subscribe" do
    test "session re-subscribes after its guild actor dies" do
      session_id = "sess-resub-#{System.unique_integer([:positive])}"
      {:ok, session_pid} =
        Gateway.Session.get_or_spawn(
          session_id: session_id,
          user_id: nil,
          guild_ids: [@guild],
          ws_pid: nil
        )

      assert Actor.subscriber_count(@guild) == 1

      {:ok, actor_pid} = Actor.get_or_spawn(@guild)
      :ok = Horde.DynamicSupervisor.terminate_child(Gateway.GuildSupervisor, actor_pid)

      # First retry fires after 500ms; allow generous time for Horde
      # restart + re-subscribe.
      assert_eventually(fn -> Actor.subscriber_count(@guild) == 1 end, 5_000)
      assert Process.alive?(session_pid)
    end
  end

  defp assert_eventually(fun, timeout_ms) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_assert_eventually(fun, deadline)
  end

  defp do_assert_eventually(fun, deadline) do
    if fun.() do
      :ok
    else
      if System.monotonic_time(:millisecond) > deadline do
        flunk("condition not met within timeout")
      else
        Process.sleep(100)
        do_assert_eventually(fun, deadline)
      end
    end
  end
end

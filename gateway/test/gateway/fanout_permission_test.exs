defmodule Gateway.FanoutPermissionTest do
  # Issue #91 end-to-end contract: the guild actor dumb-broadcasts
  # channel-scoped data events to every subscriber while each Session
  # filters locally via can_view?. Suppression, revocation, grants, and
  # resume purity are all asserted here at session level.
  use ExUnit.Case, async: false

  alias Gateway.Guild.{Actor, Cache}
  alias Gateway.{Session, Metrics, Permissions}

  setup do
    n = System.unique_integer([:positive])
    gid = "fanout_perm_#{n}"
    pub = "fanout_pub_#{n}"
    priv = "fanout_priv_#{n}"
    vip = "fanout_vip_#{n}"
    alice = "fanout_alice_#{n}"
    bob = "fanout_bob_#{n}"
    view = Permissions.view_channel()

    Cache.put_guild(%{
      "id" => gid,
      "name" => "Fanout Perm Guild",
      "owner_id" => "fanout_owner_#{n}",
      "channels" => [
        %{"id" => pub, "name" => "public"},
        %{"id" => priv, "name" => "private"}
      ]
    })

    # @everyone can view; the private channel denies @everyone but
    # re-allows the VIP role — mirrors real Discord overwrite stacking.
    Cache.put_guild_roles(gid, [
      %{"id" => gid, "name" => "@everyone", "position" => 0, "permissions" => view},
      %{"id" => vip, "name" => "VIP", "position" => 1, "permissions" => 0}
    ])

    Cache.put_channel_overwrites(pub, [])

    Cache.put_channel_overwrites(priv, [
      %{"target_id" => gid, "target_type" => 0, "allow" => 0, "deny" => view},
      %{"target_id" => vip, "target_type" => 0, "allow" => view, "deny" => 0}
    ])

    Cache.put_member_roles(alice, gid, [vip])
    Cache.put_member_roles(bob, gid, [])
    Cache.put_member_guilds(alice, [gid])
    Cache.put_member_guilds(bob, [gid])

    {:ok, _} = Actor.get_or_spawn(gid)

    on_exit(fn ->
      for sid <- ["sess-#{n}-alice", "sess-#{n}-bob", "sess-#{n}-resume"] do
        Session.close(sid)
      end
    end)

    {:ok, %{gid: gid, pub: pub, priv: priv, vip: vip, alice: alice, bob: bob, n: n, view: view}}
  end

  # Forwarder "sockets": tag send_frames back to the test process so two
  # sessions sharing one test pid stay distinguishable.
  defp spawn_ws(tag) do
    test = self()
    spawn(fn -> ws_loop(test, tag) end)
  end

  defp ws_loop(test, tag) do
    receive do
      {:send_frame, event, seq, ts} ->
        send(test, {tag, event, seq, ts})
        ws_loop(test, tag)

      {:close, code, reason} ->
        send(test, {tag, :closed, code, reason})
    end
  end

  defp spawn_session(sid, user_id, gid, ws) do
    {:ok, pid} =
      Session.get_or_spawn(session_id: sid, user_id: user_id, guild_ids: [gid], ws_pid: ws)

    # Nudge the idempotent resubscribe path: under parallel-suite load the
    # initial handle_continue subscribe can lose a Horde placement race and
    # fall back to the 1s/3s backoff, which a short poll would outrun.
    # Resubscribe is safe to repeat (subscribe + lane join + monitors idempotent).
    send(pid, {:resubscribe, to_string(gid), 0})
    wait_until(fn -> subscribed?(gid, sid) end)
    pid
  end

  defp subscribed?(gid, sid) do
    Actor.subscribers(gid)
    |> Enum.any?(fn {id, _} -> to_string(id) == to_string(sid) end)
  end

  # On timeout, dump session + actor internals before flunking so the next
  # flake carries its own diagnosis (intermittent subscribe stall).
  defp wait_subscribed_debug(gid, sid, session_pid, timeout_ms \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_wait_debug(gid, sid, session_pid, deadline)
  end

  defp do_wait_debug(gid, sid, session_pid, deadline) do
    if subscribed?(gid, sid) do
      :ok
    else
      if System.monotonic_time(:millisecond) > deadline do
        actor_pid = Actor.whereis(gid)

        session_info =
          if is_pid(session_pid) and Process.alive?(session_pid) do
            {:status, Process.info(session_pid, [:status, :current_function, :message_queue_len]),
             {:state,
              try do
                :sys.get_state(session_pid) |> Map.take([:actor_monitors, :lane_monitors, :guild_ids])
              rescue
                e -> {:get_state_failed, inspect(e)}
              catch
                :exit, r -> {:get_state_exit, inspect(r)}
              end}}
          else
            :session_dead
          end

        actor_info =
          if is_pid(actor_pid) and Process.alive?(actor_pid) do
            {:status, Process.info(actor_pid, [:status, :current_function, :message_queue_len]),
             {:subs, try_cast_subs(actor_pid)}}
          else
            :actor_missing
          end

        flunk("subscribe stall: session=#{inspect(session_pid)} #{inspect(session_info)} actor=#{inspect(actor_info)}")
      else
        Process.sleep(10)
        do_wait_debug(gid, sid, session_pid, deadline)
      end
    end
  end

  defp try_cast_subs(actor_pid) do
    try do
      GenServer.call(actor_pid, :subscribers, 500)
    rescue
      e -> {:call_failed, inspect(e)}
    catch
      :exit, r -> {:call_exit, inspect(r)}
    end
  end

  defp wait_until(fun, timeout_ms \\ 3_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_wait(fun, deadline)
  end

  defp do_wait(fun, deadline) do
    if fun.() do
      :ok
    else
      if System.monotonic_time(:millisecond) > deadline,
        do: flunk("condition did not converge in time"),
        else: (Process.sleep(10); do_wait(fun, deadline))
    end
  end

  defp message(gid, channel_id, id, content \\ "hello") do
    %{
      "type" => "MESSAGE_CREATE",
      "guild_id" => gid,
      "payload" => %{"id" => id, "channel_id" => channel_id, "content" => content}
    }
  end

  test "public delivers to both, restricted only to authorized", ctx do
    alice_ws = spawn_ws(:alice)
    bob_ws = spawn_ws(:bob)
    spawn_session("sess-#{ctx.n}-alice", ctx.alice, ctx.gid, alice_ws)
    spawn_session("sess-#{ctx.n}-bob", ctx.bob, ctx.gid, bob_ws)

    before_filtered = Metrics.get_permission_filtered()

    pub_msg = message(ctx.gid, ctx.pub, "m-pub-1")
    Actor.dispatch_event(ctx.gid, pub_msg)
    assert_receive {:alice, ^pub_msg, _seq, _}, 1000
    assert_receive {:bob, ^pub_msg, _seq, _}, 1000

    priv_msg = message(ctx.gid, ctx.priv, "m-priv-1")
    Actor.dispatch_event(ctx.gid, priv_msg)
    assert_receive {:alice, ^priv_msg, _seq, _}, 1000
    refute_receive {:bob, ^priv_msg, _, _}, 300

    # The denied frame was dropped session-side, not actor-side.
    assert Metrics.get_permission_filtered() > before_filtered
  end

  test "revoke suppresses and grant restores via the full CHANNEL_UPDATE path", ctx do
    alice_ws = spawn_ws(:alice)
    spawn_session("sess-#{ctx.n}-alice", ctx.alice, ctx.gid, alice_ws)

    msg1 = message(ctx.gid, ctx.priv, "m-revoke-1")
    Actor.dispatch_event(ctx.gid, msg1)
    assert_receive {:alice, ^msg1, _, _}, 1000

    # Revoke: deny VIEW for the VIP role on the private channel.
    Actor.dispatch_event(ctx.gid, %{
      "type" => "CHANNEL_UPDATE",
      "guild_id" => ctx.gid,
      "payload" => %{
        "id" => ctx.priv,
        "guild_id" => ctx.gid,
        "name" => "private",
        "type" => 0,
        "permission_overwrites" => [
          %{"target_id" => ctx.vip, "target_type" => 0, "allow" => 0, "deny" => ctx.view}
        ]
      }
    })

    # Revoked session still receives the synthetic CHANNEL_DELETE notice
    # (lifecycle types stay actor-gated — the notice itself must arrive).
    assert_receive {:alice, %{"type" => "CHANNEL_DELETE"}, _, _}, 1000

    msg2 = message(ctx.gid, ctx.priv, "m-revoke-2")
    Actor.dispatch_event(ctx.gid, msg2)
    refute_receive {:alice, ^msg2, _, _}, 300

    # Grant: clear overwrites back to everyone-visible.
    Actor.dispatch_event(ctx.gid, %{
      "type" => "CHANNEL_UPDATE",
      "guild_id" => ctx.gid,
      "payload" => %{
        "id" => ctx.priv,
        "guild_id" => ctx.gid,
        "name" => "private",
        "type" => 0,
        "permission_overwrites" => []
      }
    })

    assert_receive {:alice, %{"type" => "CHANNEL_CREATE"}, _, _}, 1000

    msg3 = message(ctx.gid, ctx.priv, "m-revoke-3")
    Actor.dispatch_event(ctx.gid, msg3)
    assert_receive {:alice, ^msg3, _, _}, 1000
  end

  test "resume replay contains only authorized frames (no seq consumed by drops)", ctx do
    sid = "sess-#{ctx.n}-resume"

    {:ok, resume_pid} =
      Session.get_or_spawn(session_id: sid, user_id: ctx.bob, guild_ids: [ctx.gid], ws_pid: nil)

    send(resume_pid, {:resubscribe, ctx.gid, 0})
    wait_subscribed_debug(ctx.gid, sid, resume_pid)

    pub_msg = message(ctx.gid, ctx.pub, "m-resume-pub")
    priv_msg = message(ctx.gid, ctx.priv, "m-resume-priv")
    Actor.dispatch_event(ctx.gid, pub_msg)
    Actor.dispatch_event(ctx.gid, priv_msg)

    wait_until(fn ->
      match?({:ok, %{seq: 1}}, Session.info(sid))
    end)

    # The denied frame consumed no seq: only the public frame is buffered.
    assert {:ok, %{seq: 1, replay_size: 1}} = Session.info(sid)

    new_ws = spawn_ws(:resumed)
    assert {:ok, 1, [{1, ^pub_msg}]} = Session.resume(sid, new_ws, 0, ctx.bob)
  end

  test "NATS consumer dead-letters after 3 deliveries" do
    config =
      Gateway.Bus.NatsConsumer.consumer_config("KITH_EVENTS", "kith-gateway", "kith.events.>", "kith.gateway.inbox")

    assert config.config.max_deliver == 3
    assert config.config.ack_policy == "explicit"
    assert config.config.ack_wait == 30_000_000_000
  end
end

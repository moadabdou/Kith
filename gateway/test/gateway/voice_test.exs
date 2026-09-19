defmodule Gateway.VoiceTest do
  use ExUnit.Case, async: false

  alias Gateway.Guild.Actor
  alias Gateway.Guild.Cache
  alias Gateway.Permissions
  alias Gateway.Voice.VoiceState

  @test_guild_id "88800000000000001"
  @public_voice_channel "88811111111111111"
  @secret_voice_channel "88822222222222222"
  @text_channel "88833333333333333"

  @owner_id "88899999999999999"
  @admin_user_id "88800000000000010"
  @regular_user_id "88800000000000020"
  @voice_user_id "88800000000000030"

  setup do
    # Terminate any lingering actor for test guild
    case Actor.whereis(@test_guild_id) do
      pid when is_pid(pid) ->
        DynamicSupervisor.terminate_child(Gateway.GuildSupervisor, pid)

      nil ->
        :ok
    end

    # Seed Guild Cache
    Cache.put_guild(%{
      "id" => @test_guild_id,
      "owner_id" => @owner_id,
      "name" => "Voice Test Guild"
    })

    # Public Voice Channel (type 2)
    Cache.put_channel(%{
      "id" => @public_voice_channel,
      "guild_id" => @test_guild_id,
      "type" => 2,
      "name" => "general-voice"
    })

    # Secret Voice Channel (type 2)
    Cache.put_channel(%{
      "id" => @secret_voice_channel,
      "guild_id" => @test_guild_id,
      "type" => 2,
      "name" => "secret-voice"
    })

    # Text Channel (type 0)
    Cache.put_channel(%{
      "id" => @text_channel,
      "guild_id" => @test_guild_id,
      "type" => 0,
      "name" => "general-text"
    })

    # Default @everyone role has base permissions including VIEW_CHANNEL & CONNECT
    base_perms =
      Bitwise.bor(
        Permissions.view_channel(),
        Permissions.connect()
      )

    Cache.put_guild_roles(@test_guild_id, [
      %{
        "id" => @test_guild_id,
        "guild_id" => @test_guild_id,
        "name" => "@everyone",
        "permissions" => base_perms,
        "position" => 0
      }
    ])

    # Public channel has no overwrites (inherits @everyone permissions)
    Cache.put_channel_overwrites(@public_voice_channel, [])
    Cache.put_channel_overwrites(@text_channel, [])

    # Channel overwrite on secret channel: deny VIEW_CHANNEL and CONNECT for @everyone
    Cache.put_channel_overwrites(@secret_voice_channel, [
      %{
        "id" => @test_guild_id,
        "type" => 0, # Role overwrite for @everyone
        "allow" => 0,
        "deny" => Bitwise.bor(Permissions.view_channel(), Permissions.connect())
      },
      %{
        "id" => @admin_user_id,
        "type" => 1, # Member overwrite for admin user
        "allow" => Bitwise.bor(Permissions.view_channel(), Permissions.connect()),
        "deny" => 0
      },
      %{
        "id" => @voice_user_id,
        "type" => 1, # Member overwrite for voice user to allow access
        "allow" => Bitwise.bor(Permissions.view_channel(), Permissions.connect()),
        "deny" => 0
      }
    ])

    # Ensure members are recognized in the guild cache
    Cache.put_member_roles(@admin_user_id, @test_guild_id, [])
    Cache.put_member_roles(@regular_user_id, @test_guild_id, [])
    Cache.put_member_roles(@voice_user_id, @test_guild_id, [])

    :ok
  end

  describe "VoiceState struct" do
    test "correctly builds and serializes" do
      vs =
        VoiceState.new(%{
          guild_id: @test_guild_id,
          channel_id: @public_voice_channel,
          user_id: @voice_user_id,
          session_id: "sess-v1",
          self_mute: true,
          self_deaf: false
        })

      assert vs.guild_id == @test_guild_id
      assert vs.channel_id == @public_voice_channel
      assert vs.user_id == @voice_user_id
      assert vs.session_id == "sess-v1"
      assert vs.self_mute == true
      assert vs.self_deaf == false

      map = VoiceState.to_map(vs)
      assert map["channel_id"] == @public_voice_channel
      assert map["self_mute"] == true
    end
  end

  describe "Voice state management in Guild Actor" do
    test "joining and leaving public voice channel updates state and broadcasts" do
      {:ok, _pid} = Actor.get_or_spawn(@test_guild_id)

      sub_session = "sub-sess-1"
      assert :ok == Actor.subscribe(@test_guild_id, sub_session, self(), @regular_user_id)

      voice_session = "voice-sess-1"

      # Join public voice channel
      join_params = %{
        "channel_id" => @public_voice_channel,
        "self_mute" => false,
        "self_deaf" => false
      }

      assert {:ok, vs} =
               Actor.update_voice_state(@test_guild_id, @voice_user_id, voice_session, join_params)

      assert vs.channel_id == @public_voice_channel

      # Subscriber receives broadcast
      assert_receive {:dispatch, event, _ts}, 1000
      assert event["type"] == "VOICE_STATE_UPDATE"
      assert event["payload"]["channel_id"] == @public_voice_channel
      assert event["payload"]["user_id"] == @voice_user_id

      # State is queryable
      states = Actor.get_voice_states(@test_guild_id)
      assert Map.has_key?(states, @voice_user_id)
      assert states[@voice_user_id].channel_id == @public_voice_channel

      # Leave voice channel
      leave_params = %{"channel_id" => nil}

      assert {:ok, leave_vs} =
               Actor.update_voice_state(@test_guild_id, @voice_user_id, voice_session, leave_params)

      assert leave_vs.channel_id == nil

      # Subscriber receives leave update
      assert_receive {:dispatch, leave_event, _ts}, 1000
      assert leave_event["type"] == "VOICE_STATE_UPDATE"
      assert leave_event["payload"]["channel_id"] == nil

      assert Actor.get_voice_states(@test_guild_id) == %{}
    end

    test "disconnecting session automatically cleans up voice state" do
      {:ok, _pid} = Actor.get_or_spawn(@test_guild_id)

      listener_session = "listener-sess"
      assert :ok == Actor.subscribe(@test_guild_id, listener_session, self(), @regular_user_id)

      # Separate voice session subscriber
      voice_session = "voice-sess-disconnect"
      voice_pid = spawn(fn -> Process.sleep(5000) end)
      assert :ok == Actor.subscribe(@test_guild_id, voice_session, voice_pid, @voice_user_id)

      assert {:ok, _} =
               Actor.update_voice_state(@test_guild_id, @voice_user_id, voice_session, %{
                 "channel_id" => @public_voice_channel
               })

      assert_receive {:dispatch, %{"type" => "VOICE_STATE_UPDATE", "payload" => %{"channel_id" => @public_voice_channel}}, _}, 1000

      # Voice session unregisters
      assert :ok == Actor.unsubscribe(@test_guild_id, voice_session)

      # Listener receives automatic disconnect event
      assert_receive {:dispatch, %{"type" => "VOICE_STATE_UPDATE", "payload" => %{"channel_id" => nil}}, _}, 1000

      assert Actor.get_voice_states(@test_guild_id) == %{}
    end
  end

  describe "Permission-scoped fan-out & privacy leak prevention" do
    test "joining secret channel sends event to authorized users and ZERO events to unauthorized users" do
      {:ok, _pid} = Actor.get_or_spawn(@test_guild_id)

      # Admin subscriber (Authorized)
      admin_pid = self()
      admin_session = "admin-session"
      assert :ok == Actor.subscribe(@test_guild_id, admin_session, admin_pid, @admin_user_id)

      # Regular subscriber (Unauthorized) running in separate process
      parent = self()
      reg_pid = spawn_link(fn ->
        receive do
          msg -> send(parent, {:reg_received, msg})
        after
          500 -> send(parent, :reg_timeout)
        end
      end)

      reg_session = "reg-session"
      assert :ok == Actor.subscribe(@test_guild_id, reg_session, reg_pid, @regular_user_id)

      # User joins the secret voice channel
      voice_session = "voice-sess-secret"
      join_params = %{
        "channel_id" => @secret_voice_channel,
        "self_mute" => false,
        "self_deaf" => false
      }

      assert {:ok, _} =
               Actor.update_voice_state(@test_guild_id, @voice_user_id, voice_session, join_params)

      # Admin subscriber MUST receive the event with secret channel ID
      assert_receive {:dispatch, admin_event, _ts}, 1000
      assert admin_event["type"] == "VOICE_STATE_UPDATE"
      assert admin_event["payload"]["channel_id"] == @secret_voice_channel
      assert admin_event["payload"]["user_id"] == @voice_user_id

      # Regular unauthorized subscriber MUST receive ZERO events (no information leak)
      assert_receive :reg_timeout, 1000
      refute_received {:reg_received, _}
    end

    test "transitioning from public to secret channel sends synthetic disconnect to unauthorized users" do
      {:ok, _pid} = Actor.get_or_spawn(@test_guild_id)

      admin_session = "admin-sess-2"
      assert :ok == Actor.subscribe(@test_guild_id, admin_session, self(), @admin_user_id)

      parent = self()
      reg_pid = spawn_link(fn ->
        # Expect first event (public channel join)
        receive do
          {:dispatch, %{"payload" => %{"channel_id" => @public_voice_channel}}, _} ->
            send(parent, :reg_saw_public_join)
        end

        # Expect second event (transition to secret channel -> synthetic channel_id: nil)
        receive do
          {:dispatch, %{"payload" => %{"channel_id" => nil, "user_id" => @voice_user_id}}, _} ->
            send(parent, :reg_saw_synthetic_disconnect)
        after
          1000 ->
            send(parent, :reg_transition_timeout)
        end
      end)

      reg_session = "reg-sess-2"
      assert :ok == Actor.subscribe(@test_guild_id, reg_session, reg_pid, @regular_user_id)

      voice_session = "voice-sess-transition"

      # 1. Join public channel
      assert {:ok, _} =
               Actor.update_voice_state(@test_guild_id, @voice_user_id, voice_session, %{
                 "channel_id" => @public_voice_channel
               })

      assert_receive {:dispatch, %{"payload" => %{"channel_id" => @public_voice_channel}}, _}, 1000
      assert_receive :reg_saw_public_join, 1000

      # 2. Transition to secret channel
      assert {:ok, _} =
               Actor.update_voice_state(@test_guild_id, @voice_user_id, voice_session, %{
                 "channel_id" => @secret_voice_channel
               })

      # Admin sees the real secret channel ID
      assert_receive {:dispatch, %{"payload" => %{"channel_id" => @secret_voice_channel}}, _}, 1000

      # Regular unauthorized member sees SYNTHETIC disconnect (channel_id: nil), NOT secret channel ID!
      assert_receive :reg_saw_synthetic_disconnect, 1000
    end
  end



  describe "Channel type validation & VOICE_SERVER_UPDATE dispatch" do
    test "joining text channel is rejected with {:error, :not_a_voice_channel}" do
      {:ok, _pid} = Actor.get_or_spawn(@test_guild_id)

      voice_session = "voice-sess-text-reject"
      assert :ok == Actor.subscribe(@test_guild_id, voice_session, self(), @voice_user_id)

      # Attempt to join text channel
      assert {:error, :not_a_voice_channel} ==
               Actor.update_voice_state(@test_guild_id, @voice_user_id, voice_session, %{
                 "channel_id" => @text_channel
               })

      # No state created
      assert Actor.get_voice_states(@test_guild_id) == %{}

      # No events dispatched
      refute_received {:dispatch, _, _}
    end

    test "joining voice channel dispatches VOICE_SERVER_UPDATE privately to joining session" do
      {:ok, _pid} = Actor.get_or_spawn(@test_guild_id)

      # Joining user session (self())
      voice_session = "joining-user-sess"
      assert :ok == Actor.subscribe(@test_guild_id, voice_session, self(), @voice_user_id)

      # Other guild member session
      parent = self()
      other_pid =
        spawn_link(fn ->
          receive do
            {:dispatch, %{"type" => "VOICE_SERVER_UPDATE"}, _} ->
              send(parent, :other_saw_voice_server_update)

            {:dispatch, %{"type" => "VOICE_STATE_UPDATE"} = event, _} ->
              send(parent, {:other_saw_voice_state_update, event})
          after
            500 -> send(parent, :other_done)
          end
        end)

      other_session = "other-user-sess"
      assert :ok == Actor.subscribe(@test_guild_id, other_session, other_pid, @regular_user_id)

      # Join public voice channel
      assert {:ok, _vs} =
               Actor.update_voice_state(@test_guild_id, @voice_user_id, voice_session, %{
                 "channel_id" => @public_voice_channel
               })

      # Joining user receives VOICE_STATE_UPDATE
      assert_receive {:dispatch, %{"type" => "VOICE_STATE_UPDATE", "payload" => %{"channel_id" => @public_voice_channel}}, _}, 1000

      # Joining user receives private VOICE_SERVER_UPDATE with endpoint & token
      assert_receive {:dispatch, %{"type" => "VOICE_SERVER_UPDATE", "payload" => server_payload}, _}, 1000
      assert server_payload["guild_id"] == @test_guild_id
      assert server_payload["channel_id"] == @public_voice_channel
      assert is_binary(server_payload["endpoint"]) and server_payload["endpoint"] != ""
      assert is_binary(server_payload["token"]) and server_payload["token"] != ""

      # Other user receives VOICE_STATE_UPDATE
      assert_receive {:other_saw_voice_state_update, _}, 1000

      # Other user NEVER receives VOICE_SERVER_UPDATE (it is strictly private)
      refute_received :other_saw_voice_server_update
    end

    test "initial voice state hydration filters active states by caller visibility" do
      {:ok, _pid} = Actor.get_or_spawn(@test_guild_id)

      admin_sess = "sess-admin-hydr"
      reg_sess = "sess-reg-hydr"

      assert :ok == Actor.subscribe(@test_guild_id, admin_sess, self(), @admin_user_id)
      assert :ok == Actor.subscribe(@test_guild_id, reg_sess, self(), @regular_user_id)

      # User in public channel
      assert {:ok, _} =
               Actor.update_voice_state(@test_guild_id, @regular_user_id, reg_sess, %{
                 "channel_id" => @public_voice_channel
               })

      # User in secret channel
      assert {:ok, _} =
               Actor.update_voice_state(@test_guild_id, @admin_user_id, admin_sess, %{
                 "channel_id" => @secret_voice_channel
               })

      # Admin can view both public and secret channel -> sees both voice states
      admin_visible = Actor.get_visible_voice_states(@test_guild_id, @admin_user_id)
      assert length(admin_visible) == 2
      assert Enum.any?(admin_visible, fn vs -> vs["channel_id"] == @secret_voice_channel end)
      assert Enum.any?(admin_visible, fn vs -> vs["channel_id"] == @public_voice_channel end)

      # Regular user cannot view secret channel -> sees ONLY public channel voice state
      regular_visible = Actor.get_visible_voice_states(@test_guild_id, @regular_user_id)
      assert length(regular_visible) == 1
      assert hd(regular_visible)["channel_id"] == @public_voice_channel
    end
  end
end

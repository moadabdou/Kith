defmodule Gateway.Guild.VoiceCacheTest do
  use ExUnit.Case, async: false

  alias Gateway.Guild.Actor
  alias Gateway.Guild.VoiceCache
  alias Gateway.Voice.VoiceState

  @guild "88800000000000001"
  @user "88800000000000002"
  @channel "88800000000000003"

  setup do
    case Actor.whereis(@guild) do
      pid when is_pid(pid) ->
        Horde.DynamicSupervisor.terminate_child(Gateway.GuildSupervisor, pid)

      nil ->
        :ok
    end

    VoiceCache.clear_guild(@guild)
    :ok
  end

  describe "VoiceCache operations" do
    test "put, get_guild_states, and delete lifecycle" do
      vs = %VoiceState{
        guild_id: @guild,
        channel_id: @channel,
        user_id: @user,
        session_id: "sess_voice_1",
        self_mute: false,
        self_deaf: false
      }

      assert :ok = VoiceCache.put(@guild, @user, vs)

      states = VoiceCache.get_guild_states(@guild)
      assert Map.has_key?(states, @user)
      entry = Map.get(states, @user)
      assert entry["channel_id"] == @channel
      assert entry["user_id"] == @user

      assert :ok = VoiceCache.delete(@guild, @user)
      assert VoiceCache.get_guild_states(@guild) == %{}
    end

    test "clear_guild removes all voice entries for that guild only" do
      vs1 = %VoiceState{guild_id: @guild, channel_id: @channel, user_id: "u1", session_id: "s1"}
      vs2 = %VoiceState{guild_id: @guild, channel_id: @channel, user_id: "u2", session_id: "s2"}
      other_guild = "88800000000000099"
      vs_other = %VoiceState{guild_id: other_guild, channel_id: @channel, user_id: "u3", session_id: "s3"}

      VoiceCache.put(@guild, "u1", vs1)
      VoiceCache.put(@guild, "u2", vs2)
      VoiceCache.put(other_guild, "u3", vs_other)

      assert map_size(VoiceCache.get_guild_states(@guild)) == 2
      assert map_size(VoiceCache.get_guild_states(other_guild)) == 1

      VoiceCache.clear_guild(@guild)

      assert VoiceCache.get_guild_states(@guild) == %{}
      assert map_size(VoiceCache.get_guild_states(other_guild)) == 1

      VoiceCache.clear_guild(other_guild)
    end

    test "do_put, do_delete, and do_clear_guild manipulate local ETS directly" do
      vs = %VoiceState{
        guild_id: @guild,
        channel_id: @channel,
        user_id: @user,
        session_id: "sess_voice_direct",
        self_mute: false,
        self_deaf: false
      }

      assert :ok = VoiceCache.do_put(@guild, @user, vs)
      states = VoiceCache.get_guild_states(@guild)
      assert Map.has_key?(states, @user)
      assert states[@user]["channel_id"] == @channel

      assert :ok = VoiceCache.do_delete(@guild, @user)
      assert VoiceCache.get_guild_states(@guild) == %{}

      assert :ok = VoiceCache.do_put(@guild, @user, vs)
      assert :ok = VoiceCache.do_clear_guild(@guild)
      assert VoiceCache.get_guild_states(@guild) == %{}
    end
  end
end

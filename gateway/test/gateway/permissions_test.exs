defmodule Gateway.PermissionsTest do
  use ExUnit.Case, async: true

  alias Gateway.Permissions

  defp test_vectors_path do
    [
      "/app/testvectors/permissions_vectors.json",
      "/testvectors/permissions_vectors.json",
      Path.expand("../../../testvectors/permissions_vectors.json", __DIR__),
      Path.expand("../../testvectors/permissions_vectors.json", __DIR__),
      Path.expand("testvectors/permissions_vectors.json", File.cwd!())
    ]
    |> Enum.find(&File.exists?/1)
  end

  describe "Cross-language Permission Engine - Elixir Golden Parity (#60)" do
    test "loads and verifies all 45 golden test vectors" do
      path = test_vectors_path()
      assert path != nil, "testvectors/permissions_vectors.json not found"

      vectors =
        path
        |> File.read!()
        |> Jason.decode!()

      assert length(vectors) >= 40

      Enum.each(vectors, fn tc ->
        actual =
          Permissions.resolve_channel(
            tc["guild_id"],
            tc["owner_id"],
            tc["user_id"],
            tc["roles"],
            tc["overwrites"]
          )

        expected = tc["expected"]

        assert actual == expected,
               "Vector failed: #{tc["name"]} (#{tc["description"]})\nexpected: #{expected}, got: #{actual}"
      end)
    end

    test "resolve_guild handles owner, admin, and role unions" do
      assert Permissions.resolve_guild(100, 999, 999, []) == Permissions.all_permissions()

      assert Permissions.resolve_guild(100, 999, 42, [%{"id" => 1, "permissions" => Permissions.administrator()}]) ==
               Permissions.all_permissions()

      assert Permissions.resolve_guild(100, 999, 42, [
               %{"id" => 1, "permissions" => Permissions.view_channel()},
               %{"id" => 2, "permissions" => Permissions.send_messages()}
             ]) == Bitwise.bor(Permissions.view_channel(), Permissions.send_messages())
    end

    test "can? checks permissions correctly" do
      perms = Bitwise.bor(Permissions.view_channel(), Permissions.send_messages())

      assert Permissions.can?(perms, Permissions.view_channel())
      assert Permissions.can?(perms, Permissions.send_messages())
      refute Permissions.can?(perms, Permissions.administrator())
      refute Permissions.can?(perms, Permissions.ban_members())
    end

    test "verifies 29 canonical permission constants and all_permissions" do
      constants = [
        {"create_instant_invite", Permissions.create_instant_invite(), 0},
        {"kick_members", Permissions.kick_members(), 1},
        {"ban_members", Permissions.ban_members(), 2},
        {"administrator", Permissions.administrator(), 3},
        {"manage_channels", Permissions.manage_channels(), 4},
        {"manage_guild", Permissions.manage_guild(), 5},
        {"add_reactions", Permissions.add_reactions(), 6},
        {"view_audit_log", Permissions.view_audit_log(), 7},
        {"priority_speaker", Permissions.priority_speaker(), 8},
        {"stream", Permissions.stream(), 9},
        {"view_channel", Permissions.view_channel(), 10},
        {"send_messages", Permissions.send_messages(), 11},
        {"send_tts_messages", Permissions.send_tts_messages(), 12},
        {"manage_messages", Permissions.manage_messages(), 13},
        {"embed_links", Permissions.embed_links(), 14},
        {"attach_files", Permissions.attach_files(), 15},
        {"read_message_history", Permissions.read_message_history(), 16},
        {"mention_everyone", Permissions.mention_everyone(), 17},
        {"use_external_emojis", Permissions.use_external_emojis(), 18},
        {"view_guild_insights", Permissions.view_guild_insights(), 19},
        {"connect", Permissions.connect(), 20},
        {"speak", Permissions.speak(), 21},
        {"mute_members", Permissions.mute_members(), 22},
        {"deafen_members", Permissions.deafen_members(), 23},
        {"move_members", Permissions.move_members(), 24},
        {"use_vad", Permissions.use_vad(), 25},
        {"change_nickname", Permissions.change_nickname(), 26},
        {"manage_nicknames", Permissions.manage_nicknames(), 27},
        {"manage_roles", Permissions.manage_roles(), 28}
      ]

      union =
        Enum.reduce(constants, 0, fn {name, val, shift}, acc ->
          expected_val = Bitwise.bsl(1, shift)
          assert val == expected_val, "#{name} has value #{val}, expected #{expected_val}"
          assert Bitwise.band(acc, val) == 0, "#{name} overlaps with previous bits"
          Bitwise.bor(acc, val)
        end)

      assert union == Permissions.all_permissions()
      assert Permissions.all_permissions() == Bitwise.bsl(1, 29) - 1
    end
  end

  describe "can_view?/3" do
    alias Gateway.Guild.Cache

    @guild_id "77000000000000001"
    @channel_id "77000000000000010"
    @owner_id "77000000000000099"
    @member_id "77000000000000100"
    @role_id "77000000000000200"

    setup do
      Cache.put_guild(%{
        "id" => @guild_id,
        "name" => "Perms Test Guild",
        "owner_id" => @owner_id,
        "channels" => [%{"id" => @channel_id, "name" => "secret-room"}]
      })

      Cache.put_guild_roles(@guild_id, [])
      Cache.put_member_roles(@member_id, @guild_id, [])
      Cache.put_channel_overwrites(@channel_id, [])

      :ok
    end

    test "guild owner can always view channel" do
      assert Permissions.can_view?(@owner_id, @channel_id, @guild_id)
    end

    test "non-member cannot view channel" do
      refute Permissions.can_view?("random_user_999", @channel_id, @guild_id)
    end

    test "member with @everyone VIEW_CHANNEL can view channel" do
      Cache.put_member_roles(@member_id, @guild_id, [])
      Cache.put_guild_roles(@guild_id, [
        %{"id" => @guild_id, "name" => "@everyone", "position" => 0, "permissions" => Permissions.view_channel()}
      ])

      assert Permissions.can_view?(@member_id, @channel_id, @guild_id)
    end

    test "member with role VIEW_CHANNEL can view channel even if @everyone denies it" do
      Cache.put_member_roles(@member_id, @guild_id, [@role_id])
      Cache.put_guild_roles(@guild_id, [
        %{"id" => @guild_id, "name" => "@everyone", "position" => 0, "permissions" => 0},
        %{"id" => @role_id, "name" => "VIP", "position" => 1, "permissions" => Permissions.view_channel()}
      ])

      assert Permissions.can_view?(@member_id, @channel_id, @guild_id)
    end

    test "channel overwrite denying VIEW_CHANNEL blocks member" do
      Cache.put_member_roles(@member_id, @guild_id, [@role_id])
      Cache.put_guild_roles(@guild_id, [
        %{"id" => @role_id, "name" => "VIP", "position" => 1, "permissions" => Permissions.view_channel()}
      ])
      Cache.put_channel_overwrites(@channel_id, [
        %{"target_id" => @member_id, "target_type" => 1, "allow" => 0, "deny" => Permissions.view_channel()}
      ])

      refute Permissions.can_view?(@member_id, @channel_id, @guild_id)
    end
  end
end

defmodule Gateway.Guild.CacheTest do
  use ExUnit.Case, async: false

  alias Gateway.Guild.Cache

  @guild_id "88000000000000001"
  @channel_id "88000000000000010"
  @user_id "88000000000000100"
  @role_id "88000000000000200"

  setup do
    # Clear test guild and channel data
    Cache.put_guild(%{
      "id" => @guild_id,
      "name" => "Cache Test Guild",
      "owner_id" => "999999999",
      "channels" => [%{"id" => @channel_id, "name" => "general"}]
    })

    Cache.put_guild_roles(@guild_id, [])
    Cache.put_member_roles(@user_id, @guild_id, [])
    Cache.put_channel_overwrites(@channel_id, [])

    :ok
  end

  describe "Roles and Overwrites ETS cache accessors" do
    test "put_guild_roles and get_guild_roles" do
      roles = [
        %{"id" => @role_id, "name" => "Moderator", "position" => 1, "permissions" => 1024},
        %{"id" => @guild_id, "name" => "@everyone", "position" => 0, "permissions" => 1048576}
      ]

      assert :ok == Cache.put_guild_roles(@guild_id, roles)
      assert {:ok, cached_roles} = Cache.get_guild_roles(@guild_id)
      assert length(cached_roles) == 2
      assert Enum.any?(cached_roles, &(&1["id"] == @role_id and &1["name"] == "Moderator"))
    end

    test "put_member_roles and get_member_roles" do
      assert :ok == Cache.put_member_roles(@user_id, @guild_id, [@role_id])
      assert {:ok, [@role_id]} == Cache.get_member_roles(@user_id, @guild_id)
    end

    test "put_channel_overwrites and get_channel_overwrites" do
      overwrites = [
        %{"target_id" => @role_id, "target_type" => 0, "allow" => 1024, "deny" => 0}
      ]

      assert :ok == Cache.put_channel_overwrites(@channel_id, overwrites)
      assert {:ok, cached_ow} = Cache.get_channel_overwrites(@channel_id)
      assert length(cached_ow) == 1
      assert hd(cached_ow)["target_id"] == @role_id
    end

    test "put_session_user and get_session_user" do
      session_id = "test-session-xyz"
      assert :ok == Cache.put_session_user(session_id, @user_id)
      assert {:ok, @user_id} == Cache.get_session_user(session_id)
    end
  end

  describe "handle_event/1 real-time cache mutations" do
    test "GUILD_ROLE_CREATE and GUILD_ROLE_UPDATE upsert role in cache" do
      create_event = %{
        "type" => "GUILD_ROLE_CREATE",
        "guild_id" => @guild_id,
        "payload" => %{
          "guild_id" => @guild_id,
          "role" => %{
            "id" => @role_id,
            "name" => "V1 Role",
            "position" => 2,
            "permissions" => 2048
          }
        }
      }

      assert :ok == Cache.handle_event(create_event)
      {:ok, roles} = Cache.get_guild_roles(@guild_id)
      role = Enum.find(roles, &(&1["id"] == @role_id))
      assert role["name"] == "V1 Role"
      assert role["permissions"] == 2048

      update_event = %{
        "type" => "GUILD_ROLE_UPDATE",
        "guild_id" => @guild_id,
        "payload" => %{
          "guild_id" => @guild_id,
          "role" => %{
            "id" => @role_id,
            "name" => "V2 Role Updated",
            "position" => 3,
            "permissions" => 4096
          }
        }
      }

      assert :ok == Cache.handle_event(update_event)
      {:ok, roles_after} = Cache.get_guild_roles(@guild_id)
      updated = Enum.find(roles_after, &(&1["id"] == @role_id))
      assert updated["name"] == "V2 Role Updated"
      assert updated["permissions"] == 4096
    end

    test "GUILD_ROLE_DELETE removes role from guild_roles and strips from member_roles" do
      Cache.put_guild_roles(@guild_id, [
        %{"id" => @role_id, "name" => "To Delete", "position" => 1, "permissions" => 0}
      ])
      Cache.put_member_roles(@user_id, @guild_id, [@role_id, "other_role"])

      delete_event = %{
        "type" => "GUILD_ROLE_DELETE",
        "guild_id" => @guild_id,
        "payload" => %{
          "guild_id" => @guild_id,
          "role_id" => @role_id
        }
      }

      assert :ok == Cache.handle_event(delete_event)
      {:ok, roles} = Cache.get_guild_roles(@guild_id)
      assert Enum.find(roles, &(&1["id"] == @role_id)) == nil

      {:ok, member_roles} = Cache.get_member_roles(@user_id, @guild_id)
      assert member_roles == ["other_role"]
    end

    test "GUILD_MEMBER_UPDATE updates member roles and nickname" do
      event = %{
        "type" => "GUILD_MEMBER_UPDATE",
        "guild_id" => @guild_id,
        "payload" => %{
          "guild_id" => @guild_id,
          "user" => %{"id" => @user_id},
          "roles" => [@role_id, "another_role"],
          "nick" => "NewNick"
        }
      }

      assert :ok == Cache.handle_event(event)
      assert {:ok, [@role_id, "another_role"]} == Cache.get_member_roles(@user_id, @guild_id)
      assert {:ok, "NewNick"} == Cache.get_member_nick(@user_id, @guild_id)
    end

    test "CHANNEL_UPDATE updates permission overwrites" do
      event = %{
        "type" => "CHANNEL_UPDATE",
        "guild_id" => @guild_id,
        "payload" => %{
          "channel" => %{"id" => @channel_id, "guild_id" => @guild_id},
          "permission_overwrites" => [
            %{"target_id" => @role_id, "target_type" => 0, "allow" => 1024, "deny" => 0}
          ]
        }
      }

      assert :ok == Cache.handle_event(event)
      {:ok, ows} = Cache.get_channel_overwrites(@channel_id)
      assert length(ows) == 1
      assert hd(ows)["target_id"] == @role_id
    end
  end
end

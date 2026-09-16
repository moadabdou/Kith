defmodule Gateway.Permissions do
  @moduledoc """
  Discord permission resolution engine.
  Pure bitwise algebra over uint64 bitmasks with hierarchical override resolution.
  Parity specification shared across Go, Elixir, and TypeScript.
  """

  import Bitwise

  # Canonical Discord permission bit constants (1 <<< 0 through 1 <<< 28)
  @create_instant_invite 1 <<< 0
  @kick_members 1 <<< 1
  @ban_members 1 <<< 2
  @administrator 1 <<< 3
  @manage_channels 1 <<< 4
  @manage_guild 1 <<< 5
  @add_reactions 1 <<< 6
  @view_audit_log 1 <<< 7
  @priority_speaker 1 <<< 8
  @stream 1 <<< 9
  @view_channel 1 <<< 10
  @send_messages 1 <<< 11
  @send_tts_messages 1 <<< 12
  @manage_messages 1 <<< 13
  @embed_links 1 <<< 14
  @attach_files 1 <<< 15
  @read_message_history 1 <<< 16
  @mention_everyone 1 <<< 17
  @use_external_emojis 1 <<< 18
  @view_guild_insights 1 <<< 19
  @connect 1 <<< 20
  @speak 1 <<< 21
  @mute_members 1 <<< 22
  @deafen_members 1 <<< 23
  @move_members 1 <<< 24
  @use_vad 1 <<< 25
  @change_nickname 1 <<< 26
  @manage_nicknames 1 <<< 27
  @manage_roles 1 <<< 28

  # Mask of all 29 canonical permissions (0x1FFFFFFF = 536870911)
  @all_permissions (1 <<< 29) - 1

  # Public accessors for permission constants
  def create_instant_invite, do: @create_instant_invite
  def kick_members, do: @kick_members
  def ban_members, do: @ban_members
  def administrator, do: @administrator
  def manage_channels, do: @manage_channels
  def manage_guild, do: @manage_guild
  def add_reactions, do: @add_reactions
  def view_audit_log, do: @view_audit_log
  def priority_speaker, do: @priority_speaker
  def stream, do: @stream
  def view_channel, do: @view_channel
  def send_messages, do: @send_messages
  def send_tts_messages, do: @send_tts_messages
  def manage_messages, do: @manage_messages
  def embed_links, do: @embed_links
  def attach_files, do: @attach_files
  def read_message_history, do: @read_message_history
  def mention_everyone, do: @mention_everyone
  def use_external_emojis, do: @use_external_emojis
  def view_guild_insights, do: @view_guild_insights
  def connect, do: @connect
  def speak, do: @speak
  def mute_members, do: @mute_members
  def deafen_members, do: @deafen_members
  def move_members, do: @move_members
  def use_vad, do: @use_vad
  def change_nickname, do: @change_nickname
  def manage_nicknames, do: @manage_nicknames
  def manage_roles, do: @manage_roles
  def all_permissions, do: @all_permissions

  @doc """
  Resolves base guild permissions for a member.
  If member is guild owner or has ADMINISTRATOR, returns all_permissions.
  """
  def resolve_guild(guild_id, owner_id, user_id, roles) do
    u_id = to_int(user_id)
    o_id = to_int(owner_id)

    if u_id == o_id do
      @all_permissions
    else
      base =
        Enum.reduce(roles, 0, fn role, acc ->
          perm = get_val(role, :permissions, 0) |> to_int()
          bor(acc, perm)
        end)

      if band(base, @administrator) == @administrator do
        @all_permissions
      else
        base
      end
    end
  end

  @doc """
  Resolves effective channel permissions for a member.
  Implements Discord's exact hierarchical override resolution:
  1. Owner has all_permissions.
  2. Base permissions = OR of all member roles.
  3. ADMINISTRATOR bypasses all channel overwrites (all_permissions).
  4. Channel overwrites:
     a. @everyone overwrite: (perms & ~deny) | allow
     b. Member role overwrites: union all denies, union all allows, stack without position bias
     c. Member-specific overwrite applied last
  """
  def resolve_channel(guild_id, owner_id, user_id, roles, overwrites) do
    u_id = to_int(user_id)
    o_id = to_int(owner_id)
    g_id = to_int(guild_id)

    if u_id == o_id do
      @all_permissions
    else
      base =
        Enum.reduce(roles, 0, fn role, acc ->
          perm = get_val(role, :permissions, 0) |> to_int()
          bor(acc, perm)
        end)

      if band(base, @administrator) == @administrator do
        @all_permissions
      else
        apply_channel_overwrites(base, g_id, u_id, roles, overwrites)
      end
    end
  end

  @doc """
  Alias for `resolve_channel/5`.
  """
  def resolve(guild_id, owner_id, user_id, roles, overwrites) do
    resolve_channel(guild_id, owner_id, user_id, roles, overwrites)
  end

  @doc """
  Checks whether the given permission bitmask includes the required permission(s).
  """
  def can?(perms, required_permission) do
    p = to_int(perms)
    req = to_int(required_permission)
    band(p, req) == req
  end

  # --- Internal Helpers ---

  defp base_has_admin?(roles) do
    Enum.any?(roles, fn role ->
      perm = get_val(role, :permissions, 0) |> to_int()
      band(perm, @administrator) == @administrator
    end)
  end

  defp apply_channel_overwrites(base, guild_id, user_id, roles, overwrites) do
    # 4a. Apply @everyone overwrite (target_type == 0 and target_id == guild_id)
    everyone_ow =
      Enum.find(overwrites, fn ow ->
        to_int(get_val(ow, :target_type)) == 0 and to_int(get_val(ow, :target_id)) == guild_id
      end)

    perms =
      if everyone_ow do
        deny = to_int(get_val(everyone_ow, :deny, 0))
        allow = to_int(get_val(everyone_ow, :allow, 0))
        bor(band(base, bnot(deny)), allow)
      else
        base
      end

    # 4b. Apply member role overwrites
    role_ids =
      roles
      |> Enum.map(fn role -> to_int(get_val(role, :id)) end)
      |> MapSet.new()
      |> MapSet.delete(guild_id)

    {role_deny, role_allow} =
      Enum.reduce(overwrites, {0, 0}, fn ow, {d_acc, a_acc} ->
        target_type = to_int(get_val(ow, :target_type))
        target_id = to_int(get_val(ow, :target_id))

        if target_type == 0 and target_id != guild_id and MapSet.member?(role_ids, target_id) do
          d = to_int(get_val(ow, :deny, 0))
          a = to_int(get_val(ow, :allow, 0))
          {bor(d_acc, d), bor(a_acc, a)}
        else
          {d_acc, a_acc}
        end
      end)

    perms = bor(band(perms, bnot(role_deny)), role_allow)

    # 4c. Apply member-specific overwrite (target_type == 1 and target_id == user_id)
    member_ow =
      Enum.find(overwrites, fn ow ->
        to_int(get_val(ow, :target_type)) == 1 and to_int(get_val(ow, :target_id)) == user_id
      end)

    if member_ow do
      deny = to_int(get_val(member_ow, :deny, 0))
      allow = to_int(get_val(member_ow, :allow, 0))
      bor(band(perms, bnot(deny)), allow)
    else
      perms
    end
  end

  defp to_int(nil), do: 0
  defp to_int(val) when is_integer(val), do: val
  defp to_int(val) when is_binary(val) do
    case Integer.parse(val) do
      {n, _} -> n
      :error -> 0
    end
  end
  defp to_int(_), do: 0

  defp get_val(map, key, default \\ nil) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, val} ->
        val

      :error ->
        case Map.fetch(map, Atom.to_string(key)) do
          {:ok, val} -> val
          :error -> default
        end
    end
  end
  defp get_val(_, _, default), do: default
end

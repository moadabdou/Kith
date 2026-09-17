defmodule Gateway.Voice.VoiceState do
  @moduledoc """
  Data structure representing a user's active voice connection in a guild channel.
  """

  defstruct [
    :guild_id,
    :channel_id,
    :user_id,
    :session_id,
    :self_mute,
    :self_deaf,
    :joined_at
  ]

  @type t :: %__MODULE__{
          guild_id: String.t(),
          channel_id: String.t() | nil,
          user_id: String.t(),
          session_id: String.t(),
          self_mute: boolean(),
          self_deaf: boolean(),
          joined_at: integer()
        }

  @doc """
  Constructs a new VoiceState struct from map or keyword list.
  """
  def new(attrs) do
    cid = attrs[:channel_id] || attrs["channel_id"]

    %__MODULE__{
      guild_id: to_string(attrs[:guild_id] || attrs["guild_id"]),
      channel_id: if(cid && cid != "", do: to_string(cid), else: nil),
      user_id: to_string(attrs[:user_id] || attrs["user_id"]),
      session_id: to_string(attrs[:session_id] || attrs["session_id"]),
      self_mute: attrs[:self_mute] == true or attrs["self_mute"] == true,
      self_deaf: attrs[:self_deaf] == true or attrs["self_deaf"] == true,
      joined_at: attrs[:joined_at] || attrs["joined_at"] || System.system_time(:second)
    }
  end

  @doc """
  Converts a VoiceState struct to a map suitable for JSON encoding in VOICE_STATE_UPDATE.
  """
  def to_map(%__MODULE__{} = vs) do
    %{
      "guild_id" => vs.guild_id,
      "channel_id" => vs.channel_id,
      "user_id" => vs.user_id,
      "session_id" => vs.session_id,
      "self_mute" => vs.self_mute,
      "self_deaf" => vs.self_deaf
    }
  end
end

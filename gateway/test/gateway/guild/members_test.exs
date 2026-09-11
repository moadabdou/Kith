defmodule Gateway.Guild.MembersTest do
  use ExUnit.Case, async: false

  alias Gateway.Guild.Members
  alias Gateway.Session

  @guild_id 871_000_000_000_001
  @role_id 871_000_000_000_101

  # Ordered by (joined_at, user_id) — the expected chunk stream order
  @users [
    {871_000_000_000_201, "alice", 1},
    {871_000_000_000_202, "ALan", 2},
    {871_000_000_000_203, "bob", 3},
    {871_000_000_000_204, "per%cent", 4},
    {871_000_000_000_205, "persuasive", 5}
  ]

  setup do
    # Clear lingering sessions/guild actors/presence between tests
    for {_, pid, _, _} <- DynamicSupervisor.which_children(Gateway.ConnSupervisor) do
      DynamicSupervisor.terminate_child(Gateway.ConnSupervisor, pid)
    end

    for {_, pid, _, _} <- DynamicSupervisor.which_children(Gateway.GuildSupervisor) do
      DynamicSupervisor.terminate_child(Gateway.GuildSupervisor, pid)
    end

    if :ets.whereis(:gateway_presence_store) != :undefined do
      :ets.delete_all_objects(:gateway_presence_store)
    end

    if :ets.whereis(:gateway_guild_cache) != :undefined do
      :ets.delete_all_objects(:gateway_guild_cache)
    end

    cleanup_scratch_data()
    seed_scratch_data()

    on_exit(fn -> cleanup_scratch_data() end)

    :ok
  end

  defp seed_scratch_data do
    # Users first: the guild's owner_id FK requires them
    @users
    |> Enum.with_index()
    |> Enum.each(fn {{uid, username, disc}, i} ->
      exec(
        "INSERT INTO users (id, username, discriminator, email, password_hash) VALUES ($1, $2, $3, $4, 'x') ON CONFLICT DO NOTHING",
        [uid, username, disc, "member#{i}@members.test"]
      )
    end)

    exec("INSERT INTO guilds (id, name, owner_id) VALUES ($1, 'Members Test Guild', $2)", [
      @guild_id,
      elem(Enum.at(@users, 0), 0)
    ])

    exec(
      "INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable) VALUES ($1, $2, 'TestRole', 0, true, 1, 0, true)",
      [@role_id, @guild_id]
    )

    # Staggered joined_at so ordering is unambiguous
    @users
    |> Enum.with_index()
    |> Enum.each(fn {{uid, username, _disc}, i} ->
      exec(
        "INSERT INTO members (guild_id, user_id, joined_at, nickname) VALUES ($1, $2, now() - ($3 || ' seconds')::interval, $4)",
        [@guild_id, uid, to_string(100 - i * 10), if(username == "alice", do: "Ali", else: nil)]
      )
    end)

    # alice only carries the role
    exec("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)", [
      @guild_id,
      elem(Enum.at(@users, 0), 0),
      @role_id
    ])
  end

  defp cleanup_scratch_data do
    exec("DELETE FROM member_roles WHERE guild_id = $1", [@guild_id])
    exec("DELETE FROM members WHERE guild_id = $1", [@guild_id])
    exec("DELETE FROM roles WHERE guild_id = $1", [@guild_id])
    exec("DELETE FROM guilds WHERE id = $1", [@guild_id])
    Enum.each(@users, fn {uid, _, _} -> exec("DELETE FROM users WHERE id = $1", [uid]) end)
  end

  defp exec(query, params) do
    {:ok, _} = Postgrex.query(Gateway.DB, query, params)
    :ok
  end

  defp spawn_listener(id) do
    {:ok, pid} =
      Session.get_or_spawn(session_id: id, user_id: "listener_#{id}", guild_ids: [], ws_pid: self())

    pid
  end

  defp receive_chunks(n) do
    for _ <- 1..n do
      assert_receive {:send_frame, %{"type" => "GUILD_MEMBERS_CHUNK"} = event, seq, nil}, 1000
      {event, seq}
    end
  end

  defp usernames({_event, _seq} = chunk), do: usernames(chunk |> elem(0))

  defp usernames(event) when is_map(event), do: Enum.map(event["payload"]["members"], & &1["user"]["username"])

  defp payload({_event, _seq} = chunk), do: elem(chunk, 0)["payload"]

  test "streams members in bounded chunks with monotonic seq and full member shape" do
    pid = spawn_listener("sess_members_chunked")

    assert :ok = Members.stream_to(pid, @guild_id, "", 0, false, 2)

    chunks = receive_chunks(3)

    # chunk_index advances 0..chunk_count-1, sizes 2/2/1
    assert Enum.map(chunks, &payload(&1)["chunk_index"]) == [0, 1, 2]
    assert Enum.all?(chunks, &(&1 |> payload() |> Map.get("chunk_count") == 3))
    assert Enum.map(chunks, &(length(payload(&1)["members"]))) == [2, 2, 1]

    # Envelope
    assert Enum.all?(chunks, &(&1 |> elem(0) |> Map.get("type") == "GUILD_MEMBERS_CHUNK"))
    assert Enum.all?(chunks, &(&1 |> elem(0) |> Map.get("version") == 1))
    assert Enum.all?(chunks, &(&1 |> elem(0) |> Map.get("guild_id") == to_string(@guild_id)))

    # Ordering is stable across chunks (joined_at, user_id)
    assert Enum.flat_map(chunks, &usernames/1) == ["alice", "ALan", "bob", "per%cent", "persuasive"]

    # presences key omitted entirely when the flag is unset
    assert Enum.all?(chunks, fn {event, _} -> not Map.has_key?(event["payload"], "presences") end)

    # seq strictly increasing, assigned by the session actor
    seqs = Enum.map(chunks, &elem(&1, 1))
    assert seqs == Enum.sort(seqs)
    assert length(Enum.uniq(seqs)) == 3

    # Full member shape: alice carries role + nick; bob carries neither
    alice = Enum.at(payload(Enum.at(chunks, 0))["members"], 0)
    assert alice["user"]["id"] == to_string(elem(Enum.at(@users, 0), 0))
    assert alice["user"]["discriminator"] == "0001"
    assert alice["roles"] == [to_string(@role_id)]
    assert alice["nick"] == "Ali"
    assert String.contains?(alice["joined_at"], "T")

    bob = Enum.at(payload(Enum.at(chunks, 1))["members"], 0)
    assert bob["user"]["username"] == "bob"
    assert bob["roles"] == []
    assert bob["nick"] == nil
  end

  test "prefix query is case-insensitive, LIKE-escaped, and zero matches emit a single empty chunk" do
    pid = spawn_listener("sess_members_query")

    # Case-insensitive prefix
    assert :ok = Members.stream_to(pid, @guild_id, "al", 0, false, 1000)
    assert [event] = receive_chunks(1)
    assert usernames(event) == ["alice", "ALan"]

    # % in the query is a literal, not a wildcard: "per%" matches only per%cent,
    # not persuasive (an unescaped ILIKE would match both)
    assert :ok = Members.stream_to(pid, @guild_id, "per%", 0, false, 1000)
    assert [event2] = receive_chunks(1)
    assert usernames(event2) == ["per%cent"]

    # Zero matches: definitive single empty chunk
    assert :ok = Members.stream_to(pid, @guild_id, "zzz", 0, false, 1000)
    assert [event3] = receive_chunks(1)
    p3 = payload(event3)
    assert p3["chunk_index"] == 0
    assert p3["chunk_count"] == 1
    assert p3["members"] == []
  end

  test "limit truncates the stream and 0 means all" do
    pid = spawn_listener("sess_members_limit")

    assert :ok = Members.stream_to(pid, @guild_id, "", 3, false, 2)
    chunks = receive_chunks(2)
    assert Enum.map(chunks, &(length(payload(&1)["members"]))) == [2, 1]
    assert Enum.flat_map(chunks, &usernames/1) == ["alice", "ALan", "bob"]

    assert :ok = Members.stream_to(pid, @guild_id, "", 0, false, 1000)
    assert [all] = receive_chunks(1)
    assert length(payload(all)["members"]) == 5
  end

  test "presences flag attaches a projected, non-offline-only presence snapshot" do
    {alice_id, _, _} = Enum.at(@users, 0)
    {alan_id, _, _} = Enum.at(@users, 1)
    {bob_id, _, _} = Enum.at(@users, 2)

    Gateway.Presence.Store.session_connected(alice_id, "sess_pres_alice", self(), :online, %{}, nil)

    Gateway.Presence.Store.session_connected(alan_id, "sess_pres_alan", self(), :dnd, %{"web" => "dnd"}, nil)

    Gateway.Presence.Store.update_status(alan_id, "sess_pres_alan", :dnd, [%{"name" => "Testing", "type" => 0}], false, nil)

    pid = spawn_listener("sess_members_presence")

    assert :ok = Members.stream_to(pid, @guild_id, "", 0, true, 1000)
    assert [event] = receive_chunks(1)

    presences = payload(event)["presences"]
    assert length(presences) == 2

    by_id = Map.new(presences, fn p -> {p["user"]["id"], p} end)

    alice_p = by_id[to_string(alice_id)]
    assert alice_p["status"] == "online"
    assert alice_p["activities"] == []
    assert alice_p["client_status"] == %{}

    alan_p = by_id[to_string(alan_id)]
    assert alan_p["status"] == "dnd"
    assert alan_p["activities"] == [%{"name" => "Testing", "type" => 0}]
    assert alan_p["client_status"] == %{"web" => "dnd"}

    # Internal store fields never leak onto the wire
    refute Map.has_key?(alan_p, "sessions")
    refute Map.has_key?(alan_p, "last_activity_at")
    refute Map.has_key?(alan_p, "user_id")

    # Offline members are absent (absence = offline)
    refute Map.has_key?(by_id, to_string(bob_id))
  end

  test "stream to a dead session aborts without raising" do
    pid = spawn_listener("sess_members_dead")

    ref = Process.monitor(pid)
    Session.close("sess_members_dead")
    assert_receive {:DOWN, ^ref, :process, _, _}, 1000

    assert {:error, :session_gone} = Members.stream_to(pid, @guild_id, "", 0, false, 2)
  end

  test "request/6 spawns a supervised task that streams to the session" do
    pid = spawn_listener("sess_members_request")

    assert {:ok, task_pid} = Members.request(pid, @guild_id, "", 0, false, chunk_size: 2)
    assert is_pid(task_pid)

    chunks = receive_chunks(3)
    assert Enum.map(chunks, &payload(&1)["chunk_index"]) == [0, 1, 2]
  end
end

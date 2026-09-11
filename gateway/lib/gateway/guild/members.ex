defmodule Gateway.Guild.Members do
  @moduledoc """
  DB-backed streaming member list for Opcode 8 REQUEST_GUILD_MEMBERS
  (plan/01 §3, plan/05 §1 "lazy guilds" & #37).

  On 10k–100k member guilds, embedding all members in READY explodes payload
  size and gateway memory. Discord's answer — implemented here — is windowed
  member lists: the client requests members via op 8 and the server streams
  `GUILD_MEMBERS_CHUNK` dispatches of up to `@chunk_size` members.

  Design stances:
  - **No member caching.** Guild.Cache stays metadata-only; a 10k-member list
    in per-node ETS is exactly the explosion this design avoids. Each chunk is
    a fresh keyset-paginated Postgres read (no OFFSET degradation).
  - **Chunks ride the Session dispatch path** (`send(session_pid, {:dispatch,
    event, nil})`), so they consume per-session sequence numbers, land in the
    replay ring buffer (RESUME-safe), and are subject to the existing
    slow-consumer hard cap (ws queue > 2048 → close 4008).
  - **Streaming runs in a supervised Task**, never the WS process — DB time
    must not block heartbeats. Backpressure is layered: a soft throttle here
    (pause when the session actor's queue backs up, hard 30s stream deadline)
    beneath the session's own 4008 path. At most one chunk (≤ 1,000 member
    maps) exists in any process heap at a time.
  - **Zero matches emit a single empty chunk** (`chunk_index: 0`,
    `chunk_count: 1`, `members: []`) — a definitive done-signal, matching
    Discord.
  - `limit: 0` means "all", hard-capped at `@max_limit` to bound stream size.
  """

  require Logger

  @chunk_size 1000
  @max_limit 10_000
  @throttle_queue_len 16
  @throttle_sleep_ms 50
  @stream_deadline_ms 30_000

  @count_sql """
  SELECT count(*)
  FROM members m
  JOIN users u ON u.id = m.user_id
  WHERE m.guild_id = $1
    AND u.username ILIKE $2 ESCAPE '\\'
  """

  # Keyset pagination on (joined_at, user_id) — same ordering as the REST
  # ListMembers query. Roles aggregated per member; NULL when roleless.
  @batch_sql """
  SELECT m.user_id, u.username, to_char(u.discriminator, 'FM0000'),
         m.nickname, m.joined_at,
         coalesce(array_agg(mr.role_id::text ORDER BY mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}')
  FROM members m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN member_roles mr ON mr.guild_id = m.guild_id AND mr.user_id = m.user_id
  WHERE m.guild_id = $1
    AND u.username ILIKE $2 ESCAPE '\\'
    AND ($3::timestamptz IS NULL OR (m.joined_at, m.user_id) > ($3::timestamptz, $4::bigint))
  GROUP BY m.user_id, u.username, u.discriminator, m.nickname, m.joined_at
  ORDER BY m.joined_at, m.user_id
  LIMIT $5
  """

  # ── Public API ──────────────────────────────────────────────────────────────

  @doc """
  Spawns a supervised streaming task that dispatches `GUILD_MEMBERS_CHUNK`
  events to `session_pid`. Returns `{:ok, task_pid}` or `{:error, reason}`.

  Options:
  - `:chunk_size` — members per chunk (default #{@chunk_size}); tests use small
    values to exercise multi-chunk streams.
  """
  @spec request(pid(), integer() | binary(), binary(), integer(), boolean(), keyword()) ::
          {:ok, pid()} | {:error, term()}
  def request(session_pid, guild_id, query \\ "", limit \\ 0, presences? \\ false, opts \\ []) do
    chunk_size = Keyword.get(opts, :chunk_size, @chunk_size)

    Task.Supervisor.start_child(Gateway.TaskSupervisor, fn ->
      stream_to(session_pid, guild_id, query, limit, presences?, chunk_size)
    end)
  end

  @doc """
  Synchronously counts, then streams all `GUILD_MEMBERS_CHUNK` events to
  `session_pid`. The testable core of `request/6`.

  Returns `:ok` when the full stream was delivered, `{:error, reason}` when
  aborted (session gone, deadline exceeded, or DB failure).
  """
  @spec stream_to(pid(), integer() | binary(), binary(), integer(), boolean(), pos_integer()) ::
          :ok | {:error, term()}
  def stream_to(session_pid, guild_id, query \\ "", limit \\ 0, presences? \\ false, chunk_size \\ @chunk_size) do
    with {:ok, gid} <- normalize_guild_id(guild_id),
         {:ok, prefix} <- normalize_query(query) do
      eff_limit = effective_limit(limit)
      size = normalize_chunk_size(chunk_size)
      gid_int = String.to_integer(gid)

      case count_members(gid_int, prefix) do
        {:ok, count} ->
          total = min(count, eff_limit)
          chunk_count = max(ceil_div(total, size), 1)
          deadline = System.monotonic_time(:millisecond) + @stream_deadline_ms

          stream_loop(session_pid, gid, gid_int, prefix, presences?, size, chunk_count, nil, total, 0, deadline)

        {:error, reason} ->
          Logger.error("Gateway.Guild.Members: count failed for guild #{gid}: #{inspect(reason)}")
          {:error, reason}
      end
    end
  end

  # ── Streaming Loop ──────────────────────────────────────────────────────────

  defp stream_loop(_session_pid, _gid, _gid_int, _prefix, _presences?, _size, chunk_count, _cursor, _remaining, idx, _deadline)
       when idx >= chunk_count,
       do: :ok

  defp stream_loop(session_pid, gid, gid_int, prefix, presences?, size, chunk_count, cursor, remaining, idx, deadline) do
    if System.monotonic_time(:millisecond) > deadline do
      Logger.warning(
        "Gateway.Guild.Members: stream for guild #{gid} exceeded deadline at chunk #{idx}/#{chunk_count}, aborting"
      )

      {:error, :deadline_exceeded}
    else
      batch_size = min(size, max(remaining, 0))

      case fetch_batch(gid_int, prefix, cursor, batch_size) do
        {:ok, rows} ->
          event = build_chunk_event(gid, presences?, rows, idx, chunk_count)

          Gateway.Metrics.incr_members_chunk()
          send(session_pid, {:dispatch, event, nil})

          case throttle(session_pid, deadline) do
            :ok ->
              new_cursor = cursor_from(rows) || cursor
              stream_loop(
                session_pid,
                gid,
                gid_int,
                prefix,
                presences?,
                size,
                chunk_count,
                new_cursor,
                remaining - length(rows),
                idx + 1,
                deadline
              )

            {:error, _reason} = err ->
              err
          end

        {:error, reason} = err ->
          Logger.error("Gateway.Guild.Members: batch fetch failed for guild #{gid}: #{inspect(reason)}")
          err
      end
    end
  end

  # Soft backpressure between chunks: the session actor must keep draining.
  # A dead session or a wedged one past the stream deadline aborts the stream;
  # the session's own queue-depth check (close 4008) remains the hard cap.
  defp throttle(session_pid, deadline) do
    cond do
      System.monotonic_time(:millisecond) > deadline ->
        {:error, :deadline_exceeded}

      not Process.alive?(session_pid) ->
        {:error, :session_gone}

      true ->
        case Process.info(session_pid, :message_queue_len) do
          {:message_queue_len, len} when len > @throttle_queue_len ->
            Process.sleep(@throttle_sleep_ms)
            throttle(session_pid, deadline)

          _other ->
            :ok
        end
    end
  end

  # ── Event Construction ──────────────────────────────────────────────────────

  defp build_chunk_event(gid, presences?, rows, idx, chunk_count) do
    payload = %{
      "guild_id" => gid,
      "members" => Enum.map(rows, &build_member/1),
      "chunk_index" => idx,
      "chunk_count" => chunk_count
    }

    payload = if presences?, do: Map.put(payload, "presences", build_presences(rows)), else: payload

    %{
      "type" => "GUILD_MEMBERS_CHUNK",
      "version" => 1,
      "guild_id" => gid,
      "payload" => payload
    }
  end

  defp build_member([user_id, username, discriminator, nickname, joined_at, roles]) do
    %{
      "user" => %{
        "id" => to_string(user_id),
        "username" => username,
        "discriminator" => discriminator
      },
      "roles" => roles || [],
      "nick" => nickname,
      "joined_at" => DateTime.to_iso8601(joined_at)
    }
  end

  # Presence snapshot for the chunk (Discord op 8 `presences: true` semantics):
  # only non-offline users appear — absence means offline. Internal store fields
  # (sessions, last_activity_at) must never leak onto the wire. Staleness is
  # accepted and corrected by live PRESENCE_UPDATEs already flowing to
  # subscribers — same snapshot-then-events pattern as READY.
  defp build_presences(rows) do
    rows
    |> Enum.map(fn [user_id | _] -> user_id end)
    |> Gateway.Presence.Store.get_presences()
    |> Enum.map(fn {_uid, presence} -> presence end)
    |> Enum.reject(fn presence -> to_string(presence.status) == "offline" end)
    |> Enum.map(fn presence ->
      %{
        "user" => %{"id" => to_string(presence.user_id)},
        "status" => to_string(presence.status),
        "activities" => presence.activities || [],
        "client_status" => presence.client_status || %{}
      }
    end)
    |> Enum.sort_by(& &1["user"]["id"])
  end

  # ── Database Access ─────────────────────────────────────────────────────────

  defp count_members(gid_int, prefix) do
    case Postgrex.query(Gateway.DB, @count_sql, [gid_int, like_pattern(prefix)]) do
      {:ok, %Postgrex.Result{rows: [[count]]}} -> {:ok, count}
      {:error, reason} -> {:error, reason}
    end
  end

  defp fetch_batch(gid_int, prefix, cursor, batch_size) do
    {joined_at, user_id} =
      case cursor do
        {j, u} -> {j, u}
        nil -> {nil, 0}
      end

    case Postgrex.query(Gateway.DB, @batch_sql, [gid_int, like_pattern(prefix), joined_at, user_id, batch_size]) do
      {:ok, %Postgrex.Result{rows: rows}} -> {:ok, rows}
      {:error, reason} -> {:error, reason}
    end
  end

  defp cursor_from([]), do: nil

  defp cursor_from(rows) do
    [user_id, _username, _disc, _nick, joined_at, _roles] = List.last(rows)
    {joined_at, user_id}
  end

  # ── Normalization ───────────────────────────────────────────────────────────

  defp normalize_guild_id(id) when is_integer(id), do: {:ok, to_string(id)}

  defp normalize_guild_id(id) when is_binary(id) do
    case Integer.parse(id) do
      {_int, ""} -> {:ok, id}
      _ -> {:error, :invalid_guild_id}
    end
  end

  defp normalize_guild_id(_other), do: {:error, :invalid_guild_id}

  defp normalize_query(query) when is_binary(query), do: {:ok, query}
  defp normalize_query(_other), do: {:ok, ""}

  # limit: 0 = "all" (capped at @max_limit); positive values capped likewise.
  defp effective_limit(nil), do: @max_limit
  defp effective_limit(limit) when is_integer(limit) and limit > 0, do: min(limit, @max_limit)
  defp effective_limit(_other), do: @max_limit

  defp normalize_chunk_size(size) when is_integer(size) and size > 0, do: size
  defp normalize_chunk_size(_other), do: @chunk_size

  defp like_pattern(prefix), do: escape_like(prefix) <> "%"

  defp escape_like(prefix) do
    prefix
    |> String.replace("\\", "\\\\")
    |> String.replace("%", "\\%")
    |> String.replace("_", "\\_")
  end

  defp ceil_div(num, den), do: div(num + den - 1, den)
end

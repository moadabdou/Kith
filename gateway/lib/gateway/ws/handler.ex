defmodule Gateway.WS.Handler do
  @behaviour WebSock
  require Logger

  @default_heartbeat_interval 10_000
  @default_identify_timeout 60_000
  @rate_limit_max_messages 120
  @rate_limit_window_ms 60_000

  @impl true
  def init(opts) do
    heartbeat_interval = Keyword.get(opts, :heartbeat_interval, @default_heartbeat_interval)
    identify_timeout = Keyword.get(opts, :identify_timeout, @default_identify_timeout)
    jwt_secret = Keyword.get(opts, :jwt_secret) || System.get_env("JWT_SECRET") || "dev-jwt-secret-change-me"

    Gateway.Metrics.incr_connection()

    boot_at = System.monotonic_time(:millisecond)
    identify_timer = Process.send_after(self(), :identify_timeout, identify_timeout)
    heartbeat_timer = Process.send_after(self(), :heartbeat_check, heartbeat_interval)

    hello =
      Jason.encode!(%{
        "t" => nil,
        "s" => nil,
        "op" => 10,
        "d" => %{
          "heartbeat_interval" => heartbeat_interval
        }
      })

    state = %{
      heartbeat_interval: heartbeat_interval,
      identify_timeout: identify_timeout,
      boot_at: boot_at,
      identified: false,
      identify_timer: identify_timer,
      heartbeat_timer: heartbeat_timer,
      jwt_secret: jwt_secret,
      user_id: nil,
      session_id: nil,
      session_pid: nil,
      seq: 0,
      guild_ids: [],
      last_heartbeat_at: boot_at,
      rate_count: 0,
      rate_window_start: boot_at,
      close_code: nil
    }

    {:push, [{:text, hello}], state}
  end

  @impl true
  def handle_in({payload, opcode: :text}, state) do
    {rate_ok, state} = check_rate_limit(state)

    if not rate_ok do
      Logger.warning("Gateway.WS.Handler: connection exceeded rate limit, closing with 4008")
      close(4008, "Rate limited", state)
    else
      case Jason.decode(payload) do
        {:ok, %{"op" => 1} = msg} ->
          handle_heartbeat(Map.get(msg, "d"), state)

        {:ok, %{"op" => 2, "d" => d}} ->
          handle_identify(d, state)

        {:ok, %{"op" => 3} = msg} ->
          handle_status_update(Map.get(msg, "d"), state)

        {:ok, %{"op" => 6, "d" => d}} ->
          handle_resume(d, state)

        {:ok, %{"t" => "TYPING_START"} = msg} ->
          handle_typing_start(Map.get(msg, "d"), state)

        {:ok, %{"op" => _other_op}} ->
          Logger.warning("Gateway.WS.Handler: unknown or unhandled opcode, closing with 4001")
          close(4001, "Unknown opcode", state)

        {:ok, _non_op_json} ->
          Logger.warning("Gateway.WS.Handler: JSON missing 'op' field, closing with 4000")
          close(4000, "Unknown error", state)

        {:error, _decode_error} ->
          Logger.warning("Gateway.WS.Handler: invalid JSON payload, closing with 4000")
          close(4000, "Unknown error", state)
      end
    end
  end

  def handle_in({_data, opcode: :binary}, state) do
    # Discord gateway sends JSON over text frames; unexpected binary frame is 4000
    close(4000, "Binary frames not supported", state)
  end

  @impl true
  def handle_info({:send_frame, event, seq, bus_received_at}, state) do
    if is_integer(bus_received_at) do
      latency_s = (System.monotonic_time(:microsecond) - bus_received_at) / 1_000_000.0
      Gateway.Metrics.record_fanout_latency(latency_s)
    end

    frame =
      Jason.encode!(%{
        "t" => event["type"],
        "s" => seq,
        "op" => 0,
        "d" => event["payload"] || event["data"] || event
      })

    {:push, [{:text, frame}], %{state | seq: seq}}
  end

  def handle_info({:close, code, reason}, state) do
    Logger.warning("Gateway.WS.Handler: received close instruction #{code} (#{reason})")
    close(code, reason, state)
  end

  def handle_info(:heartbeat_check, state) do
    now = System.monotonic_time(:millisecond)
    last = state.last_heartbeat_at || state.boot_at
    elapsed = now - last

    if elapsed > 2 * state.heartbeat_interval do
      Logger.warning(
        "Gateway.WS.Handler: zombie connection detected (no heartbeat for #{elapsed}ms > 2 * #{state.heartbeat_interval}ms), closing with 4009"
      )

      close(4009, "Session timed out", state)
    else
      timer = Process.send_after(self(), :heartbeat_check, state.heartbeat_interval)
      {:ok, %{state | heartbeat_timer: timer}}
    end
  end

  def handle_info(:identify_timeout, state) do
    if not state.identified do
      Logger.info("Gateway.WS.Handler: client failed to IDENTIFY within timeout, closing")
      close(4000, "Identify timeout", state)
    else
      {:ok, state}
    end
  end

  def handle_info(_other, state) do
    {:ok, state}
  end

  @impl true
  def terminate(reason, state) do
    Gateway.Metrics.decr_connection()

    if state.session_id do
      if state.close_code in [4004, 4008] do
        Gateway.Session.close(state.session_id)
      end
    end

    close_code =
      cond do
        state.close_code != nil ->
          state.close_code

        is_integer(reason) ->
          reason

        is_tuple(reason) and is_integer(elem(reason, 0)) ->
          elem(reason, 0)

        true ->
          1000
      end

    Gateway.Metrics.incr_close_code(close_code)

    if state.identify_timer && Process.read_timer(state.identify_timer) do
      Process.cancel_timer(state.identify_timer)
    end

    if state.heartbeat_timer && Process.read_timer(state.heartbeat_timer) do
      Process.cancel_timer(state.heartbeat_timer)
    end

    :ok
  end

  # ── Private Protocol Helpers ────────────────────────────────────────────────

  defp handle_heartbeat(d, state) do
    now = System.monotonic_time(:millisecond)

    if state.user_id && state.session_id do
      ts = extract_activity_timestamp(d)
      Gateway.Presence.Store.touch_activity(state.user_id, state.session_id, ts)
    end

    ack =
      Jason.encode!(%{
        "t" => nil,
        "s" => nil,
        "op" => 11,
        "d" => nil
      })

    {:push, [{:text, ack}], %{state | last_heartbeat_at: now}}
  end

  defp extract_activity_timestamp(d) when is_integer(d) and d > 1_000_000_000, do: d
  defp extract_activity_timestamp(%{"last_activity" => ts}) when is_integer(ts), do: ts
  defp extract_activity_timestamp(%{"since" => ts}) when is_integer(ts), do: ts
  defp extract_activity_timestamp(_other), do: System.system_time(:millisecond)

  defp handle_status_update(d, state) do
    cond do
      not state.identified or is_nil(state.user_id) or is_nil(state.session_id) ->
        Logger.warning("Gateway.WS.Handler: Opcode 3 received before IDENTIFY, ignoring")
        {:ok, state}

      not is_map(d) ->
        Logger.warning("Gateway.WS.Handler: Opcode 3 payload is not a map, ignoring")
        {:ok, state}

      true ->
        status = d["status"]
        allowed_statuses = ["online", "idle", "dnd", "invisible", "offline"]

        if is_binary(status) and status in allowed_statuses do
          activities = Map.get(d, "activities", [])
          afk = Map.get(d, "afk", false)
          since = Map.get(d, "since")
          Gateway.Presence.Store.update_status(state.user_id, state.session_id, status, activities, afk, since)
        else
          Logger.warning("Gateway.WS.Handler: Opcode 3 invalid status #{inspect(status)}, ignoring")
        end

        {:ok, state}
    end
  end

  defp handle_typing_start(d, state) do
    cond do
      not state.identified or is_nil(state.user_id) ->
        Logger.warning("Gateway.WS.Handler: TYPING_START received before IDENTIFY, ignoring")
        {:ok, state}

      not is_map(d) ->
        Logger.warning("Gateway.WS.Handler: TYPING_START payload is not a map, ignoring")
        {:ok, state}

      true ->
        channel_id = d["channel_id"] || d[:channel_id]

        if is_nil(channel_id) or channel_id == "" do
          Logger.warning("Gateway.WS.Handler: TYPING_START missing channel_id, ignoring")
          {:ok, state}
        else
          case Gateway.Typing.RateLimiter.check_rate(state.user_id, channel_id) do
            :ok ->
              Logger.debug("Gateway.WS.Handler: typing allowed for user #{state.user_id} in channel #{channel_id}")
              Gateway.Typing.Broadcaster.broadcast(state.user_id, channel_id)
              {:ok, state}

            {:rate_limited, retry_after_ms} ->
              Logger.debug(
                "Gateway.WS.Handler: typing rate limited for user #{state.user_id} in channel #{channel_id} (retry after #{retry_after_ms}ms), dropping frame"
              )

              # Silently drop excess requests per plan/05 §2
              {:ok, state}
          end
        end
    end
  end

  defp handle_identify(d, state) do
    if state.identify_timer do
      Process.cancel_timer(state.identify_timer)
    end

    Gateway.Metrics.incr_identify()

    token = if is_map(d), do: d["token"], else: nil

    cond do
      is_nil(token) or token == "" ->
        Logger.warning("Gateway.WS.Handler: IDENTIFY missing token, closing with 4004")
        close(4004, "Authentication failed", state)

      true ->
        case Gateway.Auth.JWT.verify(token, state.jwt_secret) do
          {:ok, user_id} ->
            session_id = :crypto.strong_rand_bytes(16) |> Base.encode16(case: :lower)

            case Gateway.Guild.Cache.warm_member(user_id) do
              {:ok, user, guilds} ->
                guild_ids = Enum.map(guilds, & &1["id"])

                # Spawn Session Actor under Gateway.ConnSupervisor
                {:ok, session_pid} =
                  Gateway.Session.get_or_spawn(
                    session_id: session_id,
                    user_id: user_id,
                    guild_ids: guild_ids,
                    ws_pid: self()
                  )

                ready =
                  Jason.encode!(%{
                    "t" => "READY",
                    "s" => 0,
                    "op" => 0,
                    "d" => %{
                      "v" => 1,
                      "user" => user,
                      "guilds" => guilds,
                      "session_id" => session_id
                    }
                  })

                new_state = %{
                  state
                  | identified: true,
                    identify_timer: nil,
                    user_id: user_id,
                    session_id: session_id,
                    session_pid: session_pid,
                    seq: 0,
                    guild_ids: guild_ids
                }

                {:push, [{:text, ready}], new_state}

              {:error, reason} ->
                Logger.error("Gateway.WS.Handler: failed to load user/guilds for #{user_id}: #{inspect(reason)}")
                close(4000, "Internal server error", state)
            end

          {:error, reason} ->
            Logger.warning("Gateway.WS.Handler: invalid JWT (#{inspect(reason)}), closing with 4004")
            close(4004, "Authentication failed", state)
        end
    end
  end

  defp handle_resume(d, state) do
    token = if is_map(d), do: d["token"], else: nil
    session_id = if is_map(d), do: d["session_id"], else: nil
    client_seq = if is_map(d), do: d["seq"], else: nil

    cond do
      is_nil(token) or token == "" ->
        Logger.warning("Gateway.WS.Handler: RESUME missing token, closing with 4004")
        close(4004, "Authentication failed", state)

      true ->
        case Gateway.Auth.JWT.verify(token, state.jwt_secret) do
          {:ok, user_id} ->
            attempt_resume(session_id, client_seq, user_id, state)

          {:error, reason} ->
            Logger.warning("Gateway.WS.Handler: RESUME invalid JWT (#{inspect(reason)}), closing with 4004")
            close(4004, "Authentication failed", state)
        end
    end
  end

  defp attempt_resume(session_id, client_seq, user_id, state) do
    cond do
      is_nil(session_id) or not is_binary(session_id) or session_id == "" or
      is_nil(client_seq) or not is_integer(client_seq) or client_seq < 0 ->
        Logger.warning("Gateway.WS.Handler: RESUME malformed session_id or seq; sending op 9")
        send_invalid_session(state)

      true ->
        case Gateway.Session.resume(session_id, self(), client_seq, user_id) do
          {:ok, current_seq, missed_events} ->
            Gateway.Metrics.incr_resume()
            Gateway.Metrics.record_resume_replay_size(length(missed_events))

            if state.identify_timer && Process.read_timer(state.identify_timer) do
              Process.cancel_timer(state.identify_timer)
            end

            replay_frames =
              Enum.map(missed_events, fn {seq, event} ->
                payload =
                  Jason.encode!(%{
                    "t" => event["type"],
                    "s" => seq,
                    "op" => 0,
                    "d" => event["payload"] || event["data"] || event
                  })

                {:text, payload}
              end)

            {:ok, info} = Gateway.Session.info(session_id)

            new_state = %{
              state
              | identified: true,
                identify_timer: nil,
                user_id: user_id,
                session_id: session_id,
                session_pid: Gateway.Session.whereis(session_id),
                seq: current_seq,
                guild_ids: info.guild_ids
            }

            Logger.info(
              "Gateway.WS.Handler: session #{session_id} resumed; replaying #{length(replay_frames)} frames (seq #{client_seq} -> #{current_seq})"
            )

            {:push, replay_frames, new_state}

          {:error, reason} ->
            Logger.warning("Gateway.WS.Handler: RESUME failed (#{inspect(reason)}); sending op 9")
            send_invalid_session(state)
        end
    end
  end

  defp send_invalid_session(state) do
    invalid_session =
      Jason.encode!(%{
        "t" => nil,
        "s" => nil,
        "op" => 9,
        "d" => false
      })

    timer =
      if state.identify_timer && Process.read_timer(state.identify_timer) do
        state.identify_timer
      else
        Process.send_after(self(), :identify_timeout, state.identify_timeout)
      end

    {:push, [{:text, invalid_session}], %{state | identify_timer: timer}}
  end

  defp close(code, reason, state) do
    {:stop, :normal, {code, reason}, %{state | close_code: code}}
  end

  defp check_rate_limit(state) do
    now = System.monotonic_time(:millisecond)

    if now - state.rate_window_start > @rate_limit_window_ms do
      {true, %{state | rate_count: 1, rate_window_start: now}}
    else
      new_count = state.rate_count + 1
      if new_count > @rate_limit_max_messages do
        {false, %{state | rate_count: new_count}}
      else
        {true, %{state | rate_count: new_count}}
      end
    end
  end
end

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

    identify_timer = Process.send_after(self(), :identify_timeout, identify_timeout)

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
      identified: false,
      identify_timer: identify_timer,
      jwt_secret: jwt_secret,
      user_id: nil,
      session_id: nil,
      seq: 0,
      guild_ids: [],
      last_heartbeat_at: nil,
      rate_count: 0,
      rate_window_start: System.monotonic_time(:millisecond),
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
        {:ok, %{"op" => 1} = _heartbeat} ->
          handle_heartbeat(state)

        {:ok, %{"op" => 2, "d" => d}} ->
          handle_identify(d, state)

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

    :ok
  end

  # ── Private Protocol Helpers ────────────────────────────────────────────────

  defp handle_heartbeat(state) do
    now = System.monotonic_time(:millisecond)

    ack =
      Jason.encode!(%{
        "t" => nil,
        "s" => nil,
        "op" => 11,
        "d" => nil
      })

    {:push, [{:text, ack}], %{state | last_heartbeat_at: now}}
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
                # Register session and guild subscriptions in Gateway.Registry
                if Process.whereis(Gateway.Registry) do
                  Registry.register(Gateway.Registry, "session:#{session_id}", %{user_id: user_id})

                  Enum.each(guilds, fn guild ->
                    Registry.register(Gateway.Registry, guild["id"], %{
                      session_id: session_id,
                      user_id: user_id
                    })
                  end)
                end

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
                    seq: 0,
                    guild_ids: Enum.map(guilds, & &1["id"])
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

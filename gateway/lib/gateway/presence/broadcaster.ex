defmodule Gateway.Presence.Broadcaster do
  @moduledoc """
  Outbound presence event originator and broadcaster (plan/05 §1 & #34).
  Translates user presence state transitions into standard `PRESENCE_UPDATE` events
  and broadcasts them across all mutual guilds where the user is a member.

  Publishes to NATS JetStream subject `kith.events.{guild_id}` (consumed by
  `Gateway.Bus.NatsConsumer`), with automatic fallback to local `Gateway.Guild.Actor`
  dispatch if NATS is offline or disconnected.
  """

  use GenServer, restart: :permanent
  require Logger

  # ── Public API ──────────────────────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Asynchronously broadcasts a `PRESENCE_UPDATE` for `user_id` across all mutual guilds.
  Non-blocking (casts to broadcaster process).
  """
  def broadcast(user_id, status, activities \\ [], client_status \\ %{}) do
    case GenServer.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        GenServer.cast(pid, {:broadcast, user_id, status, activities, client_status})

      nil ->
        # Fallback if broadcaster GenServer is not running in test env
        do_broadcast(user_id, status, activities, client_status, nil)
    end
  end

  @doc """
  Synchronously broadcasts a `PRESENCE_UPDATE` for `user_id` across all mutual guilds.
  Used in tests to guarantee event emission before asserting on subscriber state.
  """
  def broadcast_sync(user_id, status, activities \\ [], client_status \\ %{}, timeout \\ 5000) do
    case GenServer.whereis(__MODULE__) do
      pid when is_pid(pid) ->
        GenServer.call(pid, {:broadcast_sync, user_id, status, activities, client_status}, timeout)

      nil ->
        do_broadcast(user_id, status, activities, client_status, nil)
    end
  end

  # ── GenServer Callbacks ─────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    nats_url =
      Keyword.get(opts, :nats_url) ||
        System.get_env("NATS_URL") ||
        "nats://127.0.0.1:4222"

    state = %{
      gnat: nil,
      nats_url: nats_url,
      shutting_down: false
    }

    send(self(), :connect)
    {:ok, state}
  end

  @impl true
  def handle_info(:connect, %{shutting_down: true} = state) do
    {:noreply, state}
  end

  def handle_info(:connect, state) do
    uri = URI.parse(state.nats_url)
    host = uri.host || "127.0.0.1"
    port = uri.port || 4222

    conn_opts = %{
      host: host,
      port: port,
      name: "kith-gateway-publisher"
    }

    case Gnat.start_link(conn_opts) do
      {:ok, gnat} ->
        Process.monitor(gnat)
        Logger.info("Gateway.Presence.Broadcaster connected to NATS at #{state.nats_url}")
        {:noreply, %{state | gnat: gnat}}

      {:error, reason} ->
        Logger.warning(
          "Gateway.Presence.Broadcaster failed to connect to NATS at #{state.nats_url}: #{inspect(reason)}; retrying in 1s"
        )

        Process.send_after(self(), :connect, 1000)
        {:noreply, state}
    end
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, reason}, %{gnat: pid} = state) do
    Logger.warning("Gateway.Presence.Broadcaster NATS connection died: #{inspect(reason)}; reconnecting in 1s")
    Process.send_after(self(), :connect, 1000)
    {:noreply, %{state | gnat: nil}}
  end

  def handle_info(_msg, state) do
    {:noreply, state}
  end

  @impl true
  def handle_cast({:broadcast, user_id, status, activities, client_status}, state) do
    do_broadcast(user_id, status, activities, client_status, state.gnat)
    {:noreply, state}
  end

  @impl true
  def handle_call({:broadcast_sync, user_id, status, activities, client_status}, _from, state) do
    result = do_broadcast(user_id, status, activities, client_status, state.gnat)
    {:reply, result, state}
  end

  @impl true
  def terminate(_reason, state) do
    if state.gnat && Process.alive?(state.gnat) do
      Gnat.stop(state.gnat)
    end

    :ok
  end

  # ── Broadcast & Dispatch Logic ──────────────────────────────────────────────

  defp do_broadcast(user_id, status, activities, client_status, gnat) do
    case Gateway.Guild.Cache.get_member_guilds(user_id) do
      {:ok, guild_ids} when is_list(guild_ids) and guild_ids != [] ->
        Enum.each(guild_ids, fn gid ->
          event = build_presence_event(user_id, gid, status, activities, client_status)
          publish_guild_event(gid, event, gnat)
        end)

        :ok

      _other ->
        :ok
    end
  end

  defp build_presence_event(user_id, guild_id, status, activities, client_status) do
    gid_str = to_string(guild_id)
    uid_str = to_string(user_id)

    %{
      "type" => "PRESENCE_UPDATE",
      "version" => 1,
      "guild_id" => gid_str,
      "payload" => %{
        "user" => %{"id" => uid_str},
        "guild_id" => gid_str,
        "status" => to_string(status),
        "activities" => activities || [],
        "client_status" => client_status || %{}
      }
    }
  end

  defp publish_guild_event(guild_id, event, gnat) do
    subject = "kith.events.#{guild_id}"

    if gnat && Process.alive?(gnat) do
      case Gnat.pub(gnat, subject, Jason.encode!(event)) do
        :ok ->
          :ok

        {:error, reason} ->
          Logger.warning(
            "Gateway.Presence.Broadcaster NATS publish to #{subject} failed: #{inspect(reason)}; falling back to local dispatch"
          )

          Gateway.Guild.Actor.dispatch_event(guild_id, event)
      end
    else
      Gateway.Guild.Actor.dispatch_event(guild_id, event)
    end
  end
end

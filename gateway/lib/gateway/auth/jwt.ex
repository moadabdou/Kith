defmodule Gateway.Auth.JWT do
  @moduledoc """
  Stateless HS256 JWT verification and issuance matching api/internal/auth/jwt.go.
  Verifies tokens locally using Erlang :crypto without external dependencies.
  """

  @doc """
  Verifies an HS256 JWT token using the provided secret.
  Returns `{:ok, user_id}` (integer) or `{:error, reason}`.
  """
  def verify(token, secret) when is_binary(token) and is_binary(secret) do
    with [header_b64, payload_b64, sig_b64] <- String.split(token, "."),
         {:ok, header_raw} <- url_decode(header_b64),
         {:ok, header} <- Jason.decode(header_raw),
         true <- header["alg"] == "HS256",
         {:ok, sig_raw} <- url_decode(sig_b64),
         signing_input = "#{header_b64}.#{payload_b64}",
         expected_sig = :crypto.mac(:hmac, :sha256, secret, signing_input),
         true <- Plug.Crypto.secure_compare(sig_raw, expected_sig),
         {:ok, payload_raw} <- url_decode(payload_b64),
         {:ok, payload} <- Jason.decode(payload_raw),
         {:ok, user_id} <- extract_user_id(payload),
         :ok <- check_expiration(payload) do
      {:ok, user_id}
    else
      false -> {:error, :invalid_token}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_token}
    end
  end

  def verify(_, _), do: {:error, :invalid_token}

  @doc """
  Issues an HS256 JWT token for a user_id. Useful for tests and parity with the Go API.
  """
  def issue(user_id, secret, ttl_seconds \\ 3600)
      when (is_integer(user_id) or is_binary(user_id)) and is_binary(secret) do
    now = System.os_time(:second)
    sub = to_string(user_id)

    header = %{"alg" => "HS256", "typ" => "JWT"}

    payload = %{
      "sub" => sub,
      "iat" => now,
      "exp" => now + ttl_seconds
    }

    header_b64 = url_encode(Jason.encode!(header))
    payload_b64 = url_encode(Jason.encode!(payload))
    signing_input = "#{header_b64}.#{payload_b64}"
    sig = :crypto.mac(:hmac, :sha256, secret, signing_input)
    sig_b64 = url_encode(sig)

    "#{signing_input}.#{sig_b64}"
  end

  # ── Internal Helpers ────────────────────────────────────────────────────────

  defp url_encode(data) when is_binary(data) do
    Base.url_encode64(data, padding: false)
  end

  defp url_decode(encoded) when is_binary(encoded) do
    case Base.url_decode64(encoded, padding: false) do
      {:ok, decoded} -> {:ok, decoded}
      :error -> {:error, :invalid_base64}
    end
  end

  defp extract_user_id(%{"sub" => sub}) when is_binary(sub) and sub != "" do
    case Integer.parse(sub) do
      {uid, ""} -> {:ok, uid}
      _ -> {:error, :invalid_subject}
    end
  end

  defp extract_user_id(%{"sub" => sub}) when is_integer(sub), do: {:ok, sub}
  defp extract_user_id(_), do: {:error, :missing_subject}

  defp check_expiration(%{"exp" => exp}) when is_integer(exp) do
    now = System.os_time(:second)

    if exp > now do
      :ok
    else
      {:error, :expired_token}
    end
  end

  defp check_expiration(_), do: {:error, :missing_expiration}
end

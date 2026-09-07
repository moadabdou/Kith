defmodule Gateway.Auth.JWTTest do
  use ExUnit.Case, async: true

  alias Gateway.Auth.JWT

  @secret "test-jwt-secret-for-gateway"

  test "issue and verify valid HS256 token" do
    user_id = 90512733627224064
    token = JWT.issue(user_id, @secret, 3600)

    assert {:ok, ^user_id} = JWT.verify(token, @secret)
  end

  test "verifying token with wrong secret fails" do
    token = JWT.issue(12345, @secret, 3600)
    assert {:error, :invalid_token} = JWT.verify(token, "wrong-secret")
  end

  test "verifying expired token fails" do
    token = JWT.issue(12345, @secret, -10)
    assert {:error, :expired_token} = JWT.verify(token, @secret)
  end

  test "verifying tampered payload fails signature check" do
    token = JWT.issue(12345, @secret, 3600)
    [h, _p, s] = String.split(token, ".")

    tampered_payload = Base.url_encode64(Jason.encode!(%{"sub" => "99999", "exp" => System.os_time(:second) + 3600}), padding: false)
    tampered_token = "#{h}.#{tampered_payload}.#{s}"

    assert {:error, :invalid_token} = JWT.verify(tampered_token, @secret)
  end

  test "garbage token string returns error" do
    assert {:error, :invalid_token} = JWT.verify("not.a.valid.jwt", @secret)
    assert {:error, :invalid_token} = JWT.verify("", @secret)
    assert {:error, :invalid_token} = JWT.verify(nil, @secret)
  end
end

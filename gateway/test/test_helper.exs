System.put_env("PORT", "0")
Application.ensure_all_started(:gateway)
ExUnit.start()

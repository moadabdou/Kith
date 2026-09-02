FROM elixir:1.18-alpine

WORKDIR /app

RUN mix local.hex --force && mix local.rebar --force

ENV MIX_ENV=prod

COPY mix.exs mix.lock ./
RUN mix deps.get && mix deps.compile

COPY lib lib
RUN mix compile

EXPOSE 4000

CMD ["mix", "run", "--no-halt"]

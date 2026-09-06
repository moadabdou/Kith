FROM elixir:1.18-alpine AS base

WORKDIR /app

ENV MIX_REBAR3=/usr/local/bin/rebar3

COPY vendor/hex-2.5.1.tar /tmp/hex-2.5.1.tar
RUN mkdir -p /root/.mix/archives && \
    tar -xf /tmp/hex-2.5.1.tar -C /root/.mix/archives && \
    rm /tmp/hex-2.5.1.tar

FROM base AS test

ENV MIX_ENV=test

COPY mix.exs mix.lock ./
COPY deps deps
RUN mix deps.compile

COPY lib lib
COPY test test
RUN mix compile

CMD ["mix", "test"]

FROM base AS prod

ENV MIX_ENV=prod

COPY mix.exs mix.lock ./
COPY deps deps
RUN mix deps.compile

COPY lib lib
RUN mix compile

EXPOSE 4000

CMD ["mix", "run", "--no-halt"]

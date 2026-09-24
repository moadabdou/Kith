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
RUN mix deps.get
RUN mix deps.compile

COPY lib lib
COPY test test
RUN mix compile

CMD ["mix", "test"]

FROM base AS prod

ENV MIX_ENV=prod

COPY mix.exs mix.lock ./
RUN mix deps.get
RUN mix deps.compile

COPY lib lib
RUN mix compile

EXPOSE 4000

# Phase 7c (Issue #86): run distributed so libcluster/Horde can form a
# cluster. The node name MUST be gateway@<container-ip>: libcluster DNSPoll
# dials "<basename>@<resolved-ip>". Cookie shared via ERLANG_COOKIE env.
# net_ticktime 10s: node-failure detection in ~10s instead of OTP's 60s
# default — the kill/SIGSTOP drills (and any real failover) need it.
CMD ["sh", "-c", "exec elixir --name \"gateway@$(hostname -i)\" --cookie \"${ERLANG_COOKIE:-dev-cluster-cookie}\" --erl \"-kernel net_ticktime 10\" -S mix run --no-halt"]

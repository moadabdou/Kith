FROM golang:1.27-alpine AS build

WORKDIR /src

# Proxy for restricted networks
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY="localhost,127.0.0.1"
ENV http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY
ENV no_proxy=$NO_PROXY NO_PROXY=$NO_PROXY

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /bin/api ./cmd/api

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
USER app
COPY --from=build /bin/api /usr/local/bin/api
EXPOSE 8080
ENTRYPOINT ["api"]

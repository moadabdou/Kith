FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /bin/sfu ./cmd/sfu

FROM alpine:3.22
RUN apk add --no-cache iproute2 && adduser -D -u 10001 app
USER app
COPY --from=build /bin/sfu /usr/local/bin/sfu
EXPOSE 5000
EXPOSE 50000-50020/udp
ENTRYPOINT ["sfu"]

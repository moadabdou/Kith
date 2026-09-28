FROM alpine:3.22
RUN adduser -D -u 10001 app
USER app
COPY bin/api /usr/local/bin/api
EXPOSE 8080
ENTRYPOINT ["api"]

FROM alpine:3
RUN apk add --no-cache openssl
COPY init.sh /usr/local/bin/security-init
RUN chmod 0755 /usr/local/bin/security-init
ENTRYPOINT ["/usr/local/bin/security-init"]

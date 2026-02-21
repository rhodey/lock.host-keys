# base
FROM lockhost-runtime

# apks
COPY apk/repositories.serve /etc/apk/repositories
RUN apk add --no-cache tpm2-tools tpm2-tss-tcti-swtpm swtpm

# js packages
WORKDIR /app
COPY node/package.json .
COPY node/package-lock.json .
RUN npm install

# js sources
COPY node node
RUN mv node/* .
RUN chmod +x app.sh

# rust bins
COPY dist/sqlitesuperfs /bin/sqlitesuperfs
RUN chmod +x /bin/sqlitesuperfs

# nitro needs this
RUN chmod ug+w,o-rw /bin/sqlitesuperfs

# rm trash
RUN rm -rf /root/.cache
RUN rm -rf /root/nvm/.git
RUN rm -rf /root/.nvm/.cache
RUN rm -f /root/.nvm/alias/lts/*
RUN rm -rf /root/.npm
RUN rm -f /lib/apk/db/scripts.tar
RUN rm -rf /var/cache

ARG PROD=true
ENV PROD=${PROD}

# nitro needs this
RUN if [ "$PROD" = "true" ]; then \
      chmod -R ug+w,o-rw /runtime /app && \
      chmod ug+w,o-rw /etc/apk/repositories /app/app.sh && \
      find / -exec touch -t 197001010000.00 {} + || true && \
      find / -exec touch -h -t 197001010000.00 {} + || true; \
    fi

# nitro needs this
RUN cd /app

# for test attest docs
RUN if [ "$PROD" = "false" ]; then \
      bash -c /runtime/hash.sh; \
    fi

ENTRYPOINT ["/app/app.sh"]

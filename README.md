# Lock.host-keys
The [Lock.host](https://github.com/rhodey/lock.host) key servers operate as a three node [RAFT](https://en.wikipedia.org/wiki/Raft_(algorithm)) cluster and will be available to devs who deploy [WASM](https://en.wikipedia.org/wiki/WebAssembly) apps with us. Devs who want to use the key servers without deploying WASM apps will be able to do WASM registration and use the access keys. We will be doing `us-east-1`, `us-east-2`, and `us-west-2` and the APIs will be:
```
https://use1.lock.host/api/k/v1/*
https://use2.lock.host/api/k/v1/*
https://usw2.lock.host/api/k/v1/*
```

## Build app
This is how PCR hashes are checked:
```
just serve-alpine
just build-app
...
{
  "Measurements": {
    "HashAlgorithm": "Sha384 { ... }",
    "PCR0": "f7f1050667c96ce70b983f6953df7d9b72856b4cf6ff5664664656900ff80d9f7c819e7d3ada267ccda6c7fdb9cda402",
    "PCR1": "4b4d5b3661b3efc12920900c80e126e4ce783c522de6c02a2a5bf7af3a2b9327b86776f188e4be1c1c404a129dbda493",
    "PCR2": "ccc277d1274e343ba35dc6360d2038adfc69134b4aeaa59870080b90ef0098aa5c029c4f6142333092473e175e2b4ca4"
  }
}
```

See that [run.yml](.github/workflows/run.yml) is testing that PCRs in this readme match the build

## Test
+ In test containers emulate TEEs
+ Two fifos /tmp/read and /tmp/write emulate a vsock
```
just serve-alpine
just build-test-app build-test-khost
just make-test-fifos
cp example.yml config.yml
cp example.env .env
docker compose up -d
sleep 10 && just do-test khost1
```

## Prod
+ In prod all I/O passes through /dev/vsock
```
just serve-alpine
just build-app build-khost
(upload config.yml to prod bucket)
cp example.env .env
just run-app
just run-khost
```

## Apks
Modify apk/Dockerfile.fetch to include all apks then run:
```
just proxy-alpine
just fetch-alpine
```

## License
hello@lock.host

MIT

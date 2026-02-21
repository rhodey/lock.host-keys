sudo := "$(docker info > /dev/null 2>&1 || echo 'sudo')"
certs := "$(cat cert.key > /dev/null 2>&1 && echo '-v ./cert.key:/runtime/cert.key -v ./cert.crt:/runtime/cert.crt')"

#########################
## Reproducible builds ##
#########################

serve-alpine:
    python3 -m http.server -d apk/ 8082

build-rust:
    {{sudo}} docker buildx build --platform="linux/amd64" -f Dockerfile.rust -t lockhost-keys-rust .
    {{sudo}} docker rm -f lockhost-keys-rust > /dev/null  2>&1 || true
    {{sudo}} docker run --platform="linux/amd64" --name lockhost-keys-rust lockhost-keys-rust
    mkdir -p dist
    {{sudo}} docker cp lockhost-keys-rust:/workspace/rust/target/x86_64-unknown-linux-musl/release/sqlitesuperfs ./dist/
    {{sudo}} docker rm -f lockhost-keys-rust > /dev/null  2>&1 || true

build-app:
    just build-rust
    {{sudo}} docker buildx build --platform="linux/amd64" -f Dockerfile.nitro -t lockhost-keys-build-app .
    {{sudo}} docker rm -f lockhost-keys-build-app > /dev/null  2>&1 || true
    {{sudo}} docker run --platform="linux/amd64" --name lockhost-keys-build-app -v /var/run/docker.sock:/var/run/docker.sock lockhost-keys-build-app
    mkdir -p dist
    {{sudo}} docker cp lockhost-keys-build-app:/workspace/app.eif ./dist/ || true
    {{sudo}} docker cp lockhost-keys-build-app:/workspace/app.pcr ./dist/ || true
    {{sudo}} docker rm -f lockhost-keys-build-app > /dev/null  2>&1 || true

build-app-vm:
    sudo multipass delete --purge myvm > /dev/null  2>&1 || true
    sudo snap install multipass
    sudo snap restart multipass.multipassd
    sleep 5
    sudo multipass find --force-update
    sudo multipass launch 24.04 --name myvm --cpus 2 --memory 4G --disk 32G
    sudo multipass stop myvm
    sudo multipass mount -t native ../lock.host myvm:/home/ubuntu/base
    sudo multipass mount -t native ./ myvm:/home/ubuntu/app
    sudo multipass start myvm
    sudo multipass exec myvm -- sudo apt install -y just
    sudo multipass exec myvm -- bash -c "curl -fsSL https://get.docker.com -o /tmp/docker.sh"
    sudo multipass exec myvm -- VERSION=28.3.3 sh /tmp/docker.sh
    sudo multipass exec myvm -- bash -c "cp -r ~/base ~/basee"
    sudo multipass exec myvm -- bash -c "cp -r ~/app ~/appp"
    sudo multipass exec myvm -- bash -c "cd ~/basee && just serve-alpine" &
    sudo multipass exec myvm -- bash -c "cd ~/basee && just build-runtime"
    sudo multipass exec myvm -- bash -c "cd ~/appp && just serve-alpine" &
    sudo multipass exec myvm -- bash -c "cd ~/appp && just build-app"
    mkdir -p dist
    sudo multipass exec myvm -- sudo cp /home/ubuntu/appp/dist/app.pcr /home/ubuntu/app/dist/
    sudo multipass exec myvm -- sudo chmod 666 /home/ubuntu/app/dist/app.pcr
    sudo multipass delete --purge myvm


#############
## Testing ##
#############

make-test-net:
    {{sudo}} docker network create locknet --driver bridge --subnet 172.77.0.0/16 --gateway 172.77.0.1 > /dev/null 2>&1 || true

make-test-fifos:
    mkfifo /tmp/read1 /tmp/read2 /tmp/read3 > /dev/null 2>&1 || true
    mkfifo /tmp/write1 /tmp/write2 /tmp/write3 > /dev/null 2>&1 || true

build-test-app:
    just build-rust
    just make-test-net
    just make-test-fifos
    {{sudo}} docker buildx build --platform="linux/amd64" --build-arg PROD=false -f Dockerfile.app -t lockhost-keys-test-app .

write-test-hash:
    {{sudo}} docker rm -f lockhost-keys-test-hash > /dev/null  2>&1 || true
    {{sudo}} docker run --platform="linux/amd64" --name lockhost-keys-test-hash lockhost-keys-test-app > /dev/null  2>&1 || true
    mkdir -p dist
    {{sudo}} docker cp lockhost-keys-test-hash:/hash.txt ./dist/temp.txt
    {{sudo}} chmod 766 ./dist/temp.txt
    echo -n "0000000000000000000000000000000000000000000000000000000000000000" >> dist/temp.txt
    echo -n "0000000000000000000000000000000000000000000000000000000000000000" >> dist/temp.txt
    sha256sum dist/temp.txt | awk '{ printf $1 }' > dist/hash.txt && rm dist/temp.txt

write-test-csv target:
    echo -n "{{target}},https://{{target}}:8880/api/k/v1," >> dist/test.csv
    cat dist/hash.txt >> dist/test.csv
    echo ",db8a64406ce84fe268080d7b34db1c975eeac2ff444990a1f527305fb0602eb2" >> dist/test.csv

build-test-khost:
    just write-test-hash
    rm -f dist/test.csv > /dev/null 2>&1 || true
    just write-test-csv khost1
    just write-test-csv khost2
    just write-test-csv khost3
    {{sudo}} docker buildx build --platform="linux/amd64" --build-arg PROD=false --build-arg APP_PCR=$(cat dist/hash.txt) -f Dockerfile.host -t lockhost-keys-test-khost .

drop-schema schema:
    PGPASSWORD='psql' psql -h localhost -U psql -d psql -c "drop schema if exists {{schema}} cascade;"

drop-db:
    {{sudo}} docker compose up -d psql && sleep 2
    just drop-schema lhks_172_77_0_11
    just drop-schema lhks_172_77_0_12
    just drop-schema lhks_172_77_0_13

reset:
    just drop-db
    {{sudo}} rm -rf /tmp/swtpm* > /dev/null 2>&1 || true


##########################
## Testing Key Creation ##
##########################

admin_key := "FzMPqegfoMcJm7csOKQxzu0P0XYLMIhVC0xDrbVvhlSqxsgX2g0yz7vf3TOO8mpVG8Ck7oYB3xAycScSP8SJzA=="
dev_key := "BYZmO9MAQCVyJZmkTBGJ9bYeeGuR1yp2wNt7x4hYlQf+zvAT2dcwA3XjT52qcCqqneO98LiBPJQopAfwO3OkWA=="
dev_key_pub := "/s7wE9nXMAN140+dqnAqqp3jvfC4gTyUKKQH8DtzpFg="

create_org := "--create-org test1 --org-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --dev-id bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --dev-email dev1@dev1"
create_app := "--create-app testapp1 --org-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --dev-id bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
create_app_version := "--create-app-version testapp1v1 --org-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --dev-id bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

app_id := "$(cat dist/test.json | jq | grep id | sed -n '3p' | cut -c 10- | cut -c -32)"
app_version_id := "$(cat dist/test.json | jq | grep id | sed -n '5p' | cut -c 10- | cut -c -32)"
attest_secret := "$(cat dist/test.json | jq | grep attest_secret | cut -c 23- | cut -c -64)"
random_key := "ZAcGJfn+I0fcKGO+O09wZBkbTktPbVNynC7nVwAYUaQ="

create-test-app target:
    rm -f dist/test.json > /dev/null 2>&1 || true
    {{sudo}} docker run --rm -i --network locknet -v ./dist/test.csv:/runtime/target.csv -e ADMIN_KEY={{admin_key}} --entrypoint /app/helper-key-server.sh lockhost-keys-test-app {{create_org}} --target {{target}} --dev-key-pub {{dev_key_pub}} > dist/test.json
    {{sudo}} docker run --rm -i --network locknet -v ./dist/test.csv:/runtime/target.csv -e DEV_KEY={{dev_key}} --entrypoint /app/helper-key-server.sh lockhost-keys-test-app {{create_app}} --target {{target}} >> dist/test.json
    {{sudo}} docker run --rm -i --network locknet -v ./dist/test.csv:/runtime/target.csv -e DEV_KEY={{dev_key}} --entrypoint /app/helper-key-server.sh lockhost-keys-test-app {{create_app_version}} --target {{target}} --app-id {{app_id}} --version-pcr $(cat dist/hash.txt) >> dist/test.json

get-test-key target:
    {{sudo}} docker run --rm -i --network locknet -v ./dist/test.csv:/runtime/target.csv -e ATTEST_SECRET={{attest_secret}} --entrypoint /runtime/attest-key-server.sh lockhost-keys-test-app --get-app-key testkey1 --target {{target}} --app-id {{app_id}}

gen-test-key target:
    {{sudo}} docker run --rm -i --network locknet -v ./dist/test.csv:/runtime/target.csv -e ATTEST_SECRET={{attest_secret}} --entrypoint /runtime/attest-key-server.sh lockhost-keys-test-app --gen-app-key testkey1 --target {{target}} --app-id {{app_id}}

set-test-key target:
    {{sudo}} docker run --rm -i --network locknet -v ./dist/test.csv:/runtime/target.csv -e ATTEST_SECRET={{attest_secret}} --entrypoint /runtime/attest-key-server.sh lockhost-keys-test-app --set-app-key testkey1 --key {{random_key}} --replace --target {{target}} --app-id {{app_id}}

do-test target:
    {{sudo}} docker run --rm -i --network locknet -v ./dist/test.csv:/runtime/target.csv -v ./node/test.js:/app/test.js -e ADMIN_KEY={{admin_key}} -e HASH=$(cat dist/hash.txt) -e TARGET={{target}} --entrypoint /app/test.sh lockhost-keys-test-app


#########################
## Allow update alpine ##
#########################

proxy-alpine:
    cd ../lock.host && just build-proxy-alpine
    {{sudo}} docker run --rm -it -v ./apk:/root/apk -p 8080:8080 lockhost-proxy-alpine

fetch-alpine:
    {{sudo}} docker buildx build --platform="linux/amd64" -f apk/Dockerfile.fetch -t lockhost-fetch-alpine .


##########
## Prod ##
##########

build-khost:
    {{sudo}} docker buildx build --platform="linux/amd64" -f Dockerfile.host -t lockhost-keys-khost .

run-khost:
    sudo docker run --rm -it --privileged --name lockhost-khost -v /dev/vsock:/dev/vsock -p 8870:8870 -p 8872:8872 -p 8874:8874 -p 8880:8880 -p 8882:8882 --env-file .env -e PROD=true lockhost-khost

run-app:
    sudo nitro-cli run-enclave --cpu-count 2 --memory 4096 --enclave-cid 16 --eif-path dist/app.eif

run-app-debug:
    sudo nitro-cli run-enclave --cpu-count 2 --memory 4096 --enclave-cid 16 --eif-path dist/app.eif --debug-mode

atsocat listen target:
    {{sudo}} docker run --rm -it --entrypoint /runtime/atsocat.sh -p {{listen}}:{{listen}} lockhost-host {{listen}} {{target}}

nitro:
    sudo nitro-cli describe-enclaves

eid := "$(just nitro | jq -r '.[0].EnclaveID')"

nitro-logs:
    sudo nitro-cli console --enclave-id {{eid}}

nitro-rm:
    sudo nitro-cli terminate-enclave --enclave-id {{eid}}
